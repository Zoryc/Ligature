import { randomUUID } from 'node:crypto'
import { setImmediate as nextTick } from 'node:timers/promises'
import { fileDocName, type ImportReport, type ImportResponse } from '@ligature/shared'
import { audit } from '../audit.ts'
import { DocStore, type PreparedSeed } from '../collab/docStore.ts'
import { ApiError } from '../errors.ts'
import type { Services } from '../services.ts'
import type { SessionUser } from '../auth/sessions.ts'
import { projectDetail } from '../projects/repo.ts'
import { validateProjectName } from '../projects/service.ts'
import { BlobStore } from '../files/blobStore.ts'
import { classifyUpload, extensionOf, type Classified } from '../files/classify.ts'
import { chooseMainFile, hasDocumentClass } from '../files/mainFile.ts'
import { insertNode } from '../files/tree.ts'
import { extractEntry, readZip, ZipError, type ZipEntry, type ZipLimits } from './reader.ts'

/*
 * POST /api/projects/import (docs/M2.md §5): a new project from a zip. All checks run before anything
 * is written; the project rows are created in one transaction (blob files are written just before it, so
 * a failure leaves no project behind — orphaned blob files, if any, are for the M3 garbage collector).
 */

export const badZip = (message: string) => new ApiError(400, 'bad-zip', message)

const ARTIFACT_EXTENSIONS = new Set(['.aux', '.log', '.out', '.toc', '.fdb_latexmk', '.fls', '.bbl', '.blg'])
const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

/** Why an entry is skipped quietly, or null to keep it. */
export function skipReason(segments: string[], isDir: boolean): string | null {
  if (segments.includes('__MACOSX')) return 'macOS metadata'
  const base = segments[segments.length - 1]!.toLowerCase()
  if (isDir) return null
  if (SYSTEM_FILES.has(base)) return 'system file'
  if (base.endsWith('.synctex.gz') || ARTIFACT_EXTENSIONS.has(extensionOf(base))) return 'LaTeX build artifact'
  return null
}

interface Kept { entry: ZipEntry; segments: string[] }

/** If every kept entry sits under one top-level folder, drop that folder from all paths. */
function stripCommonTop(kept: Kept[]): Kept[] {
  if (kept.length === 0) return kept
  const top = kept[0]!.segments[0]!
  const under = kept.every(k => k.segments[0] === top && (k.segments.length > 1 || k.entry.isDir))
  const hasFile = kept.some(k => !k.entry.isDir)
  if (!under || !hasFile) return kept
  return kept.filter(k => k.segments.length > 1).map(k => ({ ...k, segments: k.segments.slice(1) }))
}

interface FileOut { path: string; name: string; parent: string; cls: Classified; bytes: Buffer; entryName: string; hasClass: boolean }

/** Read, validate and extract an archive into the files of a new project (no writes). */
export async function planImport(zip: Buffer, limits: ZipLimits): Promise<{ files: FileOut[]; folders: string[]; report: ImportReport }> {
  let entries: ZipEntry[]
  try {
    entries = readZip(zip, limits)
  } catch (e) {
    if (e instanceof ZipError) throw badZip(e.message)
    throw e
  }
  const skipped: ImportReport['skipped'] = []
  let kept: Kept[] = []
  for (const entry of entries) {
    const reason = skipReason(entry.segments, entry.isDir)
    if (reason) skipped.push({ path: entry.name, reason })
    else kept.push({ entry, segments: entry.segments })
  }
  kept = stripCommonTop(kept)

  const budget = { totalBytes: 0 }
  const files: FileOut[] = []
  for (const k of kept) {
    if (k.entry.isDir) continue
    let bytes: Buffer
    try {
      bytes = extractEntry(zip, k.entry, budget, limits)
    } catch (e) {
      if (e instanceof ZipError) throw badZip(e.message)
      throw e
    }
    const name = k.segments[k.segments.length - 1]!
    const cls = classifyUpload(name, bytes)
    const hasClass = cls.kind === 'text' && name.toLowerCase().endsWith('.tex') && hasDocumentClass(cls.text)
    files.push({ path: k.segments.join('/'), name, parent: k.segments.slice(0, -1).join('/'), cls, bytes, entryName: k.entry.name, hasClass })
    await nextTick() // keep the server responsive while a large archive is extracted
  }

  const detectedMainFile = chooseMainFile(files.flatMap(f => f.cls.kind === 'text' ? [{ path: f.path, hasClass: f.hasClass }] : []))
  let kept2 = files
  if (detectedMainFile !== null) {
    const pdf = `${detectedMainFile.slice(0, -'.tex'.length)}.pdf`.toLowerCase()
    kept2 = files.filter(f => {
      if (f.path.toLowerCase() !== pdf) return true
      skipped.push({ path: f.entryName, reason: 'LaTeX build artifact (PDF of the main file)' })
      return false
    })
  }

  // Folders: every ancestor of a kept file. Explicit folder entries with no file inside are skipped.
  const folders = new Set<string>()
  for (const f of kept2) {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  for (const k of kept) {
    if (k.entry.isDir && k.segments.length > 0 && !folders.has(k.segments.join('/'))) skipped.push({ path: k.entry.name, reason: 'empty folder' })
  }
  const byDepth = [...folders].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
  kept2.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files: kept2, folders: byDepth, report: { skipped, detectedMainFile } }
}

export interface ImportOptions {
  /**
   * Called once the archive is extracted and checked, with the bytes the import will write (text and
   * binaries), before anything is written; throw to refuse (the route charges the upload byte budget).
   */
  charge?: (bytes: number) => void
}

/** Work done between yields while preparing an import (keeps the event loop responsive). */
const SLICE_MS = 10
/** Text written per doc-state transaction before yielding (SQLite writes ~10 ms per MB of text). */
const DOC_BATCH_BYTES = 2 * 1024 * 1024

/**
 * Create the project from a planned import. The heavy part runs first, in small async steps: blob files
 * are written with async I/O, and text docs are encoded and their `doc_state` rows written in small
 * transactions under file ids that no row points to yet. The final transaction only inserts the project,
 * folder and file rows. On failure the pre-written doc states are deleted, so nothing is left behind
 * (blob files may stay, for the M3 garbage collector; a crash mid-import can leave unreferenced doc states).
 */
export async function importProject(s: Services, user: SessionUser, rawName: string | undefined, zip: Buffer,
  opts: ImportOptions = {}): Promise<ImportResponse> {
  const name = validateProjectName(rawName ?? '')
  const plan = await planImport(zip, s.limits.zip)
  const binaryBytes = plan.files.reduce((n, f) => n + (f.cls.kind === 'binary' ? f.bytes.byteLength : 0), 0)
  if (plan.files.length + plan.folders.length > s.limits.maxFiles || binaryBytes > s.limits.maxBinaryBytes) {
    throw new ApiError(413, 'project-too-large', `Projects are limited to ${s.limits.maxFiles} files and ${Math.round(s.limits.maxBinaryBytes / 1048576)} MB of binary files`)
  }
  opts.charge?.(plan.files.reduce((n, f) => n + f.bytes.byteLength, 0))

  const projectId = randomUUID()
  const rootId = randomUUID()
  /** Pre-assigned ids of text files (their docs are written before the file rows). */
  const textIds = new Map<FileOut, string>()
  const hashes = new Map<FileOut, string>()
  const writtenDocs: string[] = []
  try {
    let batch: [string, PreparedSeed][] = []
    let batchBytes = 0
    const flush = () => {
      if (batch.length === 0) return
      const docs = batch
      s.db.transaction(() => { for (const [docName, seed] of docs) s.store.seedPrepared(docName, seed) }).immediate()
      for (const [docName] of docs) writtenDocs.push(docName)
      batch = []
      batchBytes = 0
    }
    let slice = Date.now()
    for (const f of plan.files) {
      if (f.cls.kind === 'text') {
        const id = randomUUID()
        textIds.set(f, id)
        batch.push([fileDocName(projectId, id, 1), DocStore.prepareSeed(f.cls.text)])
        batchBytes += f.bytes.byteLength
        if (batchBytes >= DOC_BATCH_BYTES) flush()
      } else {
        const hash = BlobStore.hashOf(f.bytes)
        await s.blobs.write(f.bytes, hash)
        hashes.set(f, hash)
      }
      if (Date.now() - slice >= SLICE_MS) { await nextTick(); slice = Date.now() }
    }
    flush()

    const now = Date.now()
    s.db.transaction(() => {
      s.db.prepare(`INSERT INTO projects (id, name, root_id, main_file_id, engine, tree_version, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 'pdflatex', 0, ?, ?)`).run(projectId, name, rootId, now, now)
      s.db.prepare(`INSERT INTO files (id, project_id, parent_id, name, kind, epoch, size, created_at, updated_at)
        VALUES (?, ?, NULL, '', 'folder', 1, NULL, ?, ?)`).run(rootId, projectId, now, now)
      s.db.prepare('INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)').run(projectId, user.id, 'owner', now)
      const folderIds = new Map<string, string>([['', rootId]])
      for (const path of plan.folders) {
        const slash = path.lastIndexOf('/')
        const parentId = folderIds.get(slash < 0 ? '' : path.slice(0, slash))!
        folderIds.set(path, insertNode(s, projectId, { parentId, name: slash < 0 ? path : path.slice(slash + 1), kind: 'folder' }).id)
      }
      let mainId: string | null = null
      for (const f of plan.files) {
        const parentId = folderIds.get(f.parent)!
        let row
        if (f.cls.kind === 'text') {
          row = insertNode(s, projectId, { id: textIds.get(f)!, parentId, name: f.name, kind: 'text', text: f.cls.text, docWritten: true })
        } else {
          const blobHash = hashes.get(f)!
          s.blobs.record(blobHash, f.bytes.byteLength)
          row = insertNode(s, projectId, { parentId, name: f.name, kind: 'binary', blobHash, size: f.bytes.byteLength })
        }
        if (f.path === plan.report.detectedMainFile) mainId = row.id
      }
      if (mainId !== null) s.db.prepare('UPDATE projects SET main_file_id = ? WHERE id = ?').run(mainId, projectId)
      audit(s.db, { actorId: user.id, projectId, action: 'project-create',
        detail: { name, import: true, files: plan.files.length, skipped: plan.report.skipped.length } })
    }).immediate()
  } catch (e) {
    if (writtenDocs.length > 0) {
      try {
        const del = s.db.prepare('DELETE FROM doc_state WHERE doc_name = ?')
        s.db.transaction(() => { for (const n of writtenDocs) del.run(n) }).immediate()
      } catch (cleanup) { console.error('[import] could not remove pre-written docs', cleanup) }
    }
    throw e
  }
  return { project: projectDetail(s.db, projectId, 'owner')!, report: plan.report }
}
