import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BehindTracker } from '../src/lib/behind.ts'

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const text = (d: Y.Doc) => d.getText('content')

/** A "server" doc with content, and a "client" doc synced from it. */
function pair(content = 'hello world') {
  const server = new Y.Doc()
  text(server).insert(0, content)
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
  return { server, client }
}

/** Send everything the client has that the server lacks (and vice versa). */
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

const svOf = (d: Y.Doc) => b64(Y.encodeStateVector(d))
const snapOf = (d: Y.Doc) => b64(Y.encodeSnapshot(Y.snapshot(d)))

describe('BehindTracker with state vectors only (current server)', () => {
  it('is false right after the build, true after typing', () => {
    const { server, client } = pair()
    const t = new BehindTracker({ docs: { f: svOf(server) } })
    expect(t.check('f', client)).toBe(false)
    text(client).insert(0, 'x')
    expect(t.check('f', client)).toBe(true)
  })

  it('notices deletion-only edits (review finding 2)', () => {
    const { server, client } = pair()
    const t = new BehindTracker({ docs: { f: svOf(server) } })
    expect(t.check('f', client)).toBe(false) // our compile result arrives
    const before = Y.encodeStateVector(client)
    text(client).delete(5, 6) // Backspace only
    expect(Y.encodeStateVector(client)).toEqual(before) // the state vector really does not move
    expect(t.check('f', client)).toBe(true)
  })

  it('waits until the client has caught up with the build before taking the delete set', () => {
    const { server, client } = pair()
    text(server).insert(0, 'abc') // in the build, not yet received by the client
    const t = new BehindTracker({ docs: { f: svOf(server) } })
    expect(t.check('f', client)).toBe(false)
    sync(server, client)
    expect(t.check('f', client)).toBe(false)
    text(client).delete(0, 1)
    expect(t.check('f', client)).toBe(true)
  })

  it('stays ahead once ahead', () => {
    const { server, client } = pair()
    const t = new BehindTracker({ docs: { f: svOf(server) } })
    text(client).insert(0, 'x')
    expect(t.check('f', client)).toBe(true)
    expect(t.check('f', client)).toBe(true)
  })

  it('returns null for garbage', () => {
    const { client } = pair()
    expect(new BehindTracker({ docs: { f: '@@not base64@@' } }).check('f', client)).toBeNull()
  })
})

describe('BehindTracker with full snapshots (docSnapshots)', () => {
  it('compares delete sets against the build', () => {
    const { server, client } = pair()
    text(server).delete(0, 1) // deletion included in the build
    const t = new BehindTracker({ docs: { f: svOf(server) }, docSnapshots: { f: snapOf(server) } })
    sync(server, client)
    expect(t.check('f', client)).toBe(false)
    text(client).delete(0, 1)
    expect(t.check('f', client)).toBe(true)
  })

  it('catches a deletion made between the build and our first check', () => {
    const { server, client } = pair()
    const t = new BehindTracker({ docs: { f: svOf(server) }, docSnapshots: { f: snapOf(server) } })
    text(client).delete(0, 2) // before the compile result arrived
    expect(t.check('f', client)).toBe(true)
  })
})

describe('BehindTracker for files that were not open when the build ran (review finding 3)', () => {
  it('takes the first synced state as the build state, then notices inserts', () => {
    const { client } = pair()
    const t = new BehindTracker({ docs: {} })
    expect(t.check('intro', client)).toBe(false)
    text(client).insert(3, 'y')
    expect(t.check('intro', client)).toBe(true)
  })

  it('then notices deletions', () => {
    const { client } = pair()
    const t = new BehindTracker({ docs: {} })
    expect(t.check('intro', client)).toBe(false)
    text(client).delete(0, 1)
    expect(t.check('intro', client)).toBe(true)
  })

  it('keeps the baseline across a close and reopen of the file', () => {
    const { server, client } = pair()
    const t = new BehindTracker({ docs: {} })
    expect(t.check('intro', client)).toBe(false)
    text(client).insert(0, 'z')
    sync(client, server)
    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(server))
    expect(t.check('intro', reopened)).toBe(true)
  })
})
