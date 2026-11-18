import { randomUUID } from 'node:crypto'
import { can, fileDocName, isValidName, isValidRelPath, type CreateFileRequest, type TreeEntry, type UpdateFileRequest } from '@ligature/shared'
import { audit } from '../audit.ts'
import { ApiError, badRequest, notFound } from '../errors.ts'
import { isUuid, type Services } from '../services.ts'
import type { DB } from '../db/index.ts'
import type { SessionUser } from '../auth/sessions.ts'
import { liveFiles, nodePaths, toTreeEntry, type FileRow } from '../projects/repo.ts'
import { requireRole, touchProject, type Access } from '../projects/service.ts'
import { MAX_TEXT_BYTES, normalizeNewlines } from './classify.ts'

/*
 * File-tree operations (docs/M1.md §4). Each runs in one SQLite transaction, bumps
 * projects.tree_version + updated_at, then broadcasts `tree-changed`.
 */

export const nameTaken = () => new ApiError(409, 'name-taken', 'A file or folder with that name already exists here')
export const tooLarge = (what = 'File') => new ApiError(413, 'too-large', `${what} is too large`)

/** Live, non-root node of this project, or 404. */
export function requireNode(rows: FileRow[], fileId: string | undefined): FileRow {
  if (!isUuid(fileId)) throw notFound()
  const f = rows.find(r => r.id === fileId)
  if (!f) throw notFound()
  return f
}

/** The target parent must be a live folder of the same project. */
export function requireFolder(rows: FileRow[], parentId: string | undefined | null): FileRow {
  const p = isUuid(parentId) ? rows.find(r => r.id === parentId) : undefined
  if (!p || p.kind !== 'folder') throw badRequest('parentId must be a live folder of this project')
  return p
}

export function validName(name: string): string {
  if (!isValidName(name)) throw badRequest('Invalid name')
  return name
}

/**
 * Live sibling with the same name. Compared case-insensitively: projects are materialised on
 * case-insensitive filesystems too (Windows, macOS), where `Main.tex` and `main.tex` would collide.
 */
export function siblingNamed(rows: FileRow[], parentId: string, name: string, exceptId?: string): FileRow | null {
  const n = name.toLowerCase()
  return rows.find(r => r.parentId === parentId && r.id !== exceptId && r.name.toLowerCase() === n) ?? null
}

/** Every path in the (hypothetical) tree must pass the compiler's limits (depth 32, 1024 chars). */
export function assertPathsValid(rows: Pick<FileRow, 'id' | 'parentId' | 'name'>[], ids: Iterable<string>): void {
  const paths = nodePaths(rows)
  for (const id of ids) {
    const p = paths.get(id)
    if (p === undefined || !isValidRelPath(p)) throw badRequest('Path too long or nested too deeply (max 1024 characters, 32 levels)')
  }
}

/** Per-project limits: live node count and live binary bytes. */
export function assertCapacity(s: Services, rows: FileRow[], addNodes: number, addBinaryBytes: number): void {
  const nodes = rows.length - 1 // root excluded
  const binary = rows.reduce((n, r) => n + (r.kind === 'binary' ? r.size ?? 0 : 0), 0)
  if (nodes + addNodes > s.limits.maxFiles || binary + addBinaryBytes > s.limits.maxBinaryBytes) {
    throw new ApiError(413, 'project-too-large', `Projects are limited to ${s.limits.maxFiles} files and ${Math.round(s.limits.maxBinaryBytes / 1048576)} MB of binary files`)
  }
}

export interface NewNode {
  parentId: string; name: string; kind: 'folder' | 'text' | 'binary'; text?: string; blobHash?: string; size?: number
  /** Pre-assigned id (default: a new one). */
  id?: string
  /** Text docs: the doc state was already written under this id (bulk imports write it beforehand). */
  docWritten?: boolean
}

/** Insert a node (inside a transaction, after all checks). */
export function insertNode(s: Services, projectId: string, n: NewNode): FileRow {
  const id = n.id ?? randomUUID()
  const now = Date.now()
  const size = n.kind === 'binary' ? n.size ?? 0 : n.kind === 'text' ? Buffer.byteLength(n.text ?? '') : null
  s.db.prepare(`INSERT INTO files (id, project_id, parent_id, name, kind, epoch, blob_hash, size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, projectId, n.parentId, n.name, n.kind, n.blobHash ?? null, size, now, now)
  if (n.kind === 'text' && !n.docWritten) s.store.seed(fileDocName(projectId, id, 1), n.text ?? '')
  return { id, projectId, parentId: n.parentId, name: n.name, kind: n.kind, epoch: 1, blobHash: n.blobHash ?? null, size, deletedAt: null }
}

/** POST /projects/:id/files */
export function createNode(s: Services, a: Access, req: CreateFileRequest): TreeEntry {
  requireRole(a, can.edit)
  const name = validName(req.name)
  if (req.kind === 'folder' && req.content !== undefined) throw badRequest('Folders have no content')
  const text = req.kind === 'text' ? normalizeNewlines(req.content ?? '') : undefined
  if (text !== undefined && Buffer.byteLength(text) > MAX_TEXT_BYTES) throw tooLarge('Text file')
  const { row, treeVersion } = s.db.transaction(() => {
    const rows = liveFiles(s.db, a.projectId)
    const parent = requireFolder(rows, req.parentId)
    if (siblingNamed(rows, parent.id, name)) throw nameTaken()
    const id = 'new'
    assertPathsValid([...rows, { id, parentId: parent.id, name }], [id])
    assertCapacity(s, rows, 1, 0)
    s.history.beforeChange(a.projectId)
    const row = insertNode(s, a.projectId, { parentId: parent.id, name, kind: req.kind, ...(text !== undefined ? { text } : {}) })
    return { row, treeVersion: touchProject(s.db, a.projectId, true) }
  }).immediate()
  s.history.noteChange(a.projectId, a.userId)
  s.collab.broadcast(a.projectId, { type: 'tree-changed', treeVersion })
  return toTreeEntry(row)
}

/** PATCH /projects/:id/files/:fileId — rename and/or move. Never touches the Yjs doc. */
export function updateNode(s: Services, a: Access, fileId: string | undefined, req: UpdateFileRequest): TreeEntry {
  requireRole(a, can.edit)
  if (req.name === undefined && req.parentId === undefined) throw badRequest('nothing to update')
  const res = s.db.transaction(() => {
    const rows = liveFiles(s.db, a.projectId)
    const node = requireNode(rows, fileId)
    if (node.parentId === null) throw badRequest('The root folder cannot be renamed or moved')
    const name = req.name === undefined ? node.name : validName(req.name)
    const parentId = req.parentId === undefined ? node.parentId : requireFolder(rows, req.parentId).id
    if (name === node.name && parentId === node.parentId) return { row: node, treeVersion: null }

    // Cycle: the new parent must not be the node itself or one of its descendants.
    const byId = new Map(rows.map(r => [r.id, r]))
    for (let cur: FileRow | undefined = byId.get(parentId); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      if (cur.id === node.id) throw new ApiError(409, 'cycle', 'A folder cannot be moved into itself')
    }
    if (siblingNamed(rows, parentId, name, node.id)) throw nameTaken()

    const moved = rows.map(r => r.id === node.id ? { ...r, name, parentId } : r)
    assertPathsValid(moved, subtreeIds(moved, node.id))

    s.history.beforeChange(a.projectId)
    s.db.prepare('UPDATE files SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?').run(name, parentId, Date.now(), node.id)
    return { row: { ...node, name, parentId }, treeVersion: touchProject(s.db, a.projectId, true) }
  }).immediate()
  if (res.treeVersion !== null) {
    s.history.noteChange(a.projectId, a.userId)
    s.collab.broadcast(a.projectId, { type: 'tree-changed', treeVersion: res.treeVersion })
  }
  return toTreeEntry(res.row)
}

/** The node and all its descendants (among `rows`). */
export function subtreeIds(rows: Pick<FileRow, 'id' | 'parentId'>[], rootId: string): string[] {
  const children = new Map<string, string[]>()
  for (const r of rows) {
    if (r.parentId === null) continue
    const list = children.get(r.parentId)
    if (list) list.push(r.id)
    else children.set(r.parentId, [r.id])
  }
  const out: string[] = []
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    out.push(id)
    stack.push(...(children.get(id) ?? []))
  }
  return out
}

/**
 * DELETE /projects/:id/files/:fileId — soft delete (move to the trash) of the node and, for folders,
 * all live descendants, as one trash batch. Deleted text docs are compacted, unloaded and their connections closed
 * (`file-deleted`); onAuthenticate refuses them from now on. Clears the main file if deleted.
 */
export async function deleteNode(s: Services, actor: SessionUser, a: Access, fileId: string | undefined): Promise<void> {
  requireRole(a, can.edit)
  const res = s.db.transaction(() => {
    const rows = liveFiles(s.db, a.projectId)
    const node = requireNode(rows, fileId)
    if (node.parentId === null) throw badRequest('The root folder cannot be deleted')
    const ids = new Set(subtreeIds(rows, node.id))
    s.history.beforeChange(a.projectId)
    const now = Date.now()
    // One trash batch for the node and its live descendants (docs/M2.md §1).
    const batch = randomUUID()
    const del = s.db.prepare('UPDATE files SET deleted_at = ?, updated_at = ?, deleted_by = ?, delete_batch = ? WHERE id = ?')
    for (const id of ids) del.run(now, now, actor.id, batch, id)
    const main = (s.db.prepare('SELECT main_file_id AS id FROM projects WHERE id = ?').get(a.projectId) as { id: string | null }).id
    const mainCleared = main !== null && ids.has(main)
    if (mainCleared) {
      s.db.prepare('UPDATE projects SET main_file_id = NULL WHERE id = ?').run(a.projectId)
      s.db.prepare('UPDATE files SET was_main = 1 WHERE id = ?').run(main)
    }
    const docs = rows.filter(r => ids.has(r.id) && r.kind === 'text').map(r => fileDocName(a.projectId, r.id, r.epoch))
    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'file-delete', detail: { fileId: node.id, name: node.name, count: ids.size } })
    return { docs, mainCleared, treeVersion: touchProject(s.db, a.projectId, true) }
  }).immediate()
  // Same tick as the commit: no client update can slip in between.
  for (const d of res.docs) s.collab.closeDocConnections(d, 'file-deleted')
  s.history.noteChange(a.projectId, actor.id)
  s.collab.broadcast(a.projectId, { type: 'tree-changed', treeVersion: res.treeVersion })
  s.collab.broadcast(a.projectId, { type: 'trash-changed' })
  if (res.mainCleared) s.collab.broadcast(a.projectId, { type: 'project-changed' })
  await Promise.all(res.docs.map(d => s.collab.unloadDoc(d)))
}

/** Live rows of a project (re-exported for routes). */
export function treeRows(db: DB, projectId: string): FileRow[] {
  return liveFiles(db, projectId)
}
