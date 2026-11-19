import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import type { DB } from '../db/index.ts'

/** Origin used when replaying stored state into a Y.Doc, so the replay is not logged again. */
export const LOAD_ORIGIN = Symbol('ligature-load')

export const TEXT_KEY = 'content'

const FLUSH_INTERVAL_MS = 200
/** After a failed write (disk full, I/O error): retry the kept batch this often. */
const FLUSH_RETRY_MS = 1000
/** Compact a loaded doc once this many updates were logged since its last compaction. */
const COMPACT_EVERY = 500

interface Pending { docName: string; seq: number; update: Uint8Array; userId: string | null; ts: number }

/** What a compaction wrote: the encoded state and the text mirror (for the oversized-doc check, docs/M3.md §4). */
export interface Compacted { stateBytes: number; text: string }

/** A seeded doc's initial state, computed ahead of the write (`DocStore.prepareSeed`). */
export interface PreparedSeed { state: Uint8Array; text: string; hash: string }

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
  /**
   * Loaded docs whose generation was replaced by a rebuild (docs/M3.md §4): their rows are gone and
   * must not be written again by a later compaction (unload, shutdown). Cleared by `release`.
   */
  private retired = new Set<string>()
  /** See `flushFailing`. */
  private flushFailed = false

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
    // A retired generation has no rows any more; its last holders are disconnected and get reload-required.
    if (this.retired.has(docName)) return
    const seq = this.nextSeq.get(docName)
    if (seq === undefined) throw new Error(`append to unloaded doc ${docName}`)
    this.nextSeq.set(docName, seq + 1)
    this.buffer.push({ docName, seq, update: update.slice(), userId, ts: Date.now() })
    this.sinceCompact.set(docName, (this.sinceCompact.get(docName) ?? 0) + 1)
    if (!this.timer) this.timer = setTimeout(() => this.flushFromTimer(), FLUSH_INTERVAL_MS)
  }

  /**
   * The batching timer is usually the first to write a user's edits. A failed write there (disk full,
   * I/O error, read-only volume) is logged instead of thrown: thrown from a timer it would end the
   * process, so /healthz could never report `store: write-failed` and the server would crash-loop
   * instead. Direct callers of `flush()` still get the error.
   */
  private flushFromTimer(): void {
    const wasFailing = this.flushFailed
    try {
      this.flush()
      if (wasFailing) console.error('[docStore] writing edits works again; the kept edits are saved')
    } catch (e) {
      if (!wasFailing) console.error('[docStore] writing edits failed; they are kept in memory and retried', e)
      // The batch is back in the buffer (see flush): retry until the disk accepts it again.
      if (!this.timer && this.buffer.length) this.timer = setTimeout(() => this.flushFromTimer(), FLUSH_RETRY_MS)
    }
  }

  /**
   * Write all buffered updates in one transaction. Synchronous. On failure the transaction is rolled back
   * and the whole batch goes back to the front of the buffer (same seqs, same order), then the error is
   * thrown: dropping it would leave a gap in the log that no later write repairs.
   */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.buffer.length === 0 || !this.db.open) return
    const batch = this.buffer
    this.buffer = []
    try {
      this.db.transaction(() => {
        for (const p of batch) this.stmt.insertUpdate.run(p.docName, p.seq, p.update, p.userId, p.ts)
      })()
    } catch (e) {
      this.buffer = batch.concat(this.buffer)
      this.flushFailed = true
      throw e
    }
    this.flushFailed = false
  }

  /**
   * The last flush of updates failed and none has succeeded since: edits are not being saved
   * (GET /healthz, docs/M4.md §1). Only observes flushing; `flush()` still throws the failure (the
   * batching timer logs it, see `flushFromTimer`).
   */
  get flushFailing(): boolean {
    return this.flushFailed
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
   * Returns null (and writes nothing) for a retired doc.
   */
  compact(docName: string, doc: Y.Doc): Compacted | null {
    this.flush()
    if (this.retired.has(docName)) return null
    const next = this.nextSeq.get(docName)
    const upto = next !== undefined ? next - 1 : ((this.stmt.maxSeq.get(docName) as { m: number | null }).m ?? 0)
    const state = Y.encodeStateAsUpdate(doc)
    const text = doc.getText(TEXT_KEY).toString()
    this.db.transaction(() => {
      this.stmt.upsertState.run(docName, upto, state, text, sha256(text), Date.now())
      this.stmt.deleteUpTo.run(docName, upto)
    })()
    this.sinceCompact.set(docName, 0)
    return { stateBytes: state.byteLength, text }
  }

  /**
   * A loaded doc whose generation was replaced (rebuild): later compactions of it are skipped, so its
   * deleted rows are never written back. Buffered updates are flushed first (the caller deletes them).
   */
  retire(docName: string): void {
    this.flush()
    this.retired.add(docName)
  }

  isRetired(docName: string): boolean {
    return this.retired.has(docName)
  }

  /** Stored size of a closed doc: compacted state bytes, text mirror, and the bytes of its log rows. */
  storedStats(docName: string): { stateBytes: number; text: string; logBytes: number } | null {
    this.flush()
    const st = this.db.prepare('SELECT length(state) AS stateBytes, text FROM doc_state WHERE doc_name = ?').get(docName) as
      { stateBytes: number; text: string } | undefined
    if (!st) return null
    const log = this.db.prepare('SELECT COALESCE(SUM(length(update_blob)), 0) AS n FROM doc_updates WHERE doc_name = ?').get(docName) as { n: number }
    return { ...st, logBytes: log.n }
  }

  /** Forget per-doc counters after a doc is unloaded (it will be re-read from the DB on next load). */
  release(docName: string): void {
    this.nextSeq.delete(docName)
    this.sinceCompact.delete(docName)
    this.retired.delete(docName)
  }

  /** Text of a doc that is NOT loaded. Only valid after compaction (see recoverAll). */
  storedText(docName: string): { text: string; hash: string } | null {
    this.flush()
    return (this.stmt.getText.get(docName) as { text: string; hash: string } | undefined) ?? null
  }

  /** Create the initial state of a new text doc. Only the server ever seeds content. */
  seed(docName: string, initialText: string): void {
    this.seedPrepared(docName, DocStore.prepareSeed(initialText))
  }

  /**
   * The CPU-heavy half of `seed` (Yjs encoding, hashing), without touching the database: bulk writers
   * (zip import) prepare their docs in small async steps, then only write rows inside their transaction.
   */
  static prepareSeed(initialText: string): PreparedSeed {
    const doc = new Y.Doc({ gc: true })
    doc.getText(TEXT_KEY).insert(0, initialText)
    const state = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    return { state, text: initialText, hash: sha256(initialText) }
  }

  seedPrepared(docName: string, p: PreparedSeed): void {
    this.stmt.upsertState.run(docName, 0, p.state, p.text, p.hash, Date.now())
  }

  /**
   * Startup recovery: fold any leftover log rows (e.g. after kill -9) into doc_state,
   * so the text mirror used for compiles of closed docs is always current.
   */
  recoverAll(onCompacted?: (docName: string, c: Compacted) => void): number {
    const names = (this.stmt.docsWithLog.all() as { name: string }[]).map(r => r.name)
    for (const name of names) {
      const doc = new Y.Doc({ gc: true })
      this.load(name, doc)
      const c = this.compact(name, doc)
      this.release(name)
      doc.destroy()
      if (c) onCompacted?.(name, c)
    }
    return names.length
  }
}
