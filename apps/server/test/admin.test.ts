import { afterEach, describe, expect, it } from 'vitest'
import { auditEntries } from '../src/audit.ts'
import { Client, me, openInstance, PASSWORD, signup, type TestServer } from './inproc.ts'

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.stop() })

describe('admin routes', () => {
  it('non-admins get 403; unauthenticated 401', async () => {
    const { ts } = await openInstance(39155); servers.push(ts)
    const u = await signup(ts.base, 'user1')
    for (const [m, p, b] of [['GET', '/api/admin/users'], ['POST', '/api/admin/users', {}], ['GET', '/api/admin/settings'],
      ['PATCH', '/api/admin/settings', { registration: 'open' }]] as const) {
      expect((await u.req(m, p, b)).status).toBe(403)
      expect((await new Client(ts.base).req(m, p, b)).status).toBe(401)
    }
  })

  it('list, create, update users; settings', async () => {
    const { ts, admin } = await openInstance(39156); servers.push(ts)
    const created = await admin.post('/api/admin/users', { username: 'NewUser', displayName: 'New', password: PASSWORD, isAdmin: false })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ username: 'newuser', displayName: 'New', isAdmin: false, disabled: false })
    expect((await admin.post('/api/admin/users', { username: 'newuser', displayName: 'X', password: PASSWORD })).body.error).toBe('username-taken')
    expect((await admin.post('/api/admin/users', { username: 'other', displayName: 'X', password: 'short' })).body.error).toBe('weak-password')

    const list = (await admin.get('/api/admin/users')).body
    expect(list.map((u: { username: string }) => u.username)).toEqual(['admin', 'newuser'])

    const id = created.body.id as string
    const nu = new Client(ts.base)
    expect((await nu.post('/api/auth/login', { username: 'newuser', password: PASSWORD })).status).toBe(200)
    const up = await admin.patch(`/api/admin/users/${id}`, { displayName: 'Renamed', isAdmin: true })
    expect(up.body).toMatchObject({ displayName: 'Renamed', isAdmin: true })
    expect((await me(nu)).isAdmin).toBe(true) // takes effect on the live session

    // admin sets a password: all their sessions die
    expect((await admin.patch(`/api/admin/users/${id}`, { password: 'reset password 1' })).status).toBe(200)
    expect((await nu.get('/api/me')).status).toBe(401)
    expect((await nu.post('/api/auth/login', { username: 'newuser', password: 'reset password 1' })).status).toBe(200)
    expect((await admin.patch(`/api/admin/users/${id}`, { password: 'short' })).body.error).toBe('weak-password')

    // disable / re-enable
    expect((await admin.patch(`/api/admin/users/${id}`, { disabled: true })).body.disabled).toBe(true)
    expect((await nu.get('/api/me')).status).toBe(401)
    expect((await admin.patch(`/api/admin/users/${id}`, { disabled: false })).body.disabled).toBe(false)
    expect((await nu.post('/api/auth/login', { username: 'newuser', password: 'reset password 1' })).status).toBe(200)

    expect((await admin.patch('/api/admin/users/not-a-uuid', { displayName: 'x' })).status).toBe(404)
    expect((await admin.patch('/api/admin/users/3f0e8a52-1c1b-4c3e-9d4a-0b9a0d6c1e2f', { displayName: 'x' })).status).toBe(404)
    expect((await admin.patch(`/api/admin/users/${id}`, { bogus: 1 })).status).toBe(400)

    expect((await admin.get('/api/admin/settings')).body).toEqual({ registration: 'open' })
    expect((await admin.patch('/api/admin/settings', { registration: 'nope' })).status).toBe(400)
    expect((await admin.patch('/api/admin/settings', { registration: 'closed' })).body).toEqual({ registration: 'closed' })
    expect((await new Client(ts.base).get('/api/instance')).body.registration).toBe('closed')
    expect(auditEntries(ts.lig.db, 'admin-user-update').length).toBeGreaterThanOrEqual(4)
    expect(auditEntries(ts.lig.db, 'settings-update')).toHaveLength(2)
    expect(JSON.stringify(auditEntries(ts.lig.db))).not.toContain('reset password 1')
  })

  it('last-admin guard: an admin cannot demote or disable themselves', async () => {
    const { ts, admin } = await openInstance(39157); servers.push(ts)
    const self = await me(admin)
    for (const patch of [{ isAdmin: false }, { disabled: true }]) {
      const r = await admin.patch(`/api/admin/users/${self.id}`, patch)
      expect(r.status).toBe(409)
      expect(r.body.error).toBe('last-admin')
    }
    // Even with a second admin present, self-demotion is refused; the other admin can do it.
    const second = await signup(ts.base, 'second')
    const secondId = (await me(second)).id
    await admin.patch(`/api/admin/users/${secondId}`, { isAdmin: true })
    expect((await admin.patch(`/api/admin/users/${self.id}`, { isAdmin: false })).status).toBe(409)
    expect((await second.patch(`/api/admin/users/${self.id}`, { isAdmin: false })).status).toBe(200)
    expect((await me(admin)).isAdmin).toBe(false)
    // and now `second` is the last admin
    expect((await second.patch(`/api/admin/users/${secondId}`, { disabled: true })).body.error).toBe('last-admin')
    expect((await second.patch(`/api/admin/users/${secondId}`, { displayName: 'Still me' })).status).toBe(200)
  })
})
