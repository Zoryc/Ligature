import type { DB } from '../db/index.ts'
import type { FileKind, ProjectDetail, ProjectSummary, Role, TreeEntry } from '@ligature/shared'

export interface FileRow {
  id: string
  projectId: string
  parentId: string | null
  name: string
  kind: FileKind
  epoch: number
  blobHash: string | null
  deletedAt: number | null
}

const FILE_COLS = `id, project_id AS projectId, parent_id AS parentId, name, kind, epoch,
  blob_hash AS blobHash, deleted_at AS deletedAt`

export function roleOf(db: DB, projectId: string, userId: string): Role | null {
  const r = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
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
    SELECT p.id, p.name, m.role FROM projects p
    JOIN project_members m ON m.project_id = p.id
    WHERE m.user_id = ? ORDER BY p.name`).all(userId) as ProjectSummary[]
}

export function projectDetail(db: DB, projectId: string, role: Role): ProjectDetail | null {
  const p = db.prepare(`SELECT id, name, root_id AS rootId, main_file_id AS mainFileId,
      tree_version AS treeVersion FROM projects WHERE id = ?`).get(projectId) as
    Omit<ProjectDetail, 'role' | 'tree'> | undefined
  if (!p) return null
  const tree: TreeEntry[] = liveFiles(db, projectId).map(f => ({
    id: f.id, parentId: f.parentId, name: f.name, kind: f.kind,
    ...(f.kind === 'text' ? { epoch: f.epoch } : {}),
  }))
  return { ...p, role, tree }
}

export function projectEngine(db: DB, projectId: string): { engine: string; mainFileId: string | null } | null {
  return (db.prepare('SELECT engine, main_file_id AS mainFileId FROM projects WHERE id = ?')
    .get(projectId) as { engine: string; mainFileId: string | null } | undefined) ?? null
}

/**
 * Build relative paths for all live, non-folder files from the tree.
 * Paths are always derived from DB names (never from client input).
 */
export function filePaths(files: FileRow[]): Map<string, string> {
  const byId = new Map(files.map(f => [f.id, f]))
  const out = new Map<string, string>()
  const pathOf = (f: FileRow, depth = 0): string | null => {
    if (depth > 64) return null // cycle guard
    if (f.parentId === null) return '' // root
    const parent = byId.get(f.parentId)
    if (!parent) return null // parent deleted -> file not live
    const pp = pathOf(parent, depth + 1)
    if (pp === null) return null
    return pp === '' ? f.name : `${pp}/${f.name}`
  }
  for (const f of files) {
    if (f.kind === 'folder') continue
    const p = pathOf(f)
    if (p) out.set(f.id, p)
  }
  return out
}
