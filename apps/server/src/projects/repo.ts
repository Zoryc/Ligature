import type { DB } from '../db/index.ts'
import type { Engine, FileKind, Member, ProjectDetail, ProjectSummary, Role, TreeEntry } from '@ligature/shared'

export interface FileRow {
  id: string
  projectId: string
  parentId: string | null
  name: string
  kind: FileKind
  epoch: number
  blobHash: string | null
  size: number | null
  deletedAt: number | null
}

const FILE_COLS = `id, project_id AS projectId, parent_id AS parentId, name, kind, epoch,
  blob_hash AS blobHash, size, deleted_at AS deletedAt`

export interface ProjectRow {
  id: string
  name: string
  rootId: string
  mainFileId: string | null
  engine: Engine
  treeVersion: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export function getProject(db: DB, projectId: string): ProjectRow | null {
  return (db.prepare(`SELECT id, name, root_id AS rootId, main_file_id AS mainFileId, engine,
      tree_version AS treeVersion, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
    FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined) ?? null
}

/** Role of a user in a live (not deleted) project, or null. */
export function roleOf(db: DB, projectId: string, userId: string): Role | null {
  const r = db.prepare(`SELECT m.role FROM project_members m JOIN projects p ON p.id = m.project_id
    WHERE m.project_id = ? AND m.user_id = ? AND p.deleted_at IS NULL`)
    .get(projectId, userId) as { role: Role } | undefined
  return r?.role ?? null
}

export function getFile(db: DB, fileId: string): FileRow | null {
  return (db.prepare(`SELECT ${FILE_COLS} FROM files WHERE id = ?`).get(fileId) as FileRow | undefined) ?? null
}

export function liveFiles(db: DB, projectId: string): FileRow[] {
  return db.prepare(`SELECT ${FILE_COLS} FROM files WHERE project_id = ? AND deleted_at IS NULL`)
    .all(projectId) as FileRow[]
}

export function listProjects(db: DB, userId: string): ProjectSummary[] {
  return db.prepare(`
    SELECT p.id, p.name, m.role, COALESCE(o.display_name, '') AS ownerName, p.updated_at AS updatedAt
    FROM projects p
    JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
    LEFT JOIN project_members om ON om.project_id = p.id AND om.role = 'owner'
    LEFT JOIN users o ON o.id = om.user_id
    WHERE p.deleted_at IS NULL
    ORDER BY p.updated_at DESC, p.name`).all(userId) as ProjectSummary[]
}

export function toTreeEntry(f: FileRow): TreeEntry {
  return {
    id: f.id, parentId: f.parentId, name: f.name, kind: f.kind,
    ...(f.kind === 'text' ? { epoch: f.epoch } : {}),
    ...(f.kind === 'binary' ? { size: f.size ?? 0 } : {}),
  }
}

export function projectDetail(db: DB, projectId: string, role: Role): ProjectDetail | null {
  const p = getProject(db, projectId)
  if (!p || p.deletedAt !== null) return null
  const tree = liveFiles(db, projectId).map(toTreeEntry)
  return {
    id: p.id, name: p.name, role, rootId: p.rootId, mainFileId: p.mainFileId,
    engine: p.engine, treeVersion: p.treeVersion, tree,
  }
}

export function projectEngine(db: DB, projectId: string): { engine: string; mainFileId: string | null } | null {
  return (db.prepare('SELECT engine, main_file_id AS mainFileId FROM projects WHERE id = ?')
    .get(projectId) as { engine: string; mainFileId: string | null } | undefined) ?? null
}

export function listMembers(db: DB, projectId: string): Member[] {
  return db.prepare(`SELECT u.id AS userId, u.username, u.display_name AS displayName, m.role
    FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.username`).all(projectId) as Member[]
}

/** Live projects a user is a member of. */
export function projectIdsOfUser(db: DB, userId: string): string[] {
  return (db.prepare(`SELECT m.project_id AS id FROM project_members m JOIN projects p ON p.id = m.project_id
    WHERE m.user_id = ? AND p.deleted_at IS NULL`).all(userId) as { id: string }[]).map(r => r.id)
}

/**
 * Build relative paths for all live, non-folder files from the tree.
 * Paths are always derived from DB names (never from client input).
 */
export function filePaths(files: FileRow[]): Map<string, string> {
  const all = nodePaths(files)
  const out = new Map<string, string>()
  for (const f of files) {
    if (f.kind === 'folder') continue
    const p = all.get(f.id)
    if (p) out.set(f.id, p)
  }
  return out
}

/** Relative path of every reachable node (root = ''). Nodes whose ancestors are missing are omitted. */
export function nodePaths(files: Pick<FileRow, 'id' | 'parentId' | 'name'>[]): Map<string, string> {
  const byId = new Map(files.map(f => [f.id, f]))
  const memo = new Map<string, string | null>()
  const pathOf = (f: Pick<FileRow, 'id' | 'parentId' | 'name'>, depth = 0): string | null => {
    const m = memo.get(f.id)
    if (m !== undefined) return m
    if (depth > 64) return null // cycle guard
    let r: string | null
    if (f.parentId === null) r = ''
    else {
      const parent = byId.get(f.parentId)
      const pp = parent ? pathOf(parent, depth + 1) : null
      r = pp === null ? null : pp === '' ? f.name : `${pp}/${f.name}`
    }
    memo.set(f.id, r)
    return r
  }
  const out = new Map<string, string>()
  for (const f of files) {
    const p = pathOf(f)
    if (p !== null) out.set(f.id, p)
  }
  return out
}
