import type { VersionFile } from '@ligature/shared'
import { readProjectContent } from '../collab/barrier.ts'
import type { CoreServices } from './types.ts'
import { manifestHash, sha256Hex, sortByPath } from './manifest.ts'

/*
 * A version's content, captured through the snapshot barrier (collab/barrier.ts): text as UTF-8 bytes
 * (to be stored as blobs), binaries by their existing blob hash.
 */

export interface CapturedFile extends VersionFile {
  /** UTF-8 bytes of a text file (its blob content); absent for binaries. */
  bytes?: Buffer
}

export interface Capture {
  treeVersion: number
  /** Sorted by path. */
  files: CapturedFile[]
  manifestHash: string
}

/** Capture the project's live state now (synchronous). `textOverrides`: file id -> text to use instead. */
export function captureProject(s: CoreServices, projectId: string, textOverrides?: ReadonlyMap<string, string>): Capture {
  const content = readProjectContent(s.db, s.store, s.collab, projectId, textOverrides)
  const files: CapturedFile[] = content.files.map(f => {
    if (f.kind === 'text') {
      const bytes = Buffer.from(f.text, 'utf8')
      return { path: f.path, fileId: f.id, kind: 'text', size: bytes.byteLength, hash: sha256Hex(bytes), bytes }
    }
    return { path: f.path, fileId: f.id, kind: 'binary', size: f.size ?? s.blobs.sizeOf(f.blobHash) ?? 0, hash: f.blobHash }
  })
  const sorted = sortByPath(files)
  return { treeVersion: content.treeVersion, files: sorted, manifestHash: manifestHash(sorted) }
}

/** The capture without the text bytes (the shape of `version_files`). */
export const withoutBytes = (files: readonly CapturedFile[]): VersionFile[] =>
  files.map(({ bytes: _bytes, ...f }) => f)
