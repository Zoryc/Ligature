import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import * as Y from 'yjs'
import { openDb, type DB } from '../src/db/index.ts'
import { DocStore, LOAD_ORIGIN, TEXT_KEY } from '../src/collab/docStore.ts'

const NAME = 'proj/85043672-fc4b-4a10-81fd-34afaeb30e00/file/e4efee72-09bf-4ff6-b4d5-737872cee5af/g1'

/** A live doc wired to the store exactly like collab.ts does it. */
function liveDoc(store: DocStore, name = NAME) {
  const doc = new Y.Doc({ gc: true })
  store.load(name, doc)
  doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== LOAD_ORIGIN) store.append(name, u, null) })
  return doc
}

const text = (d: Y.Doc) => d.getText(TEXT_KEY).toString()
const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('DocStore', () => {
  it('seed -> load gives the seeded text', () => {
    const store = new DocStore(openDb(':memory:'))
    store.seed(NAME, 'hello')
    const d = liveDoc(store)
    expect(text(d)).toBe('hello')
  })

  it('logs updates and replays them after a "crash" (store dropped without compaction)', () => {
    const db = openDb(':memory:')
    const s1 = new DocStore(db)
    s1.seed(NAME, '')
    const d = liveDoc(s1)
    d.getText(TEXT_KEY).insert(0, 'abc')
    d.getText(TEXT_KEY).insert(3, 'def')
    s1.flush() // what the 200 ms timer does
    expect(count(db, 'doc_updates')).toBe(2)

    const s2 = new DocStore(db) // new process
    const d2 = new Y.Doc()
    s2.load(NAME, d2)
    expect(text(d2)).toBe('abcdef')
  })

  it('compaction folds the log into the snapshot and keeps the text mirror current', () => {
    const db = openDb(':memory:')
    const store = new DocStore(db)
    store.seed(NAME, 'x')
    const d = liveDoc(store)
    d.getText(TEXT_KEY).insert(1, 'yz')
    store.compact(NAME, d)
    expect(count(db, 'doc_updates')).toBe(0)
    expect(store.storedText(NAME)?.text).toBe('xyz')
    // Further edits after compaction continue the sequence and replay on top of the snapshot.
    d.getText(TEXT_KEY).insert(0, '>')
    store.flush()
    const d2 = new Y.Doc()
    new DocStore(db).load(NAME, d2)
    expect(text(d2)).toBe('>xyz')
  })

  it('recoverAll compacts leftover logs so closed-doc compiles see the latest text', () => {
    const db = openDb(':memory:')
    const s1 = new DocStore(db)
    s1.seed(NAME, '')
    const d = liveDoc(s1)
    d.getText(TEXT_KEY).insert(0, 'after crash')
    s1.flush()
    const s2 = new DocStore(db)
    expect(s2.recoverAll()).toBe(1)
    expect(s2.storedText(NAME)?.text).toBe('after crash')
    expect(count(db, 'doc_updates')).toBe(0)
  })

  it('unflushed updates are lost on crash (documented 200 ms window; clients re-send them)', () => {
    const db = openDb(':memory:')
    const s1 = new DocStore(db)
    s1.seed(NAME, 'base')
    const d = liveDoc(s1)
    d.getText(TEXT_KEY).insert(4, '!')
    s1.abandonForTest() // simulate kill -9 inside the batching window
    const d2 = new Y.Doc()
    new DocStore(db).load(NAME, d2)
    expect(text(d2)).toBe('base')
    // A client that still holds the update re-sends it via state-vector sync and the doc converges:
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d, Y.encodeStateVector(d2)))
    expect(text(d2)).toBe('base!')
  })

  it('survives a real file-backed reopen', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ligature-ds-')), 'app.db')
    const db1 = openDb(file)
    const s1 = new DocStore(db1)
    s1.seed(NAME, '')
    const d = liveDoc(s1)
    d.getText(TEXT_KEY).insert(0, 'durable')
    s1.flush()
    db1.close()
    const d2 = new Y.Doc()
    new DocStore(openDb(file)).load(NAME, d2)
    expect(text(d2)).toBe('durable')
  })

  /**
   * Property: for any sequence of edits, flushes, compactions and crashes (store dropped, doc reloaded from DB),
   * the text reloaded from the DB equals the text of the live doc as of its last flush or compaction.
   */
  it('property: reload after any interleaving of edits, flushes, compactions and crashes matches the last durable text', () => {
    type Op =
      | { t: 'insert'; pos: number; s: string }
      | { t: 'delete'; pos: number; len: number }
      | { t: 'flush' } | { t: 'compact' } | { t: 'crash' }
    const op: fc.Arbitrary<Op> = fc.oneof(
      { weight: 6, arbitrary: fc.record({ t: fc.constant('insert' as const), pos: fc.nat(), s: fc.string({ minLength: 1, maxLength: 5 }) }) },
      { weight: 3, arbitrary: fc.record({ t: fc.constant('delete' as const), pos: fc.nat(), len: fc.integer({ min: 1, max: 4 }) }) },
      { weight: 2, arbitrary: fc.constant({ t: 'flush' as const }) },
      { weight: 1, arbitrary: fc.constant({ t: 'compact' as const }) },
      { weight: 1, arbitrary: fc.constant({ t: 'crash' as const }) },
    )
    fc.assert(fc.property(fc.string({ maxLength: 20 }), fc.array(op, { maxLength: 60 }), (seed, ops) => {
      const db = openDb(':memory:')
      let store = new DocStore(db)
      store.seed(NAME, seed)
      let doc = liveDoc(store)
      let durable = seed
      for (const o of ops) {
        const t = doc.getText(TEXT_KEY)
        if (o.t === 'insert') t.insert(o.pos % (t.length + 1), o.s)
        else if (o.t === 'delete' && t.length > 0) { const p = o.pos % t.length; t.delete(p, Math.min(o.len, t.length - p)) }
        else if (o.t === 'flush') { store.flush(); durable = text(doc) }
        else if (o.t === 'compact') { store.compact(NAME, doc); durable = text(doc) }
        else if (o.t === 'crash') {
          doc.destroy()
          store.abandonForTest()
          store = new DocStore(db)
          doc = liveDoc(store)
          expect(text(doc)).toBe(durable)
        }
      }
      store.flush()
      const check = new Y.Doc()
      new DocStore(db).load(NAME, check)
      expect(text(check)).toBe(text(doc))
      store.abandonForTest()
      db.close()
    }), { numRuns: 300 })
  })
})
