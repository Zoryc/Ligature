import { closeSync, openSync, readSync } from 'node:fs'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { fileDocName } from '@ligature/shared'
import { TEXT_KEY } from '../collab/docStore.ts'
import { extensionOf } from '../files/classify.ts'
import { filePaths, getProject, liveFiles } from '../projects/repo.ts'
import type { Services } from '../services.ts'

/*
 * GET /api/projects/:id/export.zip (docs/M2.md §5). The file list is taken in one synchronous pass; file
 * contents are read lazily while the response streams (text from the live doc if loaded, else the stored
 * text; binaries from the blob store in slices), so a request holds about one slice of one file in
 * memory, never the whole project. A client that stops reading is cut off after `idleMs`.
 */

/** Already-compressed formats are stored, not deflated again. */
const STORED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.gz', '.tgz', '.xz', '.bz2', '.7z'])

/** Bytes of a file pushed into the zip per step. */
const SLICE = 1024 * 1024

export type ExportItem = { path: string; docName: string } | { path: string; blobHash: string }

/** `<project name>.zip` with characters that are unsafe in file names replaced. */
export function exportFileName(projectName: string): string {
  const clean = projectName.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '')
  return `${clean || 'project'}.zip`
}

/** Snapshot of the project's live files (names only, no contents), sorted by path. */
export function exportItems(s: Services, projectId: string): ExportItem[] {
  const rows = liveFiles(s.db, projectId)
  const paths = filePaths(rows)
  const items: ExportItem[] = []
  for (const f of rows) {
    const path = paths.get(f.id)
    if (!path) continue
    if (f.kind === 'text') items.push({ path, docName: fileDocName(projectId, f.id, f.epoch) })
    else if (f.kind === 'binary' && f.blobHash) items.push({ path, blobHash: f.blobHash })
  }
  return items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Reads one item's bytes in slices; `next()` returns null at the end. */
interface Source { next(): Uint8Array | null; close(): void }

function textSource(s: Services, docName: string): Source {
  const live = s.collab.liveDoc(docName)
  let data: Buffer | null = Buffer.from(live ? live.getText(TEXT_KEY).toString() : s.store.storedText(docName)?.text ?? '', 'utf8')
  let off = 0
  let started = false
  return {
    next() {
      if (!data || (started && off >= data.byteLength)) { data = null; return null }
      started = true // an empty text still yields one (empty) piece
      const piece = data.subarray(off, off + SLICE)
      off += SLICE
      return piece
    },
    close() { data = null },
  }
}

function blobSource(s: Services, hash: string): Source | null {
  let fd: number | null
  try { fd = openSync(s.blobs.pathOf(hash), 'r') } catch { return null }
  let started = false
  const close = () => { if (fd !== null) { closeSync(fd); fd = null } }
  return {
    next() {
      if (fd === null) return null
      const buf = Buffer.allocUnsafe(SLICE)
      const n = readSync(fd, buf, 0, SLICE, null)
      if (n === 0 && started) { close(); return null }
      started = true
      return buf.subarray(0, n)
    },
    close,
  }
}

export interface ExportOptions {
  /** Abort the stream when the client has not asked for data for this long (ms). */
  idleMs?: number
  /** Called once when the stream ends for any reason (finished, cancelled, failed, idle). */
  onDone?: () => void
  /** Called when the idle timeout fires (e.g. to destroy the connection). */
  onIdle?: () => void
}

/** A zip of the project as a pull-based stream. */
export function exportZipStream(s: Services, projectId: string, opts: ExportOptions = {}): { name: string; stream: ReadableStream<Uint8Array> } {
  const project = getProject(s.db, projectId)
  const items = exportItems(s, projectId)
  let next = 0
  let zip: Zip
  let cur: { entry: ZipDeflate | ZipPassThrough; src: Source; pending: Uint8Array | null } | null = null
  let emitted = false
  let finished = false
  let idle: NodeJS.Timeout | null = null

  const done = () => {
    if (finished) return
    finished = true
    if (idle) clearTimeout(idle)
    cur?.src.close()
    cur = null
    opts.onDone?.()
  }
  const armIdle = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!opts.idleMs || finished) return
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      if (finished) return
      try { zip.terminate() } catch { /* already ended */ }
      try { controller.error(new Error('export idle timeout')) } catch { /* closed */ }
      done()
      opts.onIdle?.()
    }, opts.idleMs)
    idle.unref?.()
  }

  /** Open the next item that exists; false when there are none left. */
  const openNext = (): boolean => {
    for (;;) {
      const item = items[next++]
      if (!item) return false
      const src = 'docName' in item ? textSource(s, item.docName) : blobSource(s, item.blobHash)
      if (!src) { console.error(`[export] blob ${'blobHash' in item ? item.blobHash : '?'} missing for ${item.path}`); continue }
      const entry = 'docName' in item || !STORED.has(extensionOf(item.path))
        ? new ZipDeflate(item.path, { level: 6 })
        : new ZipPassThrough(item.path)
      zip.add(entry)
      cur = { entry, src, pending: src.next() }
      return true
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (finished) return
        if (err) { controller.error(err); done(); return }
        if (chunk.byteLength) { controller.enqueue(chunk); emitted = true }
        if (final) { controller.close(); emitted = true; done() }
      })
      armIdle(controller)
    },
    // Every pull must enqueue something (or close), otherwise a waiting reader would never be served:
    // keep feeding slices until the zip writer has produced output.
    pull(controller) {
      armIdle(controller)
      emitted = false
      try {
        while (!emitted && !finished) {
          if (!cur && !openNext()) { zip.end(); break }
          const c = cur!
          const piece = c.pending
          const after = piece === null ? null : c.src.next()
          if (piece === null) { c.entry.push(new Uint8Array(0), true); c.src.close(); cur = null; continue }
          c.entry.push(piece, after === null)
          if (after === null) { c.src.close(); cur = null } else c.pending = after
        }
      } catch (e) {
        try { zip.terminate() } catch { /* ignore */ }
        controller.error(e)
        done()
      }
    },
    cancel() {
      try { zip.terminate() } catch { /* ignore */ }
      done()
    },
  }, { highWaterMark: 1 })
  return { name: exportFileName(project?.name ?? 'project'), stream }
}
