/**
 * Content-addressed blob cache owned by the worker: BUILDS_DIR/.blobs/<2 hex>/<62 hex>.
 * Writes go to .blobs/tmp/ first and are renamed into place only after the sha256 matches,
 * so the cache never holds a file whose name lies about its content.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import { chmod, lstat, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { openForWrite, openRegular } from './fsSafe.ts'

export class BlobError extends Error {
  readonly code: 'mismatch' | 'too-large'
  constructor(code: 'mismatch' | 'too-large', message: string) {
    super(message)
    this.code = code
  }
}

export class BlobStore {
  readonly dir: string
  private readonly tmp: string
  private readonly maxBytes: number

  constructor(dir: string, maxBytes: number) {
    this.dir = dir
    this.tmp = join(dir, 'tmp')
    this.maxBytes = maxBytes
  }

  async init(): Promise<void> {
    await mkdir(this.tmp, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
    // Leftovers of uploads interrupted by a crash.
    await rm(this.tmp, { recursive: true, force: true })
    await mkdir(this.tmp, { mode: 0o700 })
  }

  /** Caller must have validated `hash` (64 lowercase hex). */
  path(hash: string): string {
    return join(this.dir, hash.slice(0, 2), hash.slice(2))
  }

  async has(hash: string): Promise<boolean> {
    try { return (await stat(this.path(hash))).isFile() } catch { return false }
  }

  /**
   * The distinct hashes among `hashes` that are not in the cache, in first-seen order.
   * The ones present are marked as used now (their mtime), which is what eviction goes by.
   */
  async missing(hashes: Iterable<string>): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()
    const now = new Date()
    for (const h of hashes) {
      if (seen.has(h)) continue
      seen.add(h)
      if (!(await this.has(h))) out.push(h)
      else await utimes(this.path(h), now, now).catch(() => { /* evicted meanwhile: the compile will report it missing */ })
    }
    return out
  }

  /**
   * Evict blobs: first those unused for longer than `maxAgeMs`, then the least recently used until the
   * cache holds at most `maxBytes`. A blob used within `minAgeMs` is never evicted, so nothing disappears
   * between a sync and the compile that follows it. Evicting is always safe: the next sync reports the
   * blob missing and the app uploads it again (the project's src/ keeps its own copy anyway).
   */
  async gc(o: { maxBytes: number; maxAgeMs: number; minAgeMs: number; now?: number }): Promise<{ removed: number; freedBytes: number; keptBytes: number }> {
    const now = o.now ?? Date.now()
    const all: { path: string; size: number; used: number }[] = []
    for (const d of await readdir(this.dir)) {
      if (!/^[0-9a-f]{2}$/.test(d)) continue
      for (const f of await readdir(join(this.dir, d)).catch(() => [] as string[])) {
        try {
          const st = await lstat(join(this.dir, d, f))
          if (st.isFile()) all.push({ path: join(this.dir, d, f), size: st.size, used: st.mtimeMs })
        } catch { /* gone */ }
      }
    }
    all.sort((a, b) => a.used - b.used) // least recently used first
    let kept = all.reduce((n, b) => n + b.size, 0)
    let removed = 0
    let freed = 0
    for (const b of all) {
      const age = now - b.used
      if (age < o.minAgeMs) break
      if (age <= o.maxAgeMs && kept <= o.maxBytes) break
      try {
        await rm(b.path)
        removed++
        freed += b.size
        kept -= b.size
      } catch { /* in use (Windows) or gone: try again next time */ }
    }
    return { removed, freedBytes: freed, keptBytes: kept }
  }

  /** Store a blob from a stream, verifying size limit and hash. */
  async put(hash: string, body: AsyncIterable<Buffer | Uint8Array>): Promise<void> {
    const tmpPath = join(this.tmp, randomBytes(12).toString('hex'))
    const h = createHash('sha256')
    let size = 0
    try {
      const fh = await openForWrite(tmpPath)
      try {
        for await (const raw of body) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
          size += chunk.length
          if (size > this.maxBytes) throw new BlobError('too-large', `blob larger than ${this.maxBytes} bytes`)
          h.update(chunk)
          await fh.write(chunk)
        }
      } finally {
        await fh.close()
      }
      const actual = h.digest('hex')
      if (actual !== hash) throw new BlobError('mismatch', `content hashes to ${actual}, not ${hash}`)
      await mkdir(join(this.dir, hash.slice(0, 2)), { recursive: true, mode: 0o700 })
      try {
        await rename(tmpPath, this.path(hash))
      } catch (e) {
        // A concurrent upload of the same content got there first (Windows refuses to rename over a file
        // that is being renamed or read). Its content is verified too, so the blob is in place.
        if (!(await this.has(hash))) throw e
        await rm(tmpPath, { force: true })
      }
    } catch (e) {
      await rm(tmpPath, { force: true })
      throw e
    }
  }

  open(hash: string) {
    return openRegular(this.path(hash))
  }

  /** Consume a body for a blob we already have: nothing is written, but size and hash are still checked. */
  async verifyOnly(hash: string, body: Readable): Promise<void> {
    const h = createHash('sha256')
    let size = 0
    for await (const chunk of body) {
      size += (chunk as Buffer).length
      if (size > this.maxBytes) throw new BlobError('too-large', `blob larger than ${this.maxBytes} bytes`)
      h.update(chunk as Buffer)
    }
    const actual = h.digest('hex')
    if (actual !== hash) throw new BlobError('mismatch', `content hashes to ${actual}, not ${hash}`)
  }
}
