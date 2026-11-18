import { createHash } from 'node:crypto'
import type { VersionFile } from '@ligature/shared'

/*
 * Pure helpers over version file lists (docs/M3.md §1): the manifest hash used for dedupe.
 */

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** Files sorted by path (a copy). */
export function sortByPath<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort(byPath)
}

/**
 * sha256 of the sorted (path, file id, content hash) list. Two snapshots with the same hash have the
 * same files at the same paths with the same content (kind and size follow from the content).
 */
export function manifestHash(files: readonly Pick<VersionFile, 'path' | 'fileId' | 'hash'>[]): string {
  const h = createHash('sha256')
  for (const f of sortByPath(files)) h.update(`${f.path}\u0000${f.fileId}\u0000${f.hash}\n`)
  return h.digest('hex')
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
