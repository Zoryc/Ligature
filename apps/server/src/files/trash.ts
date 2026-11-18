import { can, fileDocName, type FileKind, type RestoreRequest, type TrashEntry, type TreeEntry } from '@ligature/shared'
import { audit } from '../audit.ts'
import { badRequest, forbidden, notFound } from '../errors.ts'
import { isUuid, type Services } from '../services.ts'
import type { DB } from '../db/index.ts'
import type { SessionUser } from '../auth/sessions.ts'
import { getProject, liveFiles, toTreeEntry, type FileRow } from '../projects/repo.ts'
import { requireRole, touchProject, type Access } from '../projects/service.ts'
import { extensionOf } from './classify.ts'
import { assertCapacity, assertPathsValid, requireFolder } from './tree.ts'

/*
 * The trash can (docs/M2.md §1). Deleted rows stay in `files` with `deleted_at`; everything removed by
 * one deletion shares a `delete_batch`. The batch's top item is the row whose parent is not in the batch.
 */

interface TrashRow {
  id: string
  parentId: string | null
  name: string
  kind: FileKind
  epoch: number
  blobHash: string | null
  size: number | null
  deletedAt: number | null
  deletedBy: string | null
  batch: string | null
  orphan: number
  wasMain: number
}

const COLS = `id, parent_id AS parentId, name, kind, epoch, blob_hash AS blobHash, size, deleted_at AS deletedAt,
  deleted_by AS deletedBy, delete_batch AS batch, trash_orphan AS orphan, was_main AS wasMain`

/** Every row of a project, live and deleted (the parent chain of deleted rows runs through both). */
function allRows(db: DB, projectId: string): TrashRow[] {
  return db.prepare(`SELECT ${COLS} FROM files WHERE project_id = ?`).all(projectId) as TrashRow[]
}

const toFileRow = (r: TrashRow, projectId: string): FileRow => ({
  id: r.id, projectId, parentId: r.parentId, name: r.name, kind: r.kind, epoch: r.epoch,
  blobHash: r.blobHash, size: r.size, deletedAt: r.deletedAt,
})

interface Batch { id: string; top: TrashRow; rows: TrashRow[] }

function batchesOf(rows: TrashRow[]): Map<string, Batch> {
  const byBatch = new Map<string, TrashRow[]>()
  for (const r of rows) {
    if (r.deletedAt === null || r.batch === null) continue
    const list = byBatch.get(r.batch)
    if (list) list.push(r)
    else byBatch.set(r.batch, [r])
  }
  const out = new Map<string, Batch>()
  for (const [id, list] of byBatch) {
    const ids = new Set(list.map(r => r.id))
    // The top: its parent is outside the batch (or was purged).
    const top = list.find(r => r.orphan === 1 || r.parentId === null || !ids.has(r.parentId))
    if (top) out.set(id, { id, top, rows: list })
  }
  return out
}

/** The batch whose top item is `fileId`, or 404. */
function requireBatchTop(rows: TrashRow[], fileId: string | undefined): Batch {
  if (!isUuid(fileId)) throw notFound()
  const row = rows.find(r => r.id === fileId)
  if (!row || row.deletedAt === null || row.batch === null) throw notFound()
  const b = batchesOf(rows.filter(r => r.batch === row.batch)).get(row.batch)
  if (!b || b.top.id !== row.id) throw notFound()
  return b
}

/**
 * Path the item had when it was deleted: its parent chain (deleted rows are frozen; live ancestors may
 * have been renamed since). If a parent was purged meanwhile, what is known is prefixed with `…/`.
 */
function originalPath(byId: Map<string, TrashRow>, row: TrashRow): string {
  const parts = [row.name]
  for (let cur = row, depth = 0; depth < 64; depth++) {
    if (cur.orphan === 1) return `…/${parts.reverse().join('/')}`
    const parent = cur.parentId === null ? undefined : byId.get(cur.parentId)
    if (!parent) return `…/${parts.reverse().join('/')}`
    if (parent.parentId === null) return parts.reverse().join('/')
    parts.push(parent.name)
    cur = parent
  }
  return `…/${parts.reverse().join('/')}`
}

/** GET /projects/:id/trash — one entry per batch, newest first. */
export function listTrash(s: Services, a: Access): TrashEntry[] {
  const rows = allRows(s.db, a.projectId)
  const byId = new Map(rows.map(r => [r.id, r]))
  const textBytes = new Map((s.db.prepare(`SELECT f.id, length(CAST(ds.text AS BLOB)) AS bytes FROM files f
      JOIN doc_state ds ON ds.doc_name = 'proj/' || f.project_id || '/file/' || f.id || '/g' || f.epoch
      WHERE f.project_id = ? AND f.deleted_at IS NOT NULL AND f.kind = 'text'`).all(a.projectId) as { id: string; bytes: number }[])
    .map(r => [r.id, r.bytes]))
  const names = new Map((s.db.prepare(`SELECT DISTINCT u.id, u.display_name AS name FROM users u
      JOIN files f ON f.deleted_by = u.id WHERE f.project_id = ? AND f.deleted_at IS NOT NULL`).all(a.projectId) as { id: string; name: string }[])
    .map(u => [u.id, u.name]))
  const out: TrashEntry[] = []
  for (const b of batchesOf(rows).values()) {
    const files = b.rows.filter(r => r.kind !== 'folder')
    const size = files.reduce((n, r) => n + (r.kind === 'text' ? textBytes.get(r.id) ?? r.size ?? 0 : r.size ?? 0), 0)
    const deletedAt = b.top.deletedAt!
    out.push({
      id: b.top.id, name: b.top.name, kind: b.top.kind, originalPath: originalPath(byId, b.top),
      deletedAt, deletedBy: (b.top.deletedBy && names.get(b.top.deletedBy)) ?? '',
      fileCount: files.length, size, expiresAt: deletedAt + s.limits.trashRetentionMs,
    })
  }
  return out.sort((x, y) => y.deletedAt - x.deletedAt || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
}

/**
 * `name (restored)`, `name (restored 2)`, … — the suffix goes before the extension of files
 * (`main (restored).tex`). Returns `name` itself when it is free.
 */
export function restoredName(name: string, kind: FileKind, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const ext = kind === 'folder' ? '' : extensionOf(name) === '' ? '' : name.slice(name.lastIndexOf('.'))
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; i < 10_000; i++) {
    const suffix = i === 1 ? ' (restored)' : ` (restored ${i})`
    const candidate = `${stem.slice(0, Math.max(1, 255 - suffix.length - ext.length))}${suffix}${ext}`
    if (!taken(candidate)) return candidate
  }
  throw badRequest('Too many restored copies with this name')
}

/** POST /projects/:id/trash/:fileId/restore — restores the whole batch in one transaction. */
export function restoreFromTrash(s: Services, actor: SessionUser, a: Access, fileId: string | undefined, req: RestoreRequest): TreeEntry {
  requireRole(a, can.edit)
  const res = s.db.transaction(() => {
    const rows = allRows(s.db, a.projectId)
    const b = requireBatchTop(rows, fileId)
    const live = rows.filter(r => r.deletedAt === null).map(r => toFileRow(r, a.projectId))
    const root = live.find(r => r.parentId === null)
    if (!root) throw notFound()
    let target: FileRow
    if (req.parentId !== undefined) target = requireFolder(live, req.parentId)
    else {
      const orig = b.top.orphan === 1 ? undefined : live.find(r => r.id === b.top.parentId && r.kind === 'folder')
      target = orig ?? root
    }
    const siblings = new Set(live.filter(r => r.parentId === target.id).map(r => r.name.toLowerCase()))
    const name = restoredName(b.top.name, b.top.kind, n => siblings.has(n.toLowerCase()))

    const restored = b.rows.map(r => toFileRow(r.id === b.top.id ? { ...r, parentId: target.id, name } : r, a.projectId))
    assertPathsValid([...live, ...restored], restored.map(r => r.id))
    const binaryBytes = restored.reduce((n, r) => n + (r.kind === 'binary' ? r.size ?? 0 : 0), 0)
    assertCapacity(s, live, restored.length, binaryBytes)

    const now = Date.now()
    // Rename/move first, while the row is still deleted (the unique-name index only covers live rows).
    s.db.prepare('UPDATE files SET name = ?, parent_id = ? WHERE id = ?').run(name, target.id, b.top.id)
    s.db.prepare(`UPDATE files SET deleted_at = NULL, deleted_by = NULL, delete_batch = NULL, trash_orphan = 0, was_main = 0,
      updated_at = ? WHERE project_id = ? AND delete_batch = ?`).run(now, a.projectId, b.id)

    // The main file comes back if it was deleted with this batch and no other main file was chosen since.
    const wasMain = b.rows.find(r => r.wasMain === 1 && r.kind === 'text')
    const mainRestored = wasMain !== undefined && s.db.prepare('UPDATE projects SET main_file_id = ? WHERE id = ? AND main_file_id IS NULL')
      .run(wasMain.id, a.projectId).changes > 0

    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'file.restore',
      detail: { fileId: b.top.id, name, parentId: target.id, count: restored.length } })
    return { top: { ...restored.find(r => r.id === b.top.id)!, deletedAt: null }, mainRestored, treeVersion: touchProject(s.db, a.projectId, true) }
  }).immediate()
  s.collab.broadcast(a.projectId, { type: 'tree-changed', treeVersion: res.treeVersion })
  s.collab.broadcast(a.projectId, { type: 'trash-changed' })
  if (res.mainRestored) s.collab.broadcast(a.projectId, { type: 'project-changed' })
  return toTreeEntry(res.top)
}

/** Doc rows of a file, all epochs (`proj/<p>/file/<f>/g<n>`), via an index-friendly range. */
function purgeDocs(db: DB, projectId: string, fileId: string): void {
  const prefix = `proj/${projectId}/file/${fileId}/g`
  const hi = `${prefix.slice(0, -1)}h`
  db.prepare('DELETE FROM doc_state WHERE doc_name >= ? AND doc_name < ?').run(prefix, hi)
  db.prepare('DELETE FROM doc_updates WHERE doc_name >= ? AND doc_name < ?').run(prefix, hi)
}

interface Purged { textDocs: string[]; count: number }

/**
 * Remove one batch for good (inside a transaction): rows, doc_state, doc_updates. Blobs stay for the
 * M3 garbage collector. Trash rows of other batches whose parent is purged are re-attached to the root
 * and flagged, so their original path shows as `…/name`.
 */
function purgeBatchRows(db: DB, projectId: string, batchId: string): Purged {
  const rows = db.prepare(`SELECT id, kind, epoch FROM files WHERE project_id = ? AND delete_batch = ? AND deleted_at IS NOT NULL`)
    .all(projectId, batchId) as { id: string; kind: FileKind; epoch: number }[]
  if (rows.length === 0) return { textDocs: [], count: 0 }
  const ids = JSON.stringify(rows.map(r => r.id))
  const root = getProject(db, projectId)?.rootId
  db.prepare(`UPDATE files SET parent_id = ?, trash_orphan = 1 WHERE project_id = ? AND deleted_at IS NOT NULL
      AND delete_batch IS NOT ? AND parent_id IN (SELECT value FROM json_each(?))`).run(root ?? null, projectId, batchId, ids)
  for (const r of rows) if (r.kind === 'text') purgeDocs(db, projectId, r.id)
  db.prepare('DELETE FROM files WHERE project_id = ? AND delete_batch = ? AND deleted_at IS NOT NULL').run(projectId, batchId)
  return { textDocs: rows.filter(r => r.kind === 'text').map(r => fileDocName(projectId, r.id, r.epoch)), count: rows.length }
}

/**
 * Deleted docs are unloaded at delete time; should one still be loaded (an unload racing the purge),
 * unload it and drop the state its unload compacted.
 */
async function dropLoadedDocs(s: Services, docs: string[]): Promise<void> {
  for (const d of docs) {
    if (!s.collab.liveDoc(d)) continue
    s.collab.closeDocConnections(d, 'file-deleted')
    await s.collab.unloadDoc(d)
    const ref = /^proj\/([^/]+)\/file\/([^/]+)\//.exec(d)
    if (ref) purgeDocs(s.db, ref[1]!, ref[2]!)
  }
}

/** DELETE /projects/:id/trash/:fileId — purge one batch (owner/editor). */
export async function purgeFromTrash(s: Services, actor: SessionUser, a: Access, fileId: string | undefined): Promise<void> {
  requireRole(a, can.edit)
  const res = s.db.transaction(() => {
    const b = requireBatchTop(allRows(s.db, a.projectId), fileId)
    const purged = purgeBatchRows(s.db, a.projectId, b.id)
    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'file.purge', detail: { fileId: b.top.id, name: b.top.name, count: purged.count } })
    return purged
  }).immediate()
  s.collab.broadcast(a.projectId, { type: 'trash-changed' })
  await dropLoadedDocs(s, res.textDocs)
}

/** DELETE /projects/:id/trash — purge every batch (owner only). */
export async function emptyTrash(s: Services, actor: SessionUser, a: Access): Promise<void> {
  if (a.role !== 'owner') throw forbidden('Only the owner can empty the trash')
  const res = s.db.transaction(() => {
    const rows = s.db.prepare('SELECT id, kind, epoch, delete_batch AS batch FROM files WHERE project_id = ? AND deleted_at IS NOT NULL')
      .all(a.projectId) as { id: string; kind: FileKind; epoch: number; batch: string | null }[]
    for (const r of rows) if (r.kind === 'text') purgeDocs(s.db, a.projectId, r.id)
    // Live rows never point at deleted ones, so all deleted rows can go in one statement.
    s.db.prepare('DELETE FROM files WHERE project_id = ? AND deleted_at IS NOT NULL').run(a.projectId)
    const batches = new Set(rows.map(r => r.batch ?? r.id)).size
    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'trash.empty', detail: { batches, count: rows.length } })
    return rows.filter(r => r.kind === 'text').map(r => fileDocName(a.projectId, r.id, r.epoch))
  }).immediate()
  s.collab.broadcast(a.projectId, { type: 'trash-changed' })
  await dropLoadedDocs(s, res)
}

/**
 * Retention: purge every batch deleted at least `trashRetentionMs` before `now` (all projects).
 * Returns the number of batches purged.
 */
export async function sweepTrash(s: Services, now: number = Date.now()): Promise<number> {
  const cutoff = now - s.limits.trashRetentionMs
  const due = s.db.prepare(`SELECT project_id AS projectId, delete_batch AS batch FROM files
      WHERE deleted_at IS NOT NULL AND delete_batch IS NOT NULL
      GROUP BY project_id, delete_batch HAVING MIN(deleted_at) <= ?`).all(cutoff) as { projectId: string; batch: string }[]
  const projects = new Set<string>()
  const docs: string[] = []
  for (const d of due) {
    const purged = s.db.transaction(() => {
      const p = purgeBatchRows(s.db, d.projectId, d.batch)
      if (p.count > 0) audit(s.db, { actorId: null, projectId: d.projectId, action: 'file.purge', detail: { batch: d.batch, count: p.count, reason: 'expired' } })
      return p
    }).immediate()
    if (purged.count > 0) projects.add(d.projectId)
    docs.push(...purged.textDocs)
  }
  for (const p of projects) s.collab.broadcast(p, { type: 'trash-changed' })
  await dropLoadedDocs(s, docs)
  return due.length
}
