import type * as Y from 'yjs'
import { fileDocName } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import { filePaths, liveFiles, type FileRow } from '../projects/repo.ts'
import { TEXT_KEY, type DocStore } from './docStore.ts'

/*
 * The snapshot barrier (shared by compiles and versions): read every live file of a project in ONE
 * synchronous pass (no await), so no incoming update can interleave. Live docs are authoritative; closed
 * docs use the compacted text mirror (always current: compaction on unload, recovery at startup).
 */

export interface BarrierText { kind: 'text'; id: string; path: string; docName: string; text: string; live: Y.Doc | undefined }
export interface BarrierBinary { kind: 'binary'; id: string; path: string; blobHash: string; size: number | null }
export type BarrierFile = BarrierText | BarrierBinary

export interface ProjectContent {
  treeVersion: number
  /** Live rows (folders included). */
  rows: FileRow[]
  /** file id -> project-relative path (files only). */
  paths: Map<string, string>
  /** Every live file (folders excluded; binaries without a blob are skipped), in row order. */
  files: BarrierFile[]
}

export interface LiveDocs { liveDoc(documentName: string): Y.Doc | undefined }

/**
 * Read the project's content now. `textOverrides` (file id -> text) replaces what a doc holds, for
 * "the state just before this change" (docs/M3.md §1).
 */
export function readProjectContent(db: DB, store: DocStore, docs: LiveDocs, projectId: string,
  textOverrides?: ReadonlyMap<string, string>): ProjectContent {
  const tv = db.prepare('SELECT tree_version AS v FROM projects WHERE id = ?').get(projectId) as { v: number } | undefined
  if (!tv) throw new Error('project not found')
  const rows = liveFiles(db, projectId)
  const paths = filePaths(rows)
  const files: BarrierFile[] = []
  for (const f of rows) {
    const path = paths.get(f.id)
    if (!path) continue
    if (f.kind === 'text') {
      const docName = fileDocName(projectId, f.id, f.epoch)
      const live = docs.liveDoc(docName)
      const override = textOverrides?.get(f.id)
      const text = override ?? (live ? live.getText(TEXT_KEY).toString() : store.storedText(docName)?.text ?? '')
      files.push({ kind: 'text', id: f.id, path, docName, text, live })
    } else if (f.kind === 'binary' && f.blobHash) {
      files.push({ kind: 'binary', id: f.id, path, blobHash: f.blobHash, size: f.size })
    }
  }
  return { treeVersion: tv.v, rows, paths, files }
}
