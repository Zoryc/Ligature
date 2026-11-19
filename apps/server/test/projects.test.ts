import { afterEach, describe, expect, it } from 'vitest'
import { auditEntries } from '../src/audit.ts'
import { addMember, Client, me, members, newProject, openInstance, project, signup, type TestServer } from './inproc.ts'
import { sleep } from './harness.ts'

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.stop() })

async function setup(port: number) {
  const { ts, admin } = await openInstance(port); servers.push(ts)
  const owner = await signup(ts.base, 'owner', { displayName: 'Olive Owner' })
  const ed = await signup(ts.base, 'editor')
  const vi = await signup(ts.base, 'viewer')
  const out = await signup(ts.base, 'outsider')
  return { ts, admin, owner, ed, vi, out }
}

describe('projects CRUD + soft delete', () => {
  it('create, get, list (most recent first), patch, delete', async () => {
    const { ts, owner, ed, vi, out } = await setup(39160)
    const p = await newProject(owner, '  My Paper  ')
    expect(p).toMatchObject({ name: 'My Paper', role: 'owner', engine: 'pdflatex', treeVersion: 0 })
    const main = p.tree.find(f => f.name === 'main.tex')!
    expect(p.mainFileId).toBe(main.id)
    expect(main).toMatchObject({ kind: 'text', epoch: 1, parentId: p.rootId })
    expect(p.tree.find(f => f.id === p.rootId)).toMatchObject({ parentId: null, kind: 'folder' })
    const raw = await owner.get(`/api/projects/${p.id}/files/${main.id}/raw`)
    expect(raw.body).toContain('\\documentclass{article}')

    expect((await owner.post('/api/projects', { name: '' })).status).toBe(400)
    expect((await owner.post('/api/projects', { name: 'x'.repeat(121) })).status).toBe(400)
    expect((await owner.post('/api/projects', { name: 'ok', extra: true })).status).toBe(400)

    await sleep(5)
    const p2 = await newProject(owner, 'Second')
    let list = (await owner.get('/api/projects')).body
    expect(list.map((x: { id: string }) => x.id)).toEqual([p2.id, p.id])
    expect(list[0]).toEqual({ id: p2.id, name: 'Second', role: 'owner', ownerName: 'Olive Owner', updatedAt: expect.any(Number) })

    await addMember(owner, ed, p.id, 'editor')
    await addMember(owner, vi, p.id, 'viewer')
    await sleep(5)
    // editor may change engine + main file, not the name; viewer nothing
    expect((await ed.patch(`/api/projects/${p.id}`, { engine: 'lualatex' })).body.engine).toBe('lualatex')
    expect((await ed.patch(`/api/projects/${p.id}`, { name: 'Hijack' })).status).toBe(403)
    expect((await vi.patch(`/api/projects/${p.id}`, { engine: 'xelatex' })).status).toBe(403)
    expect((await out.patch(`/api/projects/${p.id}`, { engine: 'xelatex' })).status).toBe(404)
    expect((await owner.patch(`/api/projects/${p.id}`, { engine: 'tex' })).status).toBe(400)
    expect((await owner.patch(`/api/projects/${p.id}`, {})).status).toBe(400)
    expect((await owner.patch(`/api/projects/${p.id}`, { name: 'Renamed' })).body.name).toBe('Renamed')
    list = (await owner.get('/api/projects')).body
    expect(list[0].id).toBe(p.id) // touched most recently

    // mainFileId must be a live .tex text file of this project
    const notes = (await owner.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'notes.txt', kind: 'text' })).body
    const other = (await owner.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'other.tex', kind: 'text' })).body
    const folder = (await owner.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'dir.tex', kind: 'folder' })).body
    expect((await owner.patch(`/api/projects/${p.id}`, { mainFileId: notes.id })).status).toBe(400)
    expect((await owner.patch(`/api/projects/${p.id}`, { mainFileId: folder.id })).status).toBe(400)
    expect((await owner.patch(`/api/projects/${p.id}`, { mainFileId: p2.mainFileId })).status).toBe(400)
    expect((await owner.patch(`/api/projects/${p.id}`, { mainFileId: 'garbage' })).status).toBe(400)
    expect((await owner.patch(`/api/projects/${p.id}`, { mainFileId: other.id })).body.mainFileId).toBe(other.id)

    // "Changed by …" for each shared setting: who, when, and the previous value as people see it
    const changes = (await vi.get(`/api/projects/${p.id}`)).body.changes
    expect(changes.engine).toEqual({ byUserId: expect.any(String), by: 'editor', at: expect.any(Number), was: 'pdflatex' })
    expect(changes.name).toMatchObject({ by: 'Olive Owner', was: 'My Paper' })
    expect(changes.mainFile).toMatchObject({ by: 'Olive Owner', was: 'main.tex' })
    expect(changes.engine.byUserId).not.toBe(changes.name.byUserId)
    // setting a value to what it already is records nothing
    const before = auditEntries(ts.lig.db, 'project.setting').length
    await owner.patch(`/api/projects/${p.id}`, { engine: 'lualatex', mainFileId: other.id })
    expect(auditEntries(ts.lig.db, 'project.setting')).toHaveLength(before)
    expect(before).toBe(3)
    expect((await newProject(owner, 'Fresh')).changes).toEqual({})

    // delete: owner only; afterwards 404 for everyone, gone from lists
    expect((await ed.del(`/api/projects/${p.id}`)).status).toBe(403)
    expect((await out.del(`/api/projects/${p.id}`)).status).toBe(404)
    expect((await owner.del(`/api/projects/${p.id}`)).status).toBe(200)
    for (const c of [owner, ed, vi]) {
      expect((await c.get(`/api/projects/${p.id}`)).status).toBe(404)
      expect((await c.get('/api/projects')).body.some((x: { id: string }) => x.id === p.id)).toBe(false)
    }
    expect((await owner.get(`/api/projects/${p.id}/members`)).status).toBe(404)
    expect((ts.lig.db.prepare('SELECT deleted_at AS d FROM projects WHERE id = ?').get(p.id) as { d: number }).d).toBeGreaterThan(0)
    expect(auditEntries(ts.lig.db, 'project-delete')).toHaveLength(1)
    expect(auditEntries(ts.lig.db, 'project-create')).toHaveLength(3)
  })

  it('404 for malformed ids, unknown projects and non-members; 403 for members lacking the role', async () => {
    const { owner, vi, out } = await setup(39161)
    const p = await newProject(owner)
    await addMember(owner, vi, p.id, 'viewer')
    expect((await owner.get('/api/projects/not-a-uuid')).status).toBe(404)
    expect((await owner.get('/api/projects/3F0E8A52-1C1B-4C3E-9D4A-0B9A0D6C1E2F')).status).toBe(404)
    expect((await owner.get('/api/projects/3f0e8a52-1c1b-4c3e-9d4a-0b9a0d6c1e2f')).status).toBe(404)
    expect((await out.get(`/api/projects/${p.id}`)).status).toBe(404)
    expect((await vi.get(`/api/projects/${p.id}`)).body.role).toBe('viewer')
    expect((await vi.post(`/api/projects/${p.id}/compile`)).status).toBe(403)
    expect((await out.post(`/api/projects/${p.id}/compile`)).status).toBe(404)
    expect((await vi.post(`/api/projects/${p.id}/invites`, { role: 'viewer' })).status).toBe(403)
    expect((await out.post(`/api/projects/${p.id}/invites`, { role: 'viewer' })).status).toBe(404)
    expect((await vi.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'a.tex', kind: 'text' })).status).toBe(403)
    expect((await out.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'a.tex', kind: 'text' })).status).toBe(404)
    expect((await vi.upload(p.id, p.rootId, 'a.png', new Uint8Array([1, 2]))).status).toBe(403)
    expect((await out.upload(p.id, p.rootId, 'a.png', new Uint8Array([1, 2]))).status).toBe(404)
    expect((await new Client(owner.base).get(`/api/projects/${p.id}`)).status).toBe(401)
    expect((await new Client(owner.base).get('/api/projects')).status).toBe(401)
  })
})

describe('members', () => {
  it('role change, remove, leave, owner guards, transfer', async () => {
    const { ts, owner, ed, vi, out } = await setup(39162)
    const p = await newProject(owner)
    await addMember(owner, ed, p.id, 'editor')
    await addMember(owner, vi, p.id, 'viewer')
    const [ownerMe, edMe, viMe, outMe] = await Promise.all([me(owner), me(ed), me(vi), me(out)])
    const ms = await members(vi, p.id)
    expect(ms.map(m => [m.username, m.role])).toEqual([['owner', 'owner'], ['editor', 'editor'], ['viewer', 'viewer']])

    // role change: owner only, not self
    expect((await ed.patch(`/api/projects/${p.id}/members/${viMe.id}`, { role: 'editor' })).status).toBe(403)
    expect((await owner.patch(`/api/projects/${p.id}/members/${ownerMe.id}`, { role: 'editor' })).body.error).toBe('owner-immutable')
    expect((await owner.patch(`/api/projects/${p.id}/members/${viMe.id}`, { role: 'owner' })).status).toBe(400)
    expect((await owner.patch(`/api/projects/${p.id}/members/${outMe.id}`, { role: 'editor' })).status).toBe(404)
    expect((await owner.patch(`/api/projects/${p.id}/members/nope`, { role: 'editor' })).status).toBe(404)
    const up = await owner.patch(`/api/projects/${p.id}/members/${viMe.id}`, { role: 'editor' })
    expect(up.status).toBe(200)
    expect((await project(vi, p.id)).role).toBe('editor')
    await owner.patch(`/api/projects/${p.id}/members/${viMe.id}`, { role: 'viewer' })

    // remove: owner removes others; members can leave; owner cannot leave
    expect((await ed.del(`/api/projects/${p.id}/members/${viMe.id}`)).status).toBe(403)
    expect((await owner.del(`/api/projects/${p.id}/members/${ownerMe.id}`)).body.error).toBe('owner-must-transfer')
    expect((await ed.del(`/api/projects/${p.id}/members/${ownerMe.id}`)).status).toBe(403)
    expect((await vi.del(`/api/projects/${p.id}/members/${viMe.id}`)).status).toBe(200) // leave
    expect((await vi.get(`/api/projects/${p.id}`)).status).toBe(404)
    expect((await owner.del(`/api/projects/${p.id}/members/${viMe.id}`)).status).toBe(404)

    // transfer: target must be a member; old owner becomes editor
    expect((await owner.post(`/api/projects/${p.id}/transfer`, { userId: outMe.id })).status).toBe(404)
    expect((await ed.post(`/api/projects/${p.id}/transfer`, { userId: edMe.id })).status).toBe(403)
    expect((await owner.post(`/api/projects/${p.id}/transfer`, { userId: ownerMe.id })).status).toBe(400)
    const t = await owner.post(`/api/projects/${p.id}/transfer`, { userId: edMe.id })
    expect(t.status).toBe(200)
    expect((await project(ed, p.id)).role).toBe('owner')
    expect((await project(owner, p.id)).role).toBe('editor')
    const owners = (await members(ed, p.id)).filter(m => m.role === 'owner')
    expect(owners.map(m => m.userId)).toEqual([edMe.id])
    expect((await owner.get('/api/projects')).body[0].ownerName).toBe('editor')
    // the new owner removes the old one
    expect((await ed.del(`/api/projects/${p.id}/members/${ownerMe.id}`)).status).toBe(200)
    for (const a of ['member-role-change', 'member-remove', 'ownership-transfer', 'member-add'] as const) {
      expect(auditEntries(ts.lig.db, a).length).toBeGreaterThan(0)
    }
  })
})

describe('invites', () => {
  it('create, list, preview, accept, revoke, expiry, maxUses, higher role kept', async () => {
    const { ts, owner, ed, vi, out } = await setup(39163)
    const p = await newProject(owner, 'Invited')
    expect((await owner.post(`/api/projects/${p.id}/invites`, { role: 'owner' })).status).toBe(400)
    expect((await owner.post(`/api/projects/${p.id}/invites`, { role: 'viewer', expiresInHours: 721 })).status).toBe(400)
    expect((await owner.post(`/api/projects/${p.id}/invites`, { role: 'viewer', maxUses: 0 })).status).toBe(400)
    expect((await owner.post(`/api/projects/${p.id}/invites`, { role: 'viewer', maxUses: 1001 })).status).toBe(400)

    const t0 = Date.now()
    const inv = (await owner.post(`/api/projects/${p.id}/invites`, { role: 'viewer', maxUses: 2 })).body
    expect(inv).toMatchObject({ role: 'viewer', maxUses: 2, uses: 0, createdBy: 'Olive Owner', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
    expect(inv.expiresAt - t0).toBeGreaterThanOrEqual(168 * 3600_000 - 5000)
    expect(inv.expiresAt - t0).toBeLessThanOrEqual(168 * 3600_000 + 5000)
    // only the hash is stored
    expect(JSON.stringify(ts.lig.db.prepare('SELECT * FROM invites').all())).not.toContain(inv.token)

    const anon = new Client(ts.base)
    expect((await anon.get(`/api/invites/${inv.token}`)).body).toEqual({ projectName: 'Invited', role: 'viewer', invitedBy: 'Olive Owner', expiresAt: inv.expiresAt })
    expect((await anon.get('/api/invites/garbage')).body.error).toBe('invite-invalid')
    expect((await anon.post(`/api/invites/${inv.token}/accept`)).status).toBe(401)

    expect((await vi.post(`/api/invites/${inv.token}/accept`)).body).toEqual({ projectId: p.id })
    // already a member: no use consumed
    expect((await vi.post(`/api/invites/${inv.token}/accept`)).status).toBe(200)
    let list = (await owner.get(`/api/projects/${p.id}/invites`)).body
    expect(list).toEqual([expect.objectContaining({ id: inv.id, uses: 1 })])
    expect('token' in list[0]).toBe(false)
    expect((await vi.get(`/api/projects/${p.id}/invites`)).status).toBe(403)

    await out.post(`/api/invites/${inv.token}/accept`) // 2nd use: now used up
    expect((await anon.get(`/api/invites/${inv.token}`)).status).toBe(404)
    expect((await ed.post(`/api/invites/${inv.token}/accept`)).body.error).toBe('invite-invalid')
    expect((await owner.get(`/api/projects/${p.id}/invites`)).body).toEqual([])

    // higher role kept: viewer accepting an editor invite is upgraded; editor accepting a viewer invite stays editor
    const edInv = (await owner.post(`/api/projects/${p.id}/invites`, { role: 'editor' })).body
    expect(edInv.maxUses).toBeNull()
    await vi.post(`/api/invites/${edInv.token}/accept`)
    expect((await project(vi, p.id)).role).toBe('editor')
    const viInv = (await owner.post(`/api/projects/${p.id}/invites`, { role: 'viewer' })).body
    await vi.post(`/api/invites/${viInv.token}/accept`)
    expect((await project(vi, p.id)).role).toBe('editor')
    await owner.post(`/api/invites/${viInv.token}/accept`) // the owner stays owner
    expect((await project(owner, p.id)).role).toBe('owner')
    expect((await owner.get(`/api/projects/${p.id}/invites`)).body.find((i: { id: string }) => i.id === viInv.id).uses).toBe(0)

    // revoke
    expect((await ed.del(`/api/projects/${p.id}/invites/${viInv.id}`)).status).toBe(404) // not a member yet
    expect((await vi.del(`/api/projects/${p.id}/invites/${viInv.id}`)).status).toBe(403)
    expect((await owner.del(`/api/projects/${p.id}/invites/${viInv.id}`)).status).toBe(200)
    expect((await anon.get(`/api/invites/${viInv.token}`)).status).toBe(404)
    expect((await owner.del(`/api/projects/${p.id}/invites/3f0e8a52-1c1b-4c3e-9d4a-0b9a0d6c1e2f`)).status).toBe(404)

    // expiry
    const short = (await owner.post(`/api/projects/${p.id}/invites`, { role: 'viewer', expiresInHours: 1 })).body
    expect((await anon.get(`/api/invites/${short.token}`)).status).toBe(200)
    ts.lig.db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(Date.now() - 1, short.id)
    expect((await anon.get(`/api/invites/${short.token}`)).status).toBe(404)
    expect((await ed.post(`/api/invites/${short.token}/accept`)).status).toBe(404)

    // deleted project: invites die with it
    const live = (await owner.post(`/api/projects/${p.id}/invites`, { role: 'viewer' })).body
    await owner.del(`/api/projects/${p.id}`)
    expect((await anon.get(`/api/invites/${live.token}`)).status).toBe(404)
    for (const a of ['invite-create', 'invite-revoke', 'invite-accept'] as const) expect(auditEntries(ts.lig.db, a).length).toBeGreaterThan(0)
  })

  it('concurrent accepts of a maxUses=1 invite: exactly one joins', async () => {
    const { ts, owner } = await setup(39164)
    const p = await newProject(owner)
    const inv = (await owner.post(`/api/projects/${p.id}/invites`, { role: 'editor', maxUses: 1 })).body
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => signup(ts.base, `racer${i}`)))
    const res = await Promise.all(users.map(u => u.post(`/api/invites/${inv.token}/accept`)))
    expect(res.filter(r => r.status === 200)).toHaveLength(1)
    expect(res.filter(r => r.status === 404 && r.body.error === 'invite-invalid')).toHaveLength(5)
    expect((await members(owner, p.id))).toHaveLength(2)
    expect((ts.lig.db.prepare('SELECT uses FROM invites WHERE id = ?').get(inv.id) as { uses: number }).uses).toBe(1)
  })

  it('invite preview is rate limited per IP', async () => {
    const { ts } = await openInstance(39165, { rateLimits: { signupPerIp: 3 } }); servers.push(ts)
    const anon = new Client(ts.base)
    for (let i = 0; i < 3; i++) expect((await anon.get(`/api/invites/${'a'.repeat(43)}`)).status).toBe(404)
    expect((await anon.get(`/api/invites/${'a'.repeat(43)}`)).status).toBe(429)
  })
})
