import type { AccountDeletionPreview, AccountDeletionResult, DeletionProject } from '@ligature/shared'
import { audit } from '../audit.ts'
import { ApiError, notFound } from '../errors.ts'
import type { DB } from '../db/index.ts'
import type { Services } from '../services.ts'
import { touchProject } from '../projects/service.ts'
import { countActiveAdmins, getUserById, type UserRow } from './users.ts'

/*
 * Deleting an account (docs/ACCOUNT-DELETION.md): immediate and permanent. Everything but the after-commit
 * broadcasts and socket closes happens in one immediate transaction, which re-checks what the preview showed.
 */

type SharedOwned = AccountDeletionPreview['sharedOwned'][number]

interface Plan {
  user: UserRow
  /** Live projects whose only member is the account. */
  deleted: DeletionProject[]
  /** Live projects it owns with other members, with whoever an admin deletion hands each to. */
  shared: SharedOwned[]
  /** Live projects it is an editor or viewer of (with other members). */
  left: string[]
  blocked: AccountDeletionPreview['blocked']
}

export type DeletedBy = 'self' | 'admin'

const ownsShared = () => new ApiError(409, 'owns-shared-projects', 'Transfer ownership of your shared projects first')
const lastAdmin = () => new ApiError(409, 'last-admin', 'This would leave the instance without an active administrator')

/** The longest-standing editor, else viewer: the member an admin deletion makes owner. */
function successor(db: DB, projectId: string, userId: string): SharedOwned['newOwner'] {
  return db.prepare(`SELECT m.user_id AS userId, u.display_name AS displayName
    FROM project_members m JOIN users u ON u.id = m.user_id
    WHERE m.project_id = ? AND m.user_id <> ? AND m.role IN ('editor', 'viewer')
    ORDER BY CASE m.role WHEN 'editor' THEN 0 ELSE 1 END, m.added_at, m.rowid LIMIT 1`)
    .get(projectId, userId) as SharedOwned['newOwner']
}

/** What deleting `userId` would do now. Reads only; `by` decides whether shared ownership blocks. */
function plan(db: DB, userId: string, by: DeletedBy): Plan {
  const user = getUserById(db, userId)
  if (!user) throw notFound()
  const rows = db.prepare(`SELECT p.id, p.name, m.role,
      (SELECT COUNT(*) FROM project_members o WHERE o.project_id = p.id) AS members
    FROM project_members m JOIN projects p ON p.id = m.project_id
    WHERE m.user_id = ? AND p.deleted_at IS NULL ORDER BY p.name, p.id`)
    .all(userId) as { id: string; name: string; role: string; members: number }[]
  const out: Plan = { user, deleted: [], shared: [], left: [], blocked: null }
  for (const r of rows) {
    if (r.members === 1) out.deleted.push({ id: r.id, name: r.name })
    else if (r.role === 'owner') out.shared.push({ id: r.id, name: r.name, newOwner: successor(db, r.id, userId) })
    else out.left.push(r.id)
  }
  // Last admin first: transferring projects alone would not unblock it.
  const activeAdmin = user.isAdmin && user.disabledAt === null
  if (activeAdmin && countActiveAdmins(db) <= 1) out.blocked = 'last-admin'
  else if (by === 'self' && out.shared.length > 0) out.blocked = 'owns-shared-projects'
  return out
}

/** GET /api/me/deletion and GET /api/admin/users/:id/deletion. Changes nothing. */
export function deletionPreview(db: DB, userId: string, by: DeletedBy): AccountDeletionPreview {
  const p = plan(db, userId, by)
  return { deletedProjects: p.deleted, sharedOwned: p.shared, leftProjects: p.left.length, blocked: p.blocked }
}

export interface DeleteRequest {
  userId: string
  by: DeletedBy
  /** Who is deleting: the account itself, or the admin. */
  actorId: string
  /** Admin route: must equal the account's current username. */
  confirmUsername?: string
  /**
   * Self route: the password hash the request's password was verified against (the verify is async, outside
   * the transaction); a password changed in between makes the confirmation stale.
   */
  verifiedHash?: string | null
}

/**
 * Personal data out of the audit log, entries kept (docs/ACCOUNT-DELETION.md "Audit log"). Only valid JSON
 * objects are touched, so one malformed row cannot fail the deletion.
 */
function scrubAudit(db: DB, user: UserRow): void {
  db.prepare(`UPDATE audit_log SET detail_json = json_remove(detail_json, '$.ip', '$.username', '$.displayName')
    WHERE json_valid(detail_json) AND json_type(detail_json) = 'object'
      AND (actor_id = ? OR json_extract(detail_json, '$.userId') = ?)`).run(user.id, user.id)
  // Failed logins typed its username, whoever's account they hit (or none).
  db.prepare(`UPDATE audit_log SET detail_json = json_remove(detail_json, '$.username', '$.ip')
    WHERE action = 'login-failure' AND json_valid(detail_json) AND json_type(detail_json) = 'object'
      AND lower(json_extract(detail_json, '$.username')) = lower(?)`).run(user.username)
}

interface Done { result: AccountDeletionResult; plan: Plan }

/** The whole database side, in one immediate transaction (re-checks everything the preview said). */
function deleteInTransaction(db: DB, req: DeleteRequest): Done {
  return db.transaction((): Done => {
    const p = plan(db, req.userId, req.by)
    if (req.confirmUsername !== undefined && req.confirmUsername !== p.user.username) {
      throw new ApiError(400, 'confirm-mismatch', 'Type the account\'s username to confirm')
    }
    if (req.verifiedHash !== undefined && req.verifiedHash !== p.user.passwordHash) {
      throw new ApiError(403, 'wrong-password', 'Wrong password')
    }
    if (p.blocked === 'last-admin') throw lastAdmin()
    if (p.blocked === 'owns-shared-projects') throw ownsShared()

    const now = Date.now()
    const softDelete = db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    for (const d of p.deleted) {
      softDelete.run(now, now, d.id)
      // The name is what a purged project is later known by in the audit page (audit.ts purgedName).
      audit(db, { actorId: req.actorId, projectId: d.id, action: 'project-delete', detail: { name: d.name, reason: 'account-deleted' } })
    }
    const promote = db.prepare(`UPDATE project_members SET role = 'owner' WHERE project_id = ? AND user_id = ?`)
    for (const s of p.shared) {
      promote.run(s.id, s.newOwner.userId)
      touchProject(db, s.id, false)
      audit(db, {
        actorId: req.actorId, projectId: s.id, action: 'ownership-transfer',
        detail: { from: p.user.id, to: s.newOwner.userId, reason: 'account-deleted' },
      })
    }
    for (const id of p.left) touchProject(db, id, false)

    // invites.created_by references users without ON DELETE: they go first.
    db.prepare('DELETE FROM invites WHERE created_by = ?').run(p.user.id)
    scrubAudit(db, p.user)
    // Sessions and memberships (also of its soft-deleted projects) cascade.
    db.prepare('DELETE FROM users WHERE id = ?').run(p.user.id)

    const result: AccountDeletionResult = {
      projectsDeleted: p.deleted.length, ownershipTransferred: p.shared.length, projectsLeft: p.left.length,
    }
    audit(db, { actorId: req.actorId, action: 'account.delete', detail: { userId: p.user.id, by: req.by, ...result } })
    return { result, plan: p }
  }).immediate()
}

/** Tell everyone else, after the commit (docs/ACCOUNT-DELETION.md "What happens"). */
async function announce(s: Services, userId: string, p: Plan): Promise<void> {
  // Its own sockets first, with the reason that sends its browsers to the login page (not "project deleted").
  s.collab.closeUserConnections(userId, null, 'session-ended')
  for (const d of p.deleted) {
    s.collab.broadcast(d.id, { type: 'project-deleted' })
    s.collab.closeProjectConnections(d.id, 'project-deleted')
  }
  for (const id of p.left) {
    s.collab.broadcast(id, { type: 'access-revoked', userId })
    s.collab.broadcast(id, { type: 'members-changed' })
  }
  for (const o of p.shared) {
    s.collab.broadcast(o.id, { type: 'access-revoked', userId })
    s.collab.broadcast(o.id, { type: 'members-changed' })
    s.collab.broadcast(o.id, { type: 'project-changed' })
    // The new owner's open sockets still carry the old role: reconnecting picks up 'owner'.
    s.collab.closeUserConnections(o.newOwner.userId, o.id, 'role-changed')
  }
  const prefixes = p.deleted.map(d => `proj/${d.id}/`)
  const docs = [...s.collab.hocuspocus.documents.keys()].filter(n => prefixes.some(x => n.startsWith(x)))
  await Promise.all(docs.map(n => s.collab.unloadDoc(n)))
}

/** DELETE /api/me and DELETE /api/admin/users/:id, once the route has checked the confirmation. */
export async function deleteAccount(s: Services, req: DeleteRequest): Promise<AccountDeletionResult> {
  const done = deleteInTransaction(s.db, req)
  await announce(s, req.userId, done.plan)
  return done.result
}
