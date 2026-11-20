import { afterEach, describe, expect, it } from 'vitest'
import { auditEntries } from '../src/audit.ts'
import { passwordStats } from '../src/auth/password.ts'
import { SESSION_TTL_MS, sha256 } from '../src/auth/sessions.ts'
import { DEV_PASSWORD } from '../src/dev/seed.ts'
import { Client, newProject, openInstance, PASSWORD, signup, startTestServer, type TestServer } from './inproc.ts'

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.stop() })
async function server(port: number, opts: Parameters<typeof startTestServer>[1] = {}) {
  const s = await startTestServer(port, opts); servers.push(s); return s
}

describe('instance + signup modes', () => {
  it('first account becomes admin in any mode; then invite-only (default) requires an invite', async () => {
    const s = await server(39140)
    const anon = new Client(s.base)
    expect((await anon.get('/api/instance')).body).toEqual({ registration: 'invite-only', hasUsers: false, devLogin: true, setupRequired: false })

    const first = new Client(s.base)
    const r = await first.post('/api/auth/signup', { username: 'Root.User', displayName: '  Root  ', password: PASSWORD })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ username: 'root.user', displayName: 'Root', isAdmin: true })
    expect((await first.get('/api/me')).body.isAdmin).toBe(true)
    expect((await anon.get('/api/instance')).body.hasUsers).toBe(true)

    const second = new Client(s.base)
    const r2 = await second.post('/api/auth/signup', { username: 'bob', displayName: 'Bob', password: PASSWORD })
    expect(r2.status).toBe(403)
    expect(r2.body.error).toBe('invite-required')
    const r3 = await second.post('/api/auth/signup', { username: 'bob', displayName: 'Bob', password: PASSWORD, inviteToken: 'x'.repeat(43) })
    expect(r3.body.error).toBe('invite-invalid')

    // closed: nobody (not even with a valid invite)
    const p = await newProject(first)
    const inv = (await first.post(`/api/projects/${p.id}/invites`, { role: 'editor' })).body
    expect((await first.patch('/api/admin/settings', { registration: 'closed' })).status).toBe(200)
    const r4 = await second.post('/api/auth/signup', { username: 'bob', displayName: 'Bob', password: PASSWORD, inviteToken: inv.token })
    expect(r4.status).toBe(403)
    expect(r4.body.error).toBe('registration-closed')

    // invite-only with a valid invite: account created and joined to the project with the invite's role
    await first.patch('/api/admin/settings', { registration: 'invite-only' })
    const r5 = await second.post('/api/auth/signup', { username: 'bob', displayName: 'Bob', password: PASSWORD, inviteToken: inv.token })
    expect(r5.status).toBe(200)
    expect(r5.body.isAdmin).toBe(false)
    const list = (await second.get('/api/projects')).body
    expect(list).toEqual([expect.objectContaining({ id: p.id, role: 'editor', ownerName: 'Root' })])
    expect(auditEntries(s.lig.db, 'signup')).toHaveLength(2)
  })

  it('validation: weak password, bad username, unknown fields, username taken (case-insensitive)', async () => {
    const s = await server(39141)
    const c = new Client(s.base)
    const bad = async (body: object) => (await c.post('/api/auth/signup', body)).body.error
    expect(await bad({ username: 'abc', displayName: 'A', password: 'short' })).toBe('weak-password')
    expect(await bad({ username: 'abc', displayName: 'A', password: 'x'.repeat(257) })).toBe('weak-password')
    expect(await bad({ username: 'ab', displayName: 'A', password: PASSWORD })).toBe('bad-request')
    expect(await bad({ username: '-abc', displayName: 'A', password: PASSWORD })).toBe('bad-request')
    expect(await bad({ username: 'abc', displayName: 'A\u0007', password: PASSWORD })).toBe('bad-request')
    expect(await bad({ username: 'abc', displayName: '   ', password: PASSWORD })).toBe('bad-request')
    expect(await bad({ username: 'abc', displayName: 'A', password: PASSWORD, extra: 1 })).toBe('bad-request')
    expect((await c.req('POST', '/api/auth/signup', undefined, { raw: '{nope', headers: { 'content-type': 'application/json' } })).body.error).toBe('bad-request')
    await signup(s.base, 'taken')
    await new Client(s.base).post('/api/auth/signup', {}) // noise
    const admin = new Client(s.base)
    await admin.post('/api/auth/login', { username: 'taken', password: PASSWORD })
    await admin.patch('/api/admin/settings', { registration: 'open' })
    expect(await bad({ username: 'TAKEN', displayName: 'T', password: PASSWORD })).toBe('username-taken')
  })

  it('concurrent first signups: exactly one becomes admin', async () => {
    const s = await server(39142)
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      new Client(s.base).post('/api/auth/signup', { username: `racer${i}`, displayName: `R${i}`, password: PASSWORD })))
    const ok = results.filter(r => r.status === 200)
    expect(ok).toHaveLength(1)
    expect(ok[0]!.body.isAdmin).toBe(true)
    expect(results.filter(r => r.status === 403).every(r => r.body.error === 'invite-required')).toBe(true)
    const admins = s.lig.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }
    expect(admins.n).toBe(1)
  })

  it('concurrent signups in open mode with the same username: one wins, others username-taken', async () => {
    const { ts } = await openInstance(39143); servers.push(ts)
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      new Client(ts.base).post('/api/auth/signup', { username: 'dup', displayName: 'D', password: PASSWORD })))
    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    expect(results.filter(r => r.status === 409 && r.body.error === 'username-taken')).toHaveLength(4)
  })
})

describe('login / logout / sessions', () => {
  it('login success and failure; same 401 for unknown user and wrong password; disabled account', async () => {
    const { ts, admin } = await openInstance(39144); servers.push(ts)
    await signup(ts.base, 'dora')
    const c = new Client(ts.base)
    const ok = await c.post('/api/auth/login', { username: 'DORA', password: PASSWORD })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ id: expect.any(String), username: 'dora', displayName: 'dora', isAdmin: false })
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(ok.headers.get('set-cookie')).toMatch(/SameSite=Lax/i)
    expect((await c.get('/api/me')).status).toBe(200)

    const wrong = await new Client(ts.base).post('/api/auth/login', { username: 'dora', password: 'wrong password!' })
    const unknown = await new Client(ts.base).post('/api/auth/login', { username: 'nobody', password: 'wrong password!' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual(wrong.body)
    expect(wrong.body.error).toBe('invalid-credentials')
    expect(auditEntries(ts.lig.db, 'login-failure').length).toBeGreaterThanOrEqual(2)

    // Disabled: 403 only with the right password (no account-state oracle otherwise).
    const doraId = ok.body.id as string
    expect((await admin.patch(`/api/admin/users/${doraId}`, { disabled: true })).status).toBe(200)
    expect((await c.get('/api/me')).status).toBe(401) // session killed
    const dis = await new Client(ts.base).post('/api/auth/login', { username: 'dora', password: PASSWORD })
    expect(dis.status).toBe(403)
    expect(dis.body.error).toBe('account-disabled')
    expect((await new Client(ts.base).post('/api/auth/login', { username: 'dora', password: 'not it at all' })).status).toBe(401)
  })

  it('unknown-user path verifies a dummy hash (timing-safe)', async () => {
    const { ts } = await openInstance(39145, { rateLimits: { loginPerIp: 1000, loginPerUser: 1000 } }); servers.push(ts)
    await signup(ts.base, 'erin')
    const before = passwordStats.dummyVerifications
    const time = async (username: string) => {
      const t = performance.now()
      const r = await new Client(ts.base).post('/api/auth/login', { username, password: 'definitely wrong' })
      expect(r.status).toBe(401)
      return performance.now() - t
    }
    await time('ghost'); await time('erin') // warm up
    const known: number[] = []; const unknown: number[] = []
    for (let i = 0; i < 8; i++) { known.push(await time('erin')); unknown.push(await time(`ghost${i}`)) }
    expect(passwordStats.dummyVerifications - before).toBe(9)
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!
    // Both paths run one argon2 verification: the unknown-user path must not be dramatically faster.
    expect(median(unknown)).toBeGreaterThan(median(known) * 0.5)
  })

  it('rate limit: failures per (IP, username) and per IP; signup per IP', async () => {
    const { ts } = await openInstance(39146, { rateLimits: { loginPerUser: 3, loginPerIp: 5, signupPerIp: 4 } }); servers.push(ts)
    // openInstance used 1 signup. Make one user.
    await signup(ts.base, 'fay')
    const login = (username: string, password = 'wrong password!') => new Client(ts.base).post('/api/auth/login', { username, password })
    for (let i = 0; i < 3; i++) expect((await login('fay')).status).toBe(401)
    const limited = await login('fay', PASSWORD) // even the right password is refused now
    expect(limited.status).toBe(429)
    expect(limited.body.error).toBe('rate-limited')
    // other usernames from the same IP still work until the per-IP budget (5 failures) is used
    expect((await login('ghost1')).status).toBe(401)
    expect((await login('ghost2')).status).toBe(401)
    expect((await login('ghost3')).status).toBe(429)
    // signup: 4 per IP per window (2 used above)
    expect((await new Client(ts.base).post('/api/auth/signup', { username: 'gus', displayName: 'G', password: PASSWORD })).status).toBe(200)
    expect((await new Client(ts.base).post('/api/auth/signup', { username: 'gus', displayName: 'G', password: PASSWORD })).status).toBe(409)
    expect((await new Client(ts.base).post('/api/auth/signup', { username: 'hal', displayName: 'H', password: PASSWORD })).status).toBe(429)
  })

  it('a successful login resets the per-user failure counter', async () => {
    const { ts } = await openInstance(39147, { rateLimits: { loginPerUser: 3, loginPerIp: 100 } }); servers.push(ts)
    await signup(ts.base, 'ivy')
    const login = (password: string) => new Client(ts.base).post('/api/auth/login', { username: 'ivy', password })
    await login('wrong password!'); await login('wrong password!')
    expect((await login(PASSWORD)).status).toBe(200)
    await login('wrong password!'); await login('wrong password!')
    expect((await login(PASSWORD)).status).toBe(200)
  })

  it('TRUST_PROXY: the first X-Forwarded-For hop is the client', async () => {
    const s = await server(39148, { trustProxy: true, rateLimits: { loginPerUser: 1, loginPerIp: 100 } })
    await signup(s.base, 'root')
    const login = (ip: string) => new Client(s.base).req('POST', '/api/auth/login', { username: 'root', password: 'wrong password!' },
      { headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } })
    expect((await login('1.1.1.1')).status).toBe(401)
    expect((await login('1.1.1.1')).status).toBe(429)
    expect((await login('2.2.2.2')).status).toBe(401)
  })

  it('logout deletes the session; password change kills all other sessions', async () => {
    const { ts } = await openInstance(39149); servers.push(ts)
    const a = await signup(ts.base, 'joe')
    const b = new Client(ts.base)
    await b.post('/api/auth/login', { username: 'joe', password: PASSWORD })
    const c = new Client(ts.base)
    await c.post('/api/auth/login', { username: 'joe', password: PASSWORD })

    const bad = await a.post('/api/me/password', { currentPassword: 'wrong password!', newPassword: 'new password 123' })
    expect(bad.status).toBe(403)
    expect(bad.body.error).toBe('invalid-credentials')
    expect((await a.post('/api/me/password', { currentPassword: PASSWORD, newPassword: 'short' })).body.error).toBe('weak-password')
    expect((await a.post('/api/me/password', { currentPassword: PASSWORD, newPassword: 'new password 123' })).status).toBe(200)
    expect((await a.get('/api/me')).status).toBe(200)
    expect((await b.get('/api/me')).status).toBe(401)
    expect((await c.get('/api/me')).status).toBe(401)
    expect(auditEntries(ts.lig.db, 'logout-all')).toHaveLength(1)
    expect((await new Client(ts.base).post('/api/auth/login', { username: 'joe', password: PASSWORD })).status).toBe(401)
    expect((await new Client(ts.base).post('/api/auth/login', { username: 'joe', password: 'new password 123' })).status).toBe(200)

    const cookie = a.cookie
    const out = await a.post('/api/auth/logout')
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toMatch(/ligature_session=;/)
    const stale = new Client(ts.base); stale.cookie = cookie
    expect((await stale.get('/api/me')).status).toBe(401)
    const token = cookie.split('=')[1]!
    expect(ts.lig.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(decodeURIComponent(token)))).toBeUndefined()
  })

  it('PATCH /me updates the display name', async () => {
    const s = await server(39150)
    const a = await signup(s.base, 'kim')
    const r = await a.patch('/api/me', { displayName: '  Kim K.  ' })
    expect(r.status).toBe(200)
    expect(r.body.displayName).toBe('Kim K.')
    expect((await a.patch('/api/me', { displayName: '' })).status).toBe(400)
    expect((await a.patch('/api/me', { displayName: 'x', isAdmin: true })).status).toBe(400)
  })

  it('sliding expiry: pushed forward at most once per hour, cookie refreshed; expired sessions rejected', async () => {
    const s = await server(39151)
    const a = await signup(s.base, 'lou')
    const hash = sha256(decodeURIComponent(a.cookie.split('=')[1]!))
    const row = () => s.lig.db.prepare('SELECT expires_at AS e, last_seen_at AS l FROM sessions WHERE token_hash = ?').get(hash) as { e: number; l: number }

    const fresh = row().e
    const r1 = await a.get('/api/me') // used within the hour: no change
    expect(r1.headers.get('set-cookie')).toBeNull()
    expect(row().e).toBe(fresh)

    const old = Date.now() + SESSION_TTL_MS - 2 * 3600_000 // last extended 2 h ago
    s.lig.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(old, hash)
    const r2 = await a.get('/api/me')
    expect(r2.status).toBe(200)
    expect(r2.headers.get('set-cookie')).toMatch(/ligature_session=.*Expires=/i)
    expect(row().e).toBeGreaterThan(old + 3600_000)
    expect(row().l).toBeGreaterThan(Date.now() - 10_000)

    s.lig.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, hash)
    expect((await a.get('/api/me')).status).toBe(401)
  })
})

describe('dev seed', () => {
  it('alice/bob/carol log in with the dev password; alice is admin', async () => {
    const s = await server(39152, { seed: true })
    const a = new Client(s.base)
    const r = await a.post('/api/auth/login', { username: 'alice', password: DEV_PASSWORD })
    expect(r.status).toBe(200)
    expect(r.body.isAdmin).toBe(true)
    const b = await new Client(s.base).post('/api/auth/login', { username: 'carol', password: DEV_PASSWORD })
    expect(b.body.isAdmin).toBe(false)
    const list = (await a.get('/api/projects')).body
    expect(list).toEqual([expect.objectContaining({ name: 'Demo paper', role: 'owner', ownerName: 'Alice', updatedAt: expect.any(Number) })])
  })

  it('without devLogin there is no /api/dev/login', async () => {
    const s = await server(39153, { devLogin: false })
    const r = await new Client(s.base).post('/api/dev/login', { username: 'alice' })
    expect(r.status).toBe(404)
    expect((await new Client(s.base).get('/api/instance')).body.devLogin).toBe(false)
  })
})
