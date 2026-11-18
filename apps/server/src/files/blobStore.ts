import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '../db/index.ts'

const HASH_RE = /^[0-9a-f]{64}$/

/**
 * Content-addressed blob store: `<dir>/ab/cdef…` (sha256 hex), recorded in the `blobs` table.
 * Writes go to a temp file in the target directory, are fsynced, then renamed into place,
 * so a blob file either exists complete or not at all. No GC in M1.
 */
export class BlobStore {
  constructor(private readonly db: DB, readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  static hashOf(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex')
  }

  pathOf(hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error(`invalid blob hash ${hash}`)
    return join(this.dir, hash.slice(0, 2), hash.slice(2))
  }

  has(hash: string): boolean {
    return existsSync(this.pathOf(hash))
  }

  /** Store `data` (idempotent). Returns its sha256. `hash` may be passed if already computed. */
  put(data: Uint8Array, hash: string = BlobStore.hashOf(data)): string {
    const final = this.pathOf(hash)
    if (!existsSync(final)) {
      const sub = join(this.dir, hash.slice(0, 2))
      mkdirSync(sub, { recursive: true })
      const tmp = join(sub, `.tmp-${randomBytes(8).toString('hex')}`)
      try {
        const fd = openSync(tmp, 'wx')
        try {
          let off = 0
          while (off < data.byteLength) off += writeSync(fd, data, off, data.byteLength - off)
          fsyncSync(fd)
        } finally { closeSync(fd) }
        renameSync(tmp, final)
      } catch (e) {
        rmSync(tmp, { force: true })
        if (!existsSync(final)) throw e // a concurrent writer may have won the rename race
      }
      if (process.platform !== 'win32') {
        // Make the rename itself durable.
        const dfd = openSync(sub, 'r')
        try { fsyncSync(dfd) } finally { closeSync(dfd) }
      }
    }
    this.db.prepare('INSERT OR IGNORE INTO blobs (hash, size, created_at) VALUES (?, ?, ?)').run(hash, data.byteLength, Date.now())
    return hash
  }

  read(hash: string): Buffer | null {
    try { return readFileSync(this.pathOf(hash)) } catch { return null }
  }

  /** Size in bytes of a stored blob, or null if missing. */
  sizeOf(hash: string): number | null {
    try { return statSync(this.pathOf(hash)).size } catch { return null }
  }

  /**
   * Remove a blob file that has no `blobs` row (written by a request whose transaction then rolled
   * back). Never removes a recorded blob. Call synchronously right after the rollback.
   */
  discardUnrecorded(hash: string): void {
    if (this.db.prepare('SELECT 1 FROM blobs WHERE hash = ?').get(hash)) return
    rmSync(this.pathOf(hash), { force: true })
  }
}
