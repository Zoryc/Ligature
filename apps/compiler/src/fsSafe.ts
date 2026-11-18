/**
 * File helpers that never follow symlinks and only ever read regular files.
 * On Windows (dev only) O_NOFOLLOW does not exist; an lstat pre-check is used instead (racy, acceptable for dev).
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
// O_NONBLOCK so that opening a planted FIFO does not hang; it has no effect on regular files.
const NONBLOCK = constants.O_NONBLOCK ?? 0

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code

export interface RegularFile { fh: FileHandle; size: number; mtimeMs: number; ctimeMs: number; ino: number }

/** Open a regular file read-only without following a symlink. Null if missing, a symlink, or not a regular file. */
export async function openRegular(path: string): Promise<RegularFile | null> {
  if (NOFOLLOW === 0) {
    try { if (!(await lstat(path)).isFile()) return null } catch (e) { if (code(e) === 'ENOENT') return null; throw e }
  }
  let fh: FileHandle
  try {
    fh = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  } catch (e) {
    const c = code(e)
    if (c === 'ENOENT' || c === 'ELOOP' || c === 'ENOTDIR' || c === 'EISDIR' || c === 'ENXIO') return null
    throw e
  }
  const st = await fh.stat()
  if (!st.isFile()) { await fh.close(); return null }
  return { fh, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino }
}

/** Create or truncate a file for writing without following a symlink at the final component. */
export async function openForWrite(path: string): Promise<FileHandle> {
  if (NOFOLLOW === 0) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`refusing to write through symlink ${path}`) } catch (e) {
      if (code(e) !== 'ENOENT') throw e
    }
  }
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o644)
}

/** sha256 of a regular file, or null if it is missing / not a regular file. */
export async function hashRegularFile(path: string): Promise<string | null> {
  const f = await openRegular(path)
  if (!f) return null
  try {
    const h = createHash('sha256')
    for await (const chunk of f.fh.createReadStream({ autoClose: false })) h.update(chunk as Buffer)
    return h.digest('hex')
  } finally {
    await f.fh.close()
  }
}

export { code as errnoCode }
