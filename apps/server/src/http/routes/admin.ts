import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { AUDIT_CATEGORIES, type AdminAbout, type AdminUser, type AuditCategory, type AuditPage, type GcReport, type InstanceSettings,
  type RebuildDocResponse, type StorageReport } from '@ligature/shared'
import { audit, auditPage } from '../../audit.ts'
import { ApiError, badRequest, notFound } from '../../errors.ts'
import { hashPassword, isAcceptablePassword } from '../../auth/password.ts'
import { deleteUserSessions } from '../../auth/sessions.ts'
import { getSettings, REGISTRATION_MODES, setSettings } from '../../auth/settings.ts'
import { countActiveAdmins, createUser, getUserById, listUsers, toAdminUser, weakPassword } from '../../auth/users.ts'
import { displayNameSchema, passwordFieldSchema } from '../../auth/validation.ts'
import { projectIdsOfUser } from '../../projects/repo.ts'
import { isUuid } from '../../services.ts'
import { VERSION } from '../../version.ts'
import { readJson, type Env, type RouteDeps } from '../context.ts'

const createSchema = z.strictObject({
  username: z.string().max(64), displayName: z.string().max(256), password: passwordFieldSchema, isAdmin: z.boolean().optional(),
})
const updateSchema = z.strictObject({
  displayName: displayNameSchema.optional(), isAdmin: z.boolean().optional(), disabled: z.boolean().optional(),
  password: passwordFieldSchema.optional(),
})
const settingsSchema = z.strictObject({ registration: z.enum(REGISTRATION_MODES as [string, ...string[]]) })

const lastAdmin = (message: string) => new ApiError(409, 'last-admin', message)

/* ---- audit log query (docs/M4.md §2) ---- */

/** A non-negative integer as written in a query string (no sign, exponent or hex). */
const count = (min: number) => z.string().max(16).regex(/^\d+$/, 'expected an integer')
  .transform(Number).pipe(z.number().int().min(min).max(Number.MAX_SAFE_INTEGER))
const uuid = (what: string) => z.string().max(64).refine(isUuid, `expected a ${what} id`)

const AUDIT_PAGE_DEFAULT = 100
const auditQuerySchema = z.object({
  limit: count(1).pipe(z.number().max(200)).optional(),
  before: count(1).optional(),
  category: z.enum(Object.keys(AUDIT_CATEGORIES) as [AuditCategory, ...AuditCategory[]]).optional(),
  actor: uuid('user').optional(),
  project: uuid('project').optional(),
  since: count(0).optional(),
  until: count(0).optional(),
})

function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const r = schema.safeParse(c.req.query())
  if (!r.success) {
    const i = r.error.issues[0]
    throw badRequest(i ? `${i.path.join('.') || 'query'}: ${i.message}` : 'Invalid query')
  }
  return r.data
}

export function adminRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  app.get('/admin/about', c => c.json({ version: VERSION } satisfies AdminAbout))

  app.get('/admin/users', c => c.json(listUsers(db).map(toAdminUser) satisfies AdminUser[]))

  app.post('/admin/users', async c => {
    const body = await readJson(c, createSchema)
    const u = await createUser(db, body)
    audit(db, { actorId: c.get('user').id, action: 'admin-user-create', detail: { userId: u.id, username: u.username, isAdmin: u.isAdmin } })
    return c.json(toAdminUser(u) satisfies AdminUser)
  })

  app.patch('/admin/users/:id', async c => {
    const id = c.req.param('id')
    if (!isUuid(id)) throw notFound()
    const body = await readJson(c, updateSchema)
    const me = c.get('user')
    const target = getUserById(db, id)
    if (!target) throw notFound()
    if (target.id === me.id && (body.isAdmin === false || body.disabled === true)) {
      throw lastAdmin('You cannot remove your own admin rights or disable your own account')
    }
    if (body.password !== undefined && !isAcceptablePassword(body.password)) throw weakPassword()
    const passwordHash = body.password !== undefined ? await hashPassword(body.password) : null

    const out = db.transaction(() => {
      const cur = getUserById(db, id)
      if (!cur) throw notFound()
      const wasActiveAdmin = cur.isAdmin && cur.disabledAt === null
      const willBeAdmin = body.isAdmin ?? cur.isAdmin
      const willBeDisabled = body.disabled ?? cur.disabledAt !== null
      if (wasActiveAdmin && !(willBeAdmin && !willBeDisabled) && countActiveAdmins(db) <= 1) {
        throw lastAdmin('This would leave the instance without an active administrator')
      }
      const newlyDisabled = body.disabled === true && cur.disabledAt === null
      if (body.displayName !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(body.displayName, id)
      if (body.isAdmin !== undefined) db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(body.isAdmin ? 1 : 0, id)
      if (body.disabled !== undefined) {
        db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(body.disabled ? (cur.disabledAt ?? Date.now()) : null, id)
      }
      if (passwordHash !== null) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id)
      const killSessions = newlyDisabled || passwordHash !== null
      if (killSessions) deleteUserSessions(db, id)
      audit(db, {
        actorId: me.id, action: 'admin-user-update',
        detail: { userId: id, displayName: body.displayName, isAdmin: body.isAdmin, disabled: body.disabled, passwordReset: passwordHash !== null },
      })
      return { newlyDisabled, killSessions }
    }).immediate()

    if (out.newlyDisabled) {
      for (const p of projectIdsOfUser(db, id)) deps.collab.broadcast(p, { type: 'access-revoked', userId: id })
    }
    if (out.killSessions) deps.collab.closeUserConnections(id, null, out.newlyDisabled ? 'account-disabled' : 'session-ended')
    if (body.displayName !== undefined) {
      for (const p of projectIdsOfUser(db, id)) deps.collab.broadcast(p, { type: 'members-changed' })
    }
    return c.json(toAdminUser(getUserById(db, id)!) satisfies AdminUser)
  })

  app.get('/admin/settings', c => c.json(getSettings(db) satisfies InstanceSettings))

  app.patch('/admin/settings', async c => {
    const body = await readJson(c, settingsSchema)
    const before = getSettings(db)
    const after = setSettings(db, { registration: body.registration as InstanceSettings['registration'] })
    audit(db, { actorId: c.get('user').id, action: 'settings-update', detail: { before, after } })
    return c.json(after satisfies InstanceSettings)
  })

  /* ---- audit log (docs/M4.md §2) ---- */

  /** Newest first, keyset-paginated. Not audited itself: every page view would flood the log it shows. */
  app.get('/admin/audit', c => {
    const q = readQuery(c, auditQuerySchema)
    return c.json(auditPage(db, { ...q, limit: q.limit ?? AUDIT_PAGE_DEFAULT }) satisfies AuditPage, 200, { 'cache-control': 'no-store' })
  })

  /* ---- storage (docs/M3.md §3–§5) ---- */

  /** Audited as `storage.view` (docs/M3.md §5: both storage routes are audited). */
  app.get('/admin/storage', c => {
    const report = deps.maintenance.storage()
    audit(db, { actorId: c.get('user').id, action: 'storage.view' })
    return c.json(report satisfies StorageReport)
  })

  /** Runs the GC now (or joins the run in progress) and returns its report. Audited as `gc.run`. */
  app.post('/admin/gc', async c => c.json(await deps.maintenance.runGc({ actorId: c.get('user').id }) satisfies GcReport))

  /** Rebuild one text file's doc (new epoch); `409 doc-in-use` while anyone has it open. Audited as `doc.rebuild`. */
  app.post('/admin/files/:fileId/rebuild', c => {
    const r = deps.rebuilder.rebuildFile(c.req.param('fileId'), c.get('user').id)
    return c.json({ fileId: r.fileId, epoch: r.toEpoch, stateBytesBefore: r.stateBytesBefore, stateBytesAfter: r.stateBytesAfter } satisfies RebuildDocResponse)
  })

  return app
}
