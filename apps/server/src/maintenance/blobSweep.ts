import { readdir } from 'node:fs/promises'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { DB } from '../db/index.ts'

/*
 * Blob mark-and-sweep (docs/M3.md §3). A blob is referenced when a file row (live or trashed) or a version
 * refers to it, or when it was written in the last `graceMs` (by `blobs.created_at` or by file mtime:
 * uploads, imports and snapshots write the file before the row that references it is committed, and a
 * writer that finds the file already there refreshes its mtime).
 *
 * The directory listing is async; the decision for each candidate is re-made synchronously right before
 * deleting it, in chunks: one synchronous section re-reads the references of the chunk from the database,
 * re-stats the files and deletes. Every writer in this process records its references synchronously, so
 * none can interleave with a chunk.
 */

const SUB_RE = /^[0-9a-f]{2}$/
const REST_RE = /^[0-9a-f]{62}$/
/** Candidates decided per synchronous section. */
const CHUNK = 256

export interface SweepResult {
  /** Blob files seen on disk. */
  scanned: number
  removed: number
  bytesFreed: number
  /** `blobs` rows without a file and without a reference, dropped. */
  danglingRows: number
  /** Leftover temp files of interrupted writes, removed. */
  tempFiles: number
}

export interface SweepOptions {
  /** Test hook: runs after the listing, before any deletion. */
  afterList?: (hashes: readonly string[]) => Promise<void>
}

const inList = (hashes: readonly string[]) => JSON.stringify(hashes)

/** The hashes of `chunk` that something refers to, or that were recorded after `cutoff` (synchronous). */
function keptByDb(db: DB, chunk: readonly string[], cutoff: number): Set<string> {
  const list = inList(chunk)
  const rows = db.prepare(`
    SELECT blob_hash AS h FROM files WHERE blob_hash IN (SELECT value FROM json_each(@list))
    UNION SELECT blob_hash FROM version_files WHERE blob_hash IN (SELECT value FROM json_each(@list))
    UNION SELECT hash FROM blobs WHERE created_at > @cutoff AND hash IN (SELECT value FROM json_each(@list))`)
    .all({ list, cutoff }) as { h: string }[]
  return new Set(rows.map(r => r.h))
}

export async function sweepBlobs(db: DB, dir: string, now: number, graceMs: number, opts: SweepOptions = {}): Promise<SweepResult> {
  const cutoff = now - graceMs
  const res: SweepResult = { scanned: 0, removed: 0, bytesFreed: 0, danglingRows: 0, tempFiles: 0 }

  // 1. List (async).
  const hashes: string[] = []
  const temps: string[] = []
  let subs: string[] = []
  try { subs = (await readdir(dir)).filter(n => SUB_RE.test(n)).sort() } catch { /* no blob dir yet */ }
  for (const sub of subs) {
    let names: string[]
    try { names = await readdir(join(dir, sub)) } catch { continue }
    for (const n of names) {
      if (REST_RE.test(n)) hashes.push(sub + n)
      else if (n.startsWith('.tmp-')) temps.push(join(dir, sub, n))
    }
  }
  res.scanned = hashes.length
  await opts.afterList?.(hashes)

  // 2. Sweep in synchronous chunks.
  const pathOf = (h: string) => join(dir, h.slice(0, 2), h.slice(2))
  const delRow = db.prepare('DELETE FROM blobs WHERE hash = ?')
  for (let i = 0; i < hashes.length; i += CHUNK) {
    if (!db.open) return res
    const chunk = hashes.slice(i, i + CHUNK)
    const kept = keptByDb(db, chunk, cutoff)
    const doomed: { hash: string; size: number }[] = []
    for (const h of chunk) {
      if (kept.has(h)) continue
      let st
      try { st = statSync(pathOf(h)) } catch { continue } // already gone
      if (st.mtimeMs > cutoff) continue
      doomed.push({ hash: h, size: st.size })
    }
    // Row first (in one transaction), then the file: a crash in between leaves an unrecorded file, which the
    // next sweep removes; never a row whose file is missing.
    if (doomed.length > 0) {
      db.transaction(() => { for (const d of doomed) delRow.run(d.hash) })()
      for (const d of doomed) {
        rmSync(pathOf(d.hash), { force: true })
        res.removed++
        res.bytesFreed += d.size
      }
    }
    await yieldToLoop()
  }

  // 3. Rows whose file is missing and that nothing refers to (synchronous).
  if (db.open) {
    const onDisk = new Set(hashes)
    const old = (db.prepare('SELECT hash FROM blobs WHERE created_at <= ?').all(cutoff) as { hash: string }[])
      .map(r => r.hash).filter(h => !onDisk.has(h))
    for (let i = 0; i < old.length; i += CHUNK) {
      const chunk = old.slice(i, i + CHUNK)
      const kept = keptByDb(db, chunk, cutoff)
      const gone = chunk.filter(h => !kept.has(h) && !existsSync(pathOf(h)))
      if (gone.length > 0) db.transaction(() => { for (const h of gone) res.danglingRows += delRow.run(h).changes })()
    }
  }

  // 4. Temp files of interrupted writes (an in-flight write has a fresh mtime).
  for (const t of temps) {
    try {
      if (statSync(t).mtimeMs <= cutoff) { rmSync(t, { force: true }); res.tempFiles++ }
    } catch { /* gone */ }
  }
  return res
}
