import type { Role } from '@ligature/shared'
import { audit } from '../audit.ts'
import { ApiError, badRequest, forbidden, notFound } from '../errors.ts'
import { isUuid, type Services } from '../services.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Access } from './service.ts'
import { touchProject } from './service.ts'

function memberRole(s: Services, projectId: string, userId: string): Role | null {
  const r = s.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId) as { role: Role } | undefined
  return r?.role ?? null
}

function requireTarget(s: Services, projectId: string, userId: string | undefined): { userId: string; role: Role } {
  if (!isUuid(userId)) throw notFound()
  const role = memberRole(s, projectId, userId)
  if (!role) throw notFound()
  return { userId, role }
}

/** PATCH /projects/:id/members/:userId (owner). The owner cannot change their own role. */
export function updateMemberRole(s: Services, actor: SessionUser, a: Access, targetId: string | undefined, role: 'editor' | 'viewer'): void {
  if (a.role !== 'owner') throw forbidden()
  if (targetId === actor.id) throw new ApiError(409, 'owner-immutable', 'Transfer ownership instead')
  const t = requireTarget(s, a.projectId, targetId)
  if (t.role === role) return
  s.db.transaction(() => {
    s.db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(role, a.projectId, t.userId)
    touchProject(s.db, a.projectId, false)
    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'member-role-change', detail: { userId: t.userId, from: t.role, to: role } })
  }).immediate()
  s.collab.broadcast(a.projectId, { type: 'members-changed' })
  // Revocation is immediate: reconnects re-run onAuthenticate and pick up the new role.
  s.collab.closeUserConnections(t.userId, a.projectId, 'role-changed')
}

/** DELETE /projects/:id/members/:userId — the owner removes someone, or a member leaves. */
export function removeMember(s: Services, actor: SessionUser, a: Access, targetId: string | undefined): void {
  const self = targetId === actor.id
  if (self && a.role === 'owner') throw new ApiError(409, 'owner-must-transfer', 'Transfer ownership before leaving')
  if (!self && a.role !== 'owner') throw forbidden()
  const t = requireTarget(s, a.projectId, targetId)
  if (t.role === 'owner') throw new ApiError(409, 'owner-immutable')
  s.db.transaction(() => {
    s.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(a.projectId, t.userId)
    touchProject(s.db, a.projectId, false)
    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'member-remove', detail: { userId: t.userId, role: t.role, left: self } })
  }).immediate()
  s.collab.broadcast(a.projectId, { type: 'access-revoked', userId: t.userId })
  s.collab.broadcast(a.projectId, { type: 'members-changed' })
  s.collab.closeUserConnections(t.userId, a.projectId, 'access-revoked')
}

/** POST /projects/:id/transfer (owner). Target must already be a member; the old owner becomes editor. */
export function transferOwnership(s: Services, actor: SessionUser, a: Access, targetId: string): void {
  if (a.role !== 'owner') throw forbidden()
  if (targetId === actor.id) throw badRequest('You already own this project')
  const t = requireTarget(s, a.projectId, targetId)
  s.db.transaction(() => {
    const upd = s.db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?')
    upd.run('editor', a.projectId, actor.id)
    upd.run('owner', a.projectId, t.userId)
    touchProject(s.db, a.projectId, false)
    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'ownership-transfer', detail: { from: actor.id, to: t.userId } })
  }).immediate()
  s.collab.broadcast(a.projectId, { type: 'members-changed' })
  s.collab.broadcast(a.projectId, { type: 'project-changed' })
  s.collab.closeUserConnections(t.userId, a.projectId, 'role-changed')
  s.collab.closeUserConnections(actor.id, a.projectId, 'role-changed')
}
