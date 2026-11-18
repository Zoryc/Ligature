import { randomBytes, randomUUID } from 'node:crypto'
import type { CreatedInvite, CreateInviteRequest, Invite, InvitePreview, Role } from '@ligature/shared'
import { audit } from '../audit.ts'
import { ApiError, forbidden, notFound } from '../errors.ts'
import { isUuid, type Services } from '../services.ts'
import { sha256, type SessionUser } from '../auth/sessions.ts'
import type { DB } from '../db/index.ts'
import type { Access } from './service.ts'

export const INVITE_DEFAULT_HOURS = 168
export const INVITE_MAX_HOURS = 720
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/ // 32 random bytes, base64url

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 }

interface InviteRow {
  id: string
  projectId: string
  role: 'editor' | 'viewer'
  createdBy: string
  createdByName: string
  createdAt: number
  expiresAt: number
  maxUses: number | null
  uses: number
  revokedAt: number | null
  projectName: string
  projectDeletedAt: number | null
}

const SELECT = `SELECT i.id, i.project_id AS projectId, i.role, i.created_by AS createdBy, u.display_name AS createdByName,
    i.created_at AS createdAt, i.expires_at AS expiresAt, i.max_uses AS maxUses, i.uses, i.revoked_at AS revokedAt,
    p.name AS projectName, p.deleted_at AS projectDeletedAt
  FROM invites i JOIN users u ON u.id = i.created_by JOIN projects p ON p.id = i.project_id`

const isActive = (r: InviteRow, now: number) =>
  r.revokedAt === null && r.expiresAt > now && (r.maxUses === null || r.uses < r.maxUses) && r.projectDeletedAt === null

/** `createdBy` is the creator's display name (the owner-facing list shows it as-is). */
const toInvite = (r: InviteRow): Invite => ({
  id: r.id, role: r.role, createdBy: r.createdByName, createdAt: r.createdAt, expiresAt: r.expiresAt, maxUses: r.maxUses, uses: r.uses,
})

/** An active invite for a raw token, or null (unknown / malformed / expired / revoked / used up / project deleted). */
export function findActiveInvite(db: DB, token: string | undefined): InviteRow | null {
  if (!token || !TOKEN_RE.test(token)) return null
  const r = db.prepare(`${SELECT} WHERE i.token_hash = ?`).get(sha256(token)) as InviteRow | undefined
  return r && isActive(r, Date.now()) ? r : null
}

const invalid = () => new ApiError(404, 'invite-invalid', 'This invite link is invalid, expired or used up')

export function createInvite(s: Services, actor: SessionUser, a: Access, req: CreateInviteRequest): CreatedInvite {
  if (a.role !== 'owner') throw forbidden()
  const token = randomBytes(32).toString('base64url')
  const id = randomUUID()
  const now = Date.now()
  const hours = req.expiresInHours ?? INVITE_DEFAULT_HOURS
  const expiresAt = now + Math.round(hours * 3600_000)
  const maxUses = req.maxUses ?? null
  s.db.transaction(() => {
    s.db.prepare(`INSERT INTO invites (id, project_id, token_hash, role, created_by, created_at, expires_at, max_uses)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, a.projectId, sha256(token), req.role, actor.id, now, expiresAt, maxUses)
    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'invite-create', detail: { inviteId: id, role: req.role, expiresAt, maxUses } })
  }).immediate()
  return { id, role: req.role, createdBy: actor.displayName, createdAt: now, expiresAt, maxUses, uses: 0, token }
}

export function listInvites(s: Services, a: Access): Invite[] {
  if (a.role !== 'owner') throw forbidden()
  const now = Date.now()
  return (s.db.prepare(`${SELECT} WHERE i.project_id = ? ORDER BY i.created_at DESC`).all(a.projectId) as InviteRow[])
    .filter(r => isActive(r, now)).map(toInvite)
}

export function revokeInvite(s: Services, actor: SessionUser, a: Access, inviteId: string | undefined): void {
  if (a.role !== 'owner') throw forbidden()
  if (!isUuid(inviteId)) throw notFound()
  s.db.transaction(() => {
    const r = s.db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL')
      .run(Date.now(), inviteId, a.projectId)
    if (r.changes === 0) {
      const exists = s.db.prepare('SELECT 1 FROM invites WHERE id = ? AND project_id = ?').get(inviteId, a.projectId)
      if (!exists) throw notFound()
      return // already revoked: idempotent
    }
    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'invite-revoke', detail: { inviteId } })
  }).immediate()
}

export function previewInvite(db: DB, token: string | undefined): InvitePreview {
  const r = findActiveInvite(db, token)
  if (!r) throw invalid()
  return { projectName: r.projectName, role: r.role, invitedBy: r.createdByName, expiresAt: r.expiresAt }
}

export interface Joined { projectId: string; /** role before (null = new member) and after */ before: Role | null; after: Role }

/**
 * Join `userId` to the invite's project. Synchronous: call inside a transaction (the check and
 * the `uses` increment are then atomic). If already a member, the higher role is kept and no use
 * is consumed. Throws `invite-invalid`.
 */
export function joinWithInvite(db: DB, userId: string, token: string | undefined): Joined {
  const inv = findActiveInvite(db, token)
  if (!inv) throw invalid()
  const cur = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(inv.projectId, userId) as { role: Role } | undefined
  if (cur) {
    if (RANK[inv.role] > RANK[cur.role]) {
      db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(inv.role, inv.projectId, userId)
      audit(db, { actorId: userId, projectId: inv.projectId, action: 'invite-accept', detail: { inviteId: inv.id, role: inv.role, upgrade: true } })
      audit(db, { actorId: userId, projectId: inv.projectId, action: 'member-role-change', detail: { userId, from: cur.role, to: inv.role, inviteId: inv.id } })
      return { projectId: inv.projectId, before: cur.role, after: inv.role }
    }
    return { projectId: inv.projectId, before: cur.role, after: cur.role }
  }
  const used = db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses)').run(inv.id)
  if (used.changes === 0) throw invalid()
  db.prepare('INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)')
    .run(inv.projectId, userId, inv.role, Date.now())
  audit(db, { actorId: userId, projectId: inv.projectId, action: 'invite-accept', detail: { inviteId: inv.id, role: inv.role } })
  audit(db, { actorId: userId, projectId: inv.projectId, action: 'member-add', detail: { userId, role: inv.role, inviteId: inv.id } })
  return { projectId: inv.projectId, before: null, after: inv.role }
}

/** Broadcast the effects of a join (after the transaction committed). */
export function announceJoin(s: Services, userId: string, j: Joined): void {
  if (j.before === j.after) return
  s.collab.broadcast(j.projectId, { type: 'members-changed' })
  if (j.before !== null) s.collab.closeUserConnections(userId, j.projectId, 'role-changed')
}

export function acceptInvite(s: Services, user: SessionUser, token: string | undefined): { projectId: string } {
  const j = s.db.transaction(() => joinWithInvite(s.db, user.id, token)).immediate()
  announceJoin(s, user.id, j)
  return { projectId: j.projectId }
}
