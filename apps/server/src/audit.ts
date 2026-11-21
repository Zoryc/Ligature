import { AUDIT_CATEGORIES, type AuditCategory, type AuditEntryView, type AuditPage, type AuditPerson } from '@ligature/shared'
import type { DB } from './db/index.ts'

export type AuditAction =
  | 'signup' | 'login' | 'login-failure' | 'logout-all'
  | 'admin-user-create' | 'admin-user-update' | 'settings-update'
  | 'member-add' | 'member-role-change' | 'member-remove' | 'ownership-transfer'
  | 'invite-create' | 'invite-revoke' | 'invite-accept'
  | 'project-create' | 'project-delete' | 'file-delete'
  // M2 (names as in docs/M2.md §1)
  | 'file.restore' | 'file.purge' | 'trash.empty'
  // M3 (docs/M3.md §2)
  | 'version.create' | 'version.label' | 'version.restore'
  // M3 (docs/M3.md §3–§5)
  | 'doc.rebuild' | 'gc.run' | 'project.purge' | 'storage.view'
  // Folio UI: a shared project setting changed (detail: { key, from, to } as shown to people)
  | 'project.setting'
  // `ligature restore` (maintenance/restore.ts): written into the restored database
  | 'backup.restore'
  // docs/ACCOUNT-DELETION.md (detail: { userId, by, projectsDeleted, ownershipTransferred, projectsLeft })
  | 'account.delete'

export interface AuditEntry {
  actorId: string | null
  projectId?: string | null
  action: AuditAction
  detail?: Record<string, unknown>
}

/** Append one audit-log row. Never store secrets (passwords, tokens) in `detail`. */
export function audit(db: DB, e: AuditEntry): void {
  db.prepare('INSERT INTO audit_log (actor_id, project_id, action, detail_json, at) VALUES (?, ?, ?, ?, ?)')
    .run(e.actorId, e.projectId ?? null, e.action, e.detail ? JSON.stringify(e.detail) : null, Date.now())
}

export interface AuditRow { id: number; actorId: string | null; projectId: string | null; action: string; detail: unknown; at: number }

export function auditEntries(db: DB, action?: AuditAction): AuditRow[] {
  const rows = db.prepare(`SELECT id, actor_id AS actorId, project_id AS projectId, action, detail_json AS d, at
    FROM audit_log ${action ? 'WHERE action = ?' : ''} ORDER BY id`).all(...(action ? [action] : [])) as
    (Omit<AuditRow, 'detail'> & { d: string | null })[]
  return rows.map(({ d, ...r }) => ({ ...r, detail: d === null ? null : JSON.parse(d) as unknown }))
}

/* ---- the admin audit page (docs/M4.md §2) ---- */

/** Filters of GET /api/admin/audit, already validated. `since` is inclusive, `until` exclusive. */
export interface AuditQuery {
  limit: number
  before?: number
  category?: AuditCategory
  actor?: string
  project?: string
  since?: number
  until?: number
}

const CATEGORY_OF = new Map<string, AuditCategory>(
  (Object.entries(AUDIT_CATEGORIES) as [AuditCategory, readonly string[]][]).flatMap(([cat, actions]) => actions.map(a => [a, cat] as const)),
)

interface PageRow {
  id: number; at: number; action: string; d: string | null
  actorId: string | null; actorUsername: string | null; actorName: string | null
  projectId: string | null; projectName: string | null; projectDeletedAt: number | null; projectExists: number
}

/** One page of the audit log, newest first (keyset pagination on id). Reading it is not audited. */
export function auditPage(db: DB, q: AuditQuery): AuditPage {
  const where: string[] = []
  const args: (string | number)[] = []
  if (q.before !== undefined) { where.push('a.id < ?'); args.push(q.before) }
  if (q.category !== undefined) {
    const actions = AUDIT_CATEGORIES[q.category]
    where.push(`a.action IN (${actions.map(() => '?').join(', ')})`); args.push(...actions)
  }
  if (q.actor !== undefined) { where.push('a.actor_id = ?'); args.push(q.actor) }
  if (q.project !== undefined) { where.push('a.project_id = ?'); args.push(q.project) }
  if (q.since !== undefined) { where.push('a.at >= ?'); args.push(q.since) }
  if (q.until !== undefined) { where.push('a.at < ?'); args.push(q.until) }

  // One extra row tells whether an older page exists without a COUNT.
  const rows = db.prepare(`SELECT a.id, a.at, a.action, a.detail_json AS d,
      a.actor_id AS actorId, u.username AS actorUsername, u.display_name AS actorName,
      a.project_id AS projectId, p.name AS projectName, p.deleted_at AS projectDeletedAt, p.id IS NOT NULL AS projectExists
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    LEFT JOIN projects p ON p.id = a.project_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.id DESC LIMIT ?`).all(...args, q.limit + 1) as PageRow[]

  const more = rows.length > q.limit
  const page = more ? rows.slice(0, q.limit) : rows
  const purgedNames = new Map<string, string>()
  const entries = page.map(r => toView(db, r, purgedNames))
  return { entries: withUsers(db, entries), next: more ? page[page.length - 1]!.id : null }
}

function toView(db: DB, r: PageRow, purgedNames: Map<string, string>): AuditEntryView {
  const detail = parseDetail(r.d)
  return {
    id: r.id, at: r.at, action: r.action, category: CATEGORY_OF.get(r.action) ?? null,
    // An actor id without an account row is a deleted account (docs/ACCOUNT-DELETION.md): the client
    // shows the empty names as "a deleted account".
    actor: r.actorId === null ? null : { id: r.actorId, username: r.actorUsername ?? '', displayName: r.actorName ?? '' },
    project: r.projectId === null ? null
      : r.projectExists
        ? { id: r.projectId, name: r.projectName ?? '', deleted: r.projectDeletedAt !== null }
        : { id: r.projectId, name: purgedName(db, r.projectId, purgedNames), deleted: true },
    detail,
    users: {},
  }
}

function parseDetail(d: string | null): Record<string, unknown> | null {
  if (d === null) return null
  try {
    const v = JSON.parse(d) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * The last known name of a purged project, from its own audit trail: the purge, delete and create
 * entries record the name, a rename records it as `to`. (A row's own `detail.name` is not used: on
 * file actions it is a file name.) '' when nothing recorded it.
 */
function purgedName(db: DB, projectId: string, cache: Map<string, string>): string {
  let name = cache.get(projectId)
  if (name === undefined) {
    const row = db.prepare(`SELECT CASE WHEN action = 'project.setting' THEN json_extract(detail_json, '$.to')
        ELSE json_extract(detail_json, '$.name') END AS name
      FROM audit_log WHERE project_id = ? AND json_valid(detail_json) AND (action IN ('project.purge', 'project-delete', 'project-create')
        OR (action = 'project.setting' AND json_extract(detail_json, '$.key') = 'name'))
      ORDER BY id DESC LIMIT 1`).get(projectId) as { name: unknown } | undefined
    name = typeof row?.name === 'string' ? row.name : ''
    cache.set(projectId, name)
  }
  return name
}

/** Ids of the people an entry's detail names: `userId`, and both sides of an ownership transfer. */
function namedUserIds(e: AuditEntryView): string[] {
  const d = e.detail
  if (!d) return []
  const ids = [d.userId]
  if (e.action === 'ownership-transfer') ids.push(d.from, d.to)
  return ids.filter((x): x is string => typeof x === 'string' && x !== '')
}

/** Fill each entry's `users` with the accounts its detail names (one query for the whole page). */
function withUsers(db: DB, entries: AuditEntryView[]): AuditEntryView[] {
  const ids = [...new Set(entries.flatMap(namedUserIds))]
  if (ids.length === 0) return entries
  const people = new Map<string, AuditPerson>()
  // At most 200 entries × 2 ids: well under SQLite's bound-parameter limit.
  const rows = db.prepare(`SELECT id, username, display_name AS displayName FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`)
    .all(...ids) as AuditPerson[]
  for (const p of rows) people.set(p.id, p)
  for (const e of entries) {
    for (const id of namedUserIds(e)) {
      const p = people.get(id)
      if (p) e.users[id] = p
    }
  }
  return entries
}
