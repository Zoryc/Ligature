import { randomUUID } from 'node:crypto'
import { can, fileDocName, type Engine, type ProjectDetail, type Role, type UpdateProjectRequest } from '@ligature/shared'
import { audit } from '../audit.ts'
import { badRequest, forbidden, notFound } from '../errors.ts'
import { isUuid, type Services } from '../services.ts'
import type { DB } from '../db/index.ts'
import type { SessionUser } from '../auth/sessions.ts'
import { getFile, getProject, projectDetail, roleOf } from './repo.ts'

export const MAIN_TEMPLATE = String.raw`\documentclass{article}

\title{Untitled}
\author{}

\begin{document}
\maketitle

\section{Introduction}

\end{document}
`

export interface Access { projectId: string; role: Role }

/**
 * The caller's role in a live project. A project the caller cannot see (bad id, not a member,
 * deleted) is `404 not-found`, so its existence never leaks.
 */
export function requireAccess(db: DB, projectId: string | undefined, userId: string): Access {
  if (!isUuid(projectId)) throw notFound()
  const role = roleOf(db, projectId, userId)
  if (!role) throw notFound()
  return { projectId, role }
}

export function requireRole(a: Access, ok: (r: Role) => boolean): void {
  if (!ok(a.role)) throw forbidden()
}

/** Bump updated_at (and optionally tree_version); returns the new tree_version. */
export function touchProject(db: DB, projectId: string, treeChanged: boolean): number {
  const now = Date.now()
  const r = db.prepare(`UPDATE projects SET updated_at = ?, tree_version = tree_version + ? WHERE id = ?
    RETURNING tree_version AS v`).get(now, treeChanged ? 1 : 0, projectId) as { v: number }
  return r.v
}

export function validateProjectName(raw: string): string {
  const name = raw.trim()
  if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw badRequest('Project name: 1–120 characters, no control characters')
  }
  return name
}

/** Create a project with a root folder and a `main.tex` from the template; the caller is owner. */
export function createProject(s: Services, user: SessionUser, rawName: string): ProjectDetail {
  const name = validateProjectName(rawName)
  const projectId = randomUUID()
  const rootId = randomUUID()
  const mainId = randomUUID()
  const now = Date.now()
  s.db.transaction(() => {
    s.db.prepare(`INSERT INTO projects (id, name, root_id, main_file_id, engine, tree_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pdflatex', 0, ?, ?)`).run(projectId, name, rootId, mainId, now, now)
    const insFile = s.db.prepare(`INSERT INTO files (id, project_id, parent_id, name, kind, epoch, size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    insFile.run(rootId, projectId, null, '', 'folder', null, now, now)
    insFile.run(mainId, projectId, rootId, 'main.tex', 'text', Buffer.byteLength(MAIN_TEMPLATE), now, now)
    s.db.prepare('INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)')
      .run(projectId, user.id, 'owner', now)
    s.store.seed(fileDocName(projectId, mainId, 1), MAIN_TEMPLATE)
    audit(s.db, { actorId: user.id, projectId, action: 'project-create', detail: { name } })
  }).immediate()
  return projectDetail(s.db, projectId, 'owner')!
}

const ENGINE_VALUES: readonly Engine[] = ['pdflatex', 'xelatex', 'lualatex']

/** PATCH /projects/:id — name: owner; engine/mainFileId: owner or editor. */
export function updateProject(s: Services, a: Access, req: UpdateProjectRequest): ProjectDetail {
  if (req.name === undefined && req.engine === undefined && req.mainFileId === undefined) throw badRequest('nothing to update')
  if (req.name !== undefined && a.role !== 'owner') throw forbidden('Only the owner can rename the project')
  if (!can.edit(a.role)) throw forbidden()
  s.db.transaction(() => {
    if (req.name !== undefined) {
      s.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(validateProjectName(req.name), a.projectId)
    }
    if (req.engine !== undefined) {
      if (!ENGINE_VALUES.includes(req.engine)) throw badRequest('unknown engine')
      s.db.prepare('UPDATE projects SET engine = ? WHERE id = ?').run(req.engine, a.projectId)
    }
    if (req.mainFileId !== undefined) {
      const f = isUuid(req.mainFileId) ? getFile(s.db, req.mainFileId) : null
      if (!f || f.projectId !== a.projectId || f.deletedAt !== null || f.kind !== 'text' || !f.name.toLowerCase().endsWith('.tex')) {
        throw badRequest('mainFileId must be a live .tex text file of this project')
      }
      s.db.prepare('UPDATE projects SET main_file_id = ? WHERE id = ?').run(f.id, a.projectId)
    }
    touchProject(s.db, a.projectId, false)
  }).immediate()
  s.collab.broadcast(a.projectId, { type: 'project-changed' })
  return projectDetail(s.db, a.projectId, a.role)!
}

/** Soft delete (owner). Broadcasts `project-deleted`, then closes every socket of the project. */
export async function deleteProject(s: Services, user: SessionUser, a: Access): Promise<void> {
  if (a.role !== 'owner') throw forbidden()
  const p = getProject(s.db, a.projectId)
  if (!p) throw notFound()
  const now = Date.now()
  s.db.transaction(() => {
    s.db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, now, a.projectId)
    audit(s.db, { actorId: user.id, projectId: a.projectId, action: 'project-delete', detail: { name: p.name } })
  }).immediate()
  s.collab.broadcast(a.projectId, { type: 'project-deleted' })
  s.collab.closeProjectConnections(a.projectId, 'project-deleted')
  const docs = [...s.collab.hocuspocus.documents.keys()].filter(n => n.startsWith(`proj/${a.projectId}/`))
  await Promise.all(docs.map(n => s.collab.unloadDoc(n)))
}
