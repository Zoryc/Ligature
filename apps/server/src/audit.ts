import type { DB } from './db/index.ts'

export type AuditAction =
  | 'signup' | 'login' | 'login-failure' | 'logout-all'
  | 'admin-user-create' | 'admin-user-update' | 'settings-update'
  | 'member-add' | 'member-role-change' | 'member-remove' | 'ownership-transfer'
  | 'invite-create' | 'invite-revoke' | 'invite-accept'
  | 'project-create' | 'project-delete' | 'file-delete'

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
