import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import type { DB } from '../db/index.ts'

/** Origin used when replaying stored state into a Y.Doc, so the replay is not logged again. */
export const LOAD_ORIGIN = Symbol('ligature-load')

export const TEXT_KEY = 'content'

const FLUSH_INTERVAL_MS = 200
/** Compact a loaded doc once this many updates were logged since its last compaction. */
const COMPACT_EVERY = 500

interface Pending { docName: string; seq: number; update: Uint8Array; userId: string | null; ts: number }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/**
 * Durable Yjs storage: append-only update log + compacted snapshot per doc.
 *
 * Invariants:
 *  - Every update applied to a live doc (except LOAD_ORIGIN replays) is appended to the log.
 *  - The log is written in batches (~200 ms) in one transaction with synchronous=FULL.
 *  - Compaction writes state that contains every logged update with seq <= upto_seq, then deletes those rows,
 *    in one transaction. Replaying an update twice is harmless (Yjs updates are idempotent).
 */
export class DocStore {
  private buffer: Pending[] = []
  private timer: NodeJS.Timeout | null = null
  /** next seq to assign, per doc (only for docs touched by this process) */
  private nextSeq = new Map<string, number>()
  private sinceCompact = new Map<string, number>()

  private readonly stmt
  constructor(private readonly db: DB) {
    this.stmt = {
      insertUpdate: db.prepare('INSERT INTO doc_updates (doc_name, seq, update_blob, user_id, ts) VALUES (?, ?, ?, ?, ?)'),
      maxSeq: db.prepare('SELECT MAX(seq) AS m FROM doc_updates WHERE doc_name = ?'),
      getState: db.prepare('SELECT upto_seq AS uptoSeq, state FROM doc_state WHERE doc_name = ?'),
      getUpdates: db.prepare('SELECT seq, update_blob AS u FROM doc_updates WHERE doc_name = ? AND seq > ? ORDER BY seq'),
      upsertState: db.prepare(`INSERT INTO doc_state (doc_name, upto_seq, state, text, text_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_name) DO UPDATE SET upto_seq = excluded.upto_seq, state = excluded.state,
          text = excluded.text, text_hash = excluded.text_hash, updated_at = excluded.updated_at`),
      deleteUpTo: db.prepare('DELETE FROM doc_updates WHERE doc_name = ? AND seq <= ?'),
      getText: db.prepare('SELECT text, text_hash AS hash FROM doc_state WHERE doc_name = ?'),
      docsWithLog: db.prepare('SELECT DISTINCT doc_name AS name FROM doc_updates'),
    }
  }

  /** Replay stored state + log into `doc`. Returns the highest seq applied. */
  load(docName: string, doc: Y.Doc): number {
    this.flush() // our own buffered rows for this doc must be visible
    const st = this.stmt.getState.get(docName) as { uptoSeq: number; state: Buffer } | undefined
    let upto = st?.uptoSeq ?? 0
    Y.transact(doc, () => {
      if (st) Y.applyUpdate(doc, st.state)
      for (const row of this.stmt.getUpdates.iterate(docName, upto) as Iterable<{ seq: number; u: Buffer }>) {
        Y.applyUpdate(doc, row.u)
        upto = row.seq
      }
    }, LOAD_ORIGIN)
    const max = (this.stmt.maxSeq.get(docName) as { m: number | null }).m ?? 0
    this.nextSeq.set(docName, Math.max(max, st?.uptoSeq ?? 0) + 1)
    return upto
  }

  append(docName: string, update: Uint8Array, userId: string | null): void {
    const seq = this.nextSeq.get(docName)
    if (seq === undefined) throw new Error(`append to unloaded doc ${docName}`)
    this.nextSeq.set(docName, seq + 1)
    this.buffer.push({ docName, seq, update: update.slice(), userId, ts: Date.now() })
    this.sinceCompact.set(docName, (this.sinceCompact.get(docName) ?? 0) + 1)
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS)
  }

  /** Write all buffered updates in one transaction. Synchronous. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    this.db.transaction(() => {
      for (const p of batch) this.stmt.insertUpdate.run(p.docName, p.seq, p.update, p.userId, p.ts)
    })()
  }

  /** Drop unflushed updates and stop the timer, as a kill -9 would. Tests only. */
  abandonForTest(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.buffer = []
  }

  shouldCompact(docName: string): boolean {
    return (this.sinceCompact.get(docName) ?? 0) >= COMPACT_EVERY
  }

  /**
   * Snapshot `doc` and drop the log rows it covers. Synchronous, so the doc cannot change underneath us.
   * Every update logged so far for this doc was applied to `doc` before being appended, so state ⊇ log[..upto].
   */
  compact(docName: string, doc: Y.Doc): void {
    this.flush()
    const next = this.nextSeq.get(docName)
    const upto = next !== undefined ? next - 1 : ((this.stmt.maxSeq.get(docName) as { m: number | null }).m ?? 0)
    const state = Y.encodeStateAsUpdate(doc)
    const text = doc.getText(TEXT_KEY).toString()
    this.db.transaction(() => {
      this.stmt.upsertState.run(docName, upto, state, text, sha256(text), Date.now())
      this.stmt.deleteUpTo.run(docName, upto)
    })()
    this.sinceCompact.set(docName, 0)
  }

  /** Forget per-doc counters after a doc is unloaded (it will be re-read from the DB on next load). */
  release(docName: string): void {
    this.nextSeq.delete(docName)
    this.sinceCompact.delete(docName)
  }

  /** Text of a doc that is NOT loaded. Only valid after compaction (see recoverAll). */
  storedText(docName: string): { text: string; hash: string } | null {
    this.flush()
    return (this.stmt.getText.get(docName) as { text: string; hash: string } | undefined) ?? null
  }

  /** Create the initial state of a new text doc. Only the server ever seeds content. */
  seed(docName: string, initialText: string): void {
    const doc = new Y.Doc({ gc: true })
    doc.getText(TEXT_KEY).insert(0, initialText)
    const state = Y.encodeStateAsUpdate(doc)
    this.stmt.upsertState.run(docName, 0, state, initialText, sha256(initialText), Date.now())
    doc.destroy()
  }

  /**
   * Startup recovery: fold any leftover log rows (e.g. after kill -9) into doc_state,
   * so the text mirror used for compiles of closed docs is always current.
   */
  recoverAll(): number {
    const names = (this.stmt.docsWithLog.all() as { name: string }[]).map(r => r.name)
    for (const name of names) {
      const doc = new Y.Doc({ gc: true })
      this.load(name, doc)
      this.compact(name, doc)
      this.release(name)
      doc.destroy()
    }
    return names.length
  }
}
