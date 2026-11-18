/**
 * Per-project cache of source-file hashes, so a compile does not re-read and re-hash every source
 * (e.g. hundreds of MB of images) just to find out that nothing changed.
 *
 * Stored as BUILDS_DIR/<id>/.src-hashes.json, written by the helper (project uid). An entry is used
 * only while the file's (size, mtime, ctime, inode) are unchanged. Any write to the file changes its
 * ctime, which an unprivileged process cannot set back, so a TeX run that edits a source is still
 * detected and the source restored. A run that forges this file can only make its OWN project build
 * stale content (the same uid already controls every file of the project); `clean` ignores the cache
 * and re-hashes everything.
 */
import { createHash } from 'node:crypto'
import { lstat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isHash, type Manifest } from './contract.ts'
import { openForWrite, openRegular, type RegularFile } from './fsSafe.ts'

export const HASH_CACHE_FILE = '.src-hashes.json'
const MAX_CACHE_BYTES = 32 * 1024 * 1024

interface Stamp { size: number; mtimeMs: number; ctimeMs: number; ino: number }
type Entry = [size: number, mtimeMs: number, ctimeMs: number, ino: number, hash: string]

const stampOf = (s: Stamp): Stamp => ({ size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino })
const same = (e: Entry, s: Stamp) => e[0] === s.size && e[1] === s.mtimeMs && e[2] === s.ctimeMs && e[3] === s.ino

function isEntry(v: unknown): v is Entry {
  return Array.isArray(v) && v.length === 5 && v.slice(0, 4).every(n => typeof n === 'number' && Number.isFinite(n)) &&
    typeof v[4] === 'string' && isHash(v[4])
}

async function hashOpen(f: RegularFile): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of f.fh.createReadStream({ autoClose: false })) h.update(chunk as Buffer)
  return h.digest('hex')
}

export class HashCache {
  private readonly entries = new Map<string, Entry>()
  /** files hashed for real (not answered from the cache) since load; for tests and diagnostics */
  hashed = 0

  /** Load the cache of the project at `root`; an empty cache if `fresh`, missing, oversized or malformed. */
  static async load(root: string, fresh = false): Promise<HashCache> {
    const c = new HashCache()
    if (fresh) return c
    const f = await openRegular(join(root, HASH_CACHE_FILE)).catch(() => null)
    if (!f) return c
    try {
      if (f.size > MAX_CACHE_BYTES) return c
      const v: unknown = JSON.parse((await f.fh.readFile()).toString('utf8'))
      const files = (v as { files?: unknown } | null)?.files
      if (typeof files !== 'object' || files === null || Array.isArray(files)) return c
      for (const [p, e] of Object.entries(files)) if (isEntry(e)) c.entries.set(p, e)
    } catch {
      c.entries.clear()
    } finally {
      await f.fh.close()
    }
    return c
  }

  /** sha256 of the regular file `rel` under `src`, from the cache when its stamp is unchanged. Null if not a regular file. */
  async hashOf(src: string, rel: string): Promise<string | null> {
    const abs = join(src, ...rel.split('/'))
    const cached = this.entries.get(rel)
    if (cached) {
      try {
        const st = await lstat(abs)
        if (st.isFile() && same(cached, st)) return cached[4]
      } catch { /* fall through to a real read */ }
    }
    const f = await openRegular(abs)
    if (!f) { this.entries.delete(rel); return null }
    try {
      const hash = await hashOpen(f)
      this.hashed++
      const s = stampOf(await f.fh.stat())
      this.entries.set(rel, [s.size, s.mtimeMs, s.ctimeMs, s.ino, hash])
      return hash
    } finally {
      await f.fh.close()
    }
  }

  /** Record a file just written with known content. */
  async record(src: string, rel: string, hash: string): Promise<void> {
    try {
      const st = await lstat(join(src, ...rel.split('/')))
      if (st.isFile()) this.entries.set(rel, [st.size, st.mtimeMs, st.ctimeMs, st.ino, hash])
    } catch { this.entries.delete(rel) }
  }

  /** Write the entries of the manifest's files (temp file + rename, never through a symlink). */
  async save(root: string, manifest: Manifest): Promise<void> {
    // fromEntries defines own properties, so a "__proto__" path stays an ordinary key
    const files = Object.fromEntries([...this.entries].filter(([p, e]) => Object.hasOwn(manifest, p) && manifest[p] === e[4]))
    const tmp = join(root, `${HASH_CACHE_FILE}.tmp`)
    const fh = await openForWrite(tmp)
    try {
      await fh.writeFile(JSON.stringify({ v: 1, files }))
    } finally {
      await fh.close()
    }
    await rename(tmp, join(root, HASH_CACHE_FILE))
  }
}
