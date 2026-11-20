import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { z } from 'zod'
import type { InstanceInfo, Me } from '@ligature/shared'
import { audit } from '../../audit.ts'
import { ApiError } from '../../errors.ts'
import { hashPassword, verifyPassword } from '../../auth/password.ts'
import { createSession, deleteSession, SESSION_COOKIE } from '../../auth/sessions.ts'
import { getSettings, hasUsers } from '../../auth/settings.ts'
import { checkSetupToken } from '../../auth/setup.ts'
import { getUserById, getUserByUsername, insertUser, setPassword, toMe, validateNewUser } from '../../auth/users.ts'
import { displayNameSchema, passwordFieldSchema } from '../../auth/validation.ts'
import { announceJoin, findActiveInvite, joinWithInvite, type Joined } from '../../projects/invites.ts'
import { projectIdsOfUser } from '../../projects/repo.ts'
import { clientIp, readJson, requireUser, setSessionCookie, type Env, type RouteDeps } from '../context.ts'

const rateLimited = () => new ApiError(429, 'rate-limited', 'Too many attempts; try again later')
const invalidCredentials = (status: 401 | 403 = 401) => new ApiError(status, 'invalid-credentials', 'Wrong username or password')

const signupSchema = z.strictObject({
  username: z.string().max(64),
  displayName: z.string().max(256),
  password: passwordFieldSchema,
  inviteToken: z.string().max(128).optional(),
  setupToken: z.string().max(128).optional(),
})
const loginSchema = z.strictObject({ username: z.string().max(64), password: passwordFieldSchema })
const updateMeSchema = z.strictObject({ displayName: displayNameSchema })
const changePasswordSchema = z.strictObject({ currentPassword: passwordFieldSchema, newPassword: passwordFieldSchema })

export function authRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()
  const authed = requireUser(deps)

  app.get('/instance', c => c.json({
    registration: getSettings(db).registration, hasUsers: hasUsers(db), devLogin: deps.devLogin,
    setupRequired: deps.setupToken !== null && !hasUsers(db),
  } satisfies InstanceInfo))

  app.post('/auth/signup', async c => {
    if (!deps.limiters.signup.consume(clientIp(c, deps.trustProxy))) throw rateLimited()
    const body = await readJson(c, signupSchema)
    const v = validateNewUser(body)
    const passwordHash = await hashPassword(v.password)
    // One immediate transaction: "is this the first account?" and the insert are atomic,
    // so two concurrent first signups cannot both become admin.
    const res = db.transaction(() => {
      const first = !hasUsers(db)
      if (first && deps.setupToken !== null) checkSetupToken(deps.setupToken, body.setupToken)
      if (!first) {
        const mode = getSettings(db).registration
        if (mode === 'closed') throw new ApiError(403, 'registration-closed', 'Registration is closed; ask an administrator for an account')
        if (mode === 'invite-only' && !body.inviteToken) throw new ApiError(403, 'invite-required', 'You need an invite link to sign up')
        if (body.inviteToken !== undefined && !findActiveInvite(db, body.inviteToken)) {
          throw new ApiError(400, 'invite-invalid', 'This invite link is invalid, expired or used up')
        }
      }
      const user = insertUser(db, { username: v.username, displayName: v.displayName, passwordHash, isAdmin: first })
      let joined: Joined | null = null
      if (!first && body.inviteToken !== undefined) joined = joinWithInvite(db, user.id, body.inviteToken)
      audit(db, { actorId: user.id, action: 'signup', detail: { username: user.username, admin: first, project: joined?.projectId ?? null } })
      return { user, joined, session: createSession(db, user.id) }
    }).immediate()
    if (res.joined) announceJoin(deps, res.user.id, res.joined)
    setSessionCookie(c, res.session.token, res.session.expiresAt, deps.secureCookies)
    return c.json(toMe(res.user) satisfies Me)
  })

  app.post('/auth/login', async c => {
    const ip = clientIp(c, deps.trustProxy)
    const body = await readJson(c, loginSchema)
    const username = body.username.toLowerCase()
    const userKey = `${ip}\n${username}`
    const { loginUser, loginIp } = deps.limiters
    // Count the attempt as a failure *before* the (slow) argon2 verify, in the same synchronous step as
    // the check: otherwise any number of concurrent requests pass the check before the first is counted.
    // A successful login gives the hits back below.
    if (loginUser.blocked(userKey) || loginIp.blocked(ip)) throw rateLimited()
    loginUser.hit(userKey)
    loginIp.hit(ip)
    const user = getUserByUsername(db, username)
    // Unknown user: verifyPassword hashes against a dummy, so timing does not reveal existence.
    const ok = await verifyPassword(user?.passwordHash ?? null, body.password)
    if (!user || !ok) {
      audit(db, { actorId: user?.id ?? null, action: 'login-failure', detail: { username, ip } })
      throw invalidCredentials()
    }
    if (user.disabledAt !== null) {
      audit(db, { actorId: user.id, action: 'login-failure', detail: { username, ip, reason: 'disabled' } })
      throw new ApiError(403, 'account-disabled', 'This account is disabled')
    }
    loginUser.reset(userKey)
    loginIp.refund(ip)
    const s = createSession(db, user.id)
    audit(db, { actorId: user.id, action: 'login', detail: { ip } })
    setSessionCookie(c, s.token, s.expiresAt, deps.secureCookies)
    return c.json(toMe(user) satisfies Me)
  })

  const logout = (c: Context<Env>) => {
    const t = getCookie(c, SESSION_COOKIE)
    if (t) deleteSession(db, t)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    // Sockets authenticated with this session lose access now, not at their next reconnect.
    deps.collab.closeSessionConnections(c.get('session').tokenHash, 'session-ended')
    return c.json({ ok: true })
  }
  app.post('/auth/logout', authed, logout)
  app.post('/logout', authed, logout) // M0 path, kept for compatibility

  app.get('/me', authed, c => c.json(toMe(c.get('user')) satisfies Me))

  app.patch('/me', authed, async c => {
    const { displayName } = await readJson(c, updateMeSchema)
    const me = c.get('user')
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, me.id)
    for (const p of projectIdsOfUser(db, me.id)) deps.collab.broadcast(p, { type: 'members-changed' })
    return c.json(toMe(getUserById(db, me.id)!) satisfies Me)
  })

  app.post('/me/password', authed, async c => {
    const body = await readJson(c, changePasswordSchema)
    const me = c.get('user')
    const ip = clientIp(c, deps.trustProxy)
    const userKey = `${ip}\n${me.username}`
    // Counted before the verify (see login); given back when the current password is right.
    if (!deps.limiters.loginUser.consume(userKey)) throw rateLimited()
    const row = getUserById(db, me.id)
    if (!row || !(await verifyPassword(row.passwordHash, body.currentPassword))) throw invalidCredentials(403)
    deps.limiters.loginUser.refund(userKey)
    const session = c.get('session')
    const killed = await setPassword(db, me.id, body.newPassword, session.tokenHash)
    audit(db, { actorId: me.id, action: 'logout-all', detail: { reason: 'password-change', sessions: killed } })
    deps.collab.closeUserConnections(me.id, null, 'session-ended', session.tokenHash)
    return c.json({ ok: true })
  })

  if (deps.devLogin) {
    // DEV ONLY: log in as a seeded user without a password. Not registered in production (see server.ts).
    app.post('/dev/login', async c => {
      const body = z.object({ username: z.string().min(1).max(64) }).safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'bad-request' }, 400)
      const u = getUserByUsername(db, body.data.username)
      if (!u) return c.json({ error: 'no-such-user' }, 404)
      if (u.disabledAt !== null) return c.json({ error: 'account-disabled' }, 403)
      const s = createSession(db, u.id)
      audit(db, { actorId: u.id, action: 'login', detail: { ip: clientIp(c, deps.trustProxy), dev: true } })
      setSessionCookie(c, s.token, s.expiresAt, deps.secureCookies)
      return c.json({ ok: true })
    })
  }

  return app
}
