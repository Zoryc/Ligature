import { afterEach, describe, expect, it } from 'vitest'
import { fileDocName, metaDocName, type AccountDeletionPreview, type ProjectDetail } from '@ligature/shared'
import { auditEntries, type AuditRow } from '../src/audit.ts'
import { connect, waitFor } from './harness.ts'
import { addMember, Client, me, members, newProject, openInstance, PASSWORD, signup, type TestServer } from './inproc.ts'

/* Deleting an account (docs/ACCOUNT-DELETION.md). Ports 39740–39759. */

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(s => s.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

function open(base: string, c: Client, docName: string) {
  const x = connect(base, c.cookie, docName)
  sockets.push(x)
  return x
}

const FORMER = 'a former member'
const deleteMe = (c: Client, password = PASSWORD) => c.req('DELETE', '/api/me', { password })
const adminDelete = (c: Client, id: string, confirmUsername: string) => c.req('DELETE', `/api/admin/users/${id}`, { confirmUsername })
const mainOf = (p: ProjectDetail) => p.tree.find(f => f.name === 'main.tex')!

async function start(port: number) {
  const { ts, admin } = await openInstance(port)
  servers.push(ts)
  return { ts, admin, db: ts.lig.db }
}

/** Alice: a project of her own, one she owns with Bob, and Bob's project she edits. */
async function aliceWorld(port: number) {
  const s = await start(port)
  const alice = await signup(s.ts.base, 'alice', { displayName: 'Alice Liddell' })
  const bob = await signup(s.ts.base, 'bob', { displayName: 'Bob Builder' })
  const aliceId = (await me(alice)).id
  const bobId = (await me(bob)).id
  const solo = await newProject(alice, 'Solo')
  const shared = await newProject(alice, 'Shared')
  await addMember(alice, bob, shared.id, 'editor')
  const bobs = await newProject(bob, 'Bobs paper')
  await addMember(bob, alice, bobs.id, 'editor')
  // An invite of hers nobody used: it must not outlive her.
  expect((await alice.post(`/api/projects/${solo.id}/invites`, { role: 'viewer' })).status).toBe(200)
  return { ...s, alice, bob, aliceId, bobId, solo, shared, bobs }
}

const countOf = (db: TestServer['lig']['db'], sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n

describe('account deletion', () => {
  it('preview; self-deletion refused while it owns a shared project, allowed after a transfer', async () => {
    const { alice, bobId, solo, shared, bobs } = await aliceWorld(39740)
    const pre = (await alice.get<AccountDeletionPreview>('/api/me/deletion')).body
    expect(pre).toEqual({
      deletedProjects: [{ id: solo.id, name: 'Solo' }],
      sharedOwned: [{ id: shared.id, name: 'Shared', newOwner: { userId: bobId, displayName: 'Bob Builder' } }],
      leftProjects: 1,
      blocked: 'owns-shared-projects',
    })
    const refused = await deleteMe(alice)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('owns-shared-projects')
    expect((await me(alice)).id).toBeDefined() // nothing happened

    expect((await alice.post(`/api/projects/${shared.id}/transfer`, { userId: bobId })).status).toBe(200)
    const after = (await alice.get<AccountDeletionPreview>('/api/me/deletion')).body
    expect(after).toEqual({ deletedProjects: [{ id: solo.id, name: 'Solo' }], sharedOwned: [], leftProjects: 2, blocked: null })
    expect((await alice.get(`/api/projects/${bobs.id}`)).status).toBe(200)
  })

  it('wrong password: 403, nothing deleted, rate-limited like login', async () => {
    const { ts, alice, aliceId } = await aliceWorld(39741)
    const r = await deleteMe(alice, 'not the password')
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('wrong-password')
    expect((await me(alice)).id).toBe(aliceId)
    expect((await alice.req('DELETE', '/api/me', { password: PASSWORD, extra: 1 })).status).toBe(400)
    expect((await new Client(ts.base).req('DELETE', '/api/me', { password: PASSWORD })).status).toBe(401)
    for (let i = 0; i < 9; i++) await deleteMe(alice, 'not the password')
    expect((await deleteMe(alice, 'not the password')).status).toBe(429)
    expect((await deleteMe(alice)).status).toBe(429) // even the right one, until the window ends
  })

  it('self-deletion: account, sessions, memberships, invites gone; projects, history, trash and audit as specified', async () => {
    const { ts, db, admin, alice, bob, aliceId, bobId, solo, shared, bobs } = await aliceWorld(39742)
    const base = ts.base
    await alice.post(`/api/projects/${shared.id}/transfer`, { userId: bobId })
    // A failed login with her username, and a password login (with an ip) of hers.
    await new Client(base).post('/api/auth/login', { username: 'alice', password: 'wrong password!' })
    expect((await new Client(base).post('/api/auth/login', { username: 'alice', password: PASSWORD })).status).toBe(200)

    // Her work in Bob's project: a file, a named version, a trashed file, a setting.
    const root = bobs.tree.find(f => f.parentId === null)!
    const kept = await alice.post(`/api/projects/${bobs.id}/files`, { parentId: root.id, name: 'alice.tex', kind: 'text', content: 'Alice wrote this' })
    expect(kept.status).toBe(200)
    expect((await alice.post(`/api/projects/${bobs.id}/versions`, { label: 'by Alice' })).status).toBe(200)
    const scratch = await alice.post(`/api/projects/${bobs.id}/files`, { parentId: root.id, name: 'scratch.tex', kind: 'text', content: 'x' })
    expect((await alice.del(`/api/projects/${bobs.id}/files/${scratch.body.id}`)).status).toBe(200)
    expect((await alice.patch(`/api/projects/${bobs.id}`, { engine: 'xelatex' })).status).toBe(200)

    // Live sockets: hers (Bob's file, her own project's meta doc) and Bob's meta doc.
    const docName = fileDocName(bobs.id, mainOf(bobs).id, mainOf(bobs).epoch!)
    const aFile = open(base, alice, docName)
    const aSolo = open(base, alice, metaDocName(solo.id))
    const bMeta = open(base, bob, metaDocName(bobs.id))
    const bShared = open(base, bob, metaDocName(shared.id))
    await waitFor(() => [aFile, aSolo, bMeta, bShared].every(c => c.provider.isSynced), 10_000, 'sync')

    const oldCookie = alice.cookie
    const r = await deleteMe(alice)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ projectsDeleted: 1, ownershipTransferred: 0, projectsLeft: 2 })
    expect(alice.cookie).toBe('') // cookie cleared

    // Sockets: hers closed as session-ended; Bob told she left.
    await waitFor(() => aFile.closes.includes('session-ended') && aSolo.closes.includes('session-ended'), 5_000, 'her sockets closed')
    await waitFor(() => bMeta.events().some(e => e.type === 'access-revoked' && e.userId === aliceId), 5_000, 'access-revoked')
    await waitFor(() => bShared.events().some(e => e.type === 'access-revoked' && e.userId === aliceId), 5_000, 'access-revoked (shared)')
    expect(bMeta.events().some(e => e.type === 'members-changed')).toBe(true)

    // Rows.
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM users WHERE id = ?', aliceId)).toBe(0)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', aliceId)).toBe(0)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM project_members WHERE user_id = ?', aliceId)).toBe(0)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM invites WHERE created_by = ?', aliceId)).toBe(0)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM projects WHERE id = ? AND deleted_at IS NOT NULL', solo.id)).toBe(1)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL AND id IN (?, ?)', shared.id, bobs.id)).toBe(2)
    expect((await members(bob, shared.id)).map(m => [m.userId, m.role])).toEqual([[bobId, 'owner']])
    expect((await alice.get('/api/me')).status).toBe(401)

    // Her text stays; names show as a former member.
    expect((await bob.get(`/api/projects/${bobs.id}/files/${kept.body.id}/raw`)).body).toBe('Alice wrote this')
    const versions = (await bob.get(`/api/projects/${bobs.id}/versions`)).body.versions as { label: string | null; createdBy: string; authors: string[] }[]
    const named = versions.find(v => v.label === 'by Alice')!
    expect(named.createdBy).toBe(FORMER)
    expect(named.authors).toEqual([FORMER])
    const trash = (await bob.get(`/api/projects/${bobs.id}/trash`)).body as { name: string; deletedBy: string }[]
    expect(trash.find(t => t.name === 'scratch.tex')!.deletedBy).toBe(FORMER)
    const settings = (await bob.get<ProjectDetail>(`/api/projects/${bobs.id}`)).body.changes
    expect(settings.engine).toMatchObject({ byUserId: aliceId, by: '' }) // the web says "a former member"
    const storage = (await admin.get('/api/admin/storage')).body.projects as { id: string; owner: string }[]
    expect(storage.find(p => p.id === solo.id)!.owner).toBe(FORMER)

    // Audit: entries kept, her personal data gone, one account.delete entry without a name.
    const all = auditEntries(db)
    const json = JSON.stringify(all)
    expect(json).not.toContain('alice')
    expect(json).not.toContain('Alice Liddell')
    const hers = all.filter(e => e.actorId === aliceId || (e.detail as { userId?: string } | null)?.userId === aliceId)
    expect(hers.some(e => e.action === 'signup')).toBe(true)
    for (const e of hers) expect(e.detail ?? {}).not.toHaveProperty('ip')
    const failures = all.filter(e => e.action === 'login-failure')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.detail).toEqual({})
    const del = auditEntries(db, 'account.delete')
    expect(del).toEqual([expect.objectContaining({
      actorId: aliceId, projectId: null,
      detail: { userId: aliceId, by: 'self', projectsDeleted: 1, ownershipTransferred: 0, projectsLeft: 2 },
    })])
    expect(auditEntries(db, 'project-delete').find(e => e.projectId === solo.id)?.detail).toEqual({ name: 'Solo', reason: 'account-deleted' })
    const page = (await admin.get(`/api/admin/audit?actor=${aliceId}`)).body
    expect(page.entries[0]).toMatchObject({ action: 'account.delete', category: 'admin', actor: { id: aliceId, username: '', displayName: '' } })

    // The username is free again.
    const again = await signup(base, 'alice')
    expect((await me(again)).id).not.toBe(aliceId)
    // A reconnect with her old session cookie is refused.
    const retry = connect(base, oldCookie, docName); sockets.push(retry)
    await waitFor(() => retry.denied() !== null, 5_000, 'denied')
    expect(retry.denied()).toBe('unauthenticated')
  })

  it('admin deletion: ownership to the earliest editor (else viewer), audited; preview names the new owners', async () => {
    const { ts, db, admin } = await start(39743)
    const adminId = (await me(admin)).id
    const dave = await signup(ts.base, 'dave')
    const erin = await signup(ts.base, 'erin', { displayName: 'Erin' })
    const frank = await signup(ts.base, 'frank', { displayName: 'Frank' })
    const gina = await signup(ts.base, 'gina', { displayName: 'Gina' })
    const daveId = (await me(dave)).id
    const erinId = (await me(erin)).id
    const frankId = (await me(frank)).id
    const ginaId = (await me(gina)).id
    const team = await newProject(dave, 'Team')
    await addMember(dave, erin, team.id, 'viewer') // earliest, but a viewer
    await addMember(dave, gina, team.id, 'editor')
    await addMember(dave, frank, team.id, 'editor') // a later editor
    const viewers = await newProject(dave, 'Viewers')
    await addMember(dave, erin, viewers.id, 'viewer')
    await addMember(dave, frank, viewers.id, 'viewer')
    const mine = await newProject(dave, 'Mine')
    await dave.post(`/api/projects/${team.id}/invites`, { role: 'editor' })

    const eMeta = open(ts.base, erin, metaDocName(team.id))
    const gMeta = open(ts.base, gina, metaDocName(team.id))
    await waitFor(() => eMeta.provider.isSynced && gMeta.provider.isSynced, 10_000, 'sync')

    const pre = (await admin.get<AccountDeletionPreview>(`/api/admin/users/${daveId}/deletion`)).body
    expect(pre).toEqual({
      deletedProjects: [{ id: mine.id, name: 'Mine' }],
      sharedOwned: [
        { id: team.id, name: 'Team', newOwner: { userId: ginaId, displayName: 'Gina' } },
        { id: viewers.id, name: 'Viewers', newOwner: { userId: erinId, displayName: 'Erin' } },
      ],
      leftProjects: 0,
      blocked: null,
    })
    // Self-deletion would be refused for the same account.
    expect((await dave.get<AccountDeletionPreview>('/api/me/deletion')).body.blocked).toBe('owns-shared-projects')

    const mismatch = await adminDelete(admin, daveId, 'Dave')
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error).toBe('confirm-mismatch')
    expect((await me(dave)).id).toBe(daveId)
    expect((await admin.req('DELETE', `/api/admin/users/${daveId}`, {})).status).toBe(400)
    expect((await erin.req('DELETE', `/api/admin/users/${daveId}`, { confirmUsername: 'dave' })).status).toBe(403)
    expect((await adminDelete(admin, '3f0e8a52-1c1b-4c3e-9d4a-0b9a0d6c1e2f', 'x')).status).toBe(404)
    expect((await admin.get('/api/admin/users/not-a-uuid/deletion')).status).toBe(404)

    const r = await adminDelete(admin, daveId, 'dave')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ projectsDeleted: 1, ownershipTransferred: 2, projectsLeft: 0 })
    expect((await dave.get('/api/me')).status).toBe(401)
    expect(admin.cookie).not.toBe('') // the admin stays logged in

    const roles = async (pid: string) => (await members(erin, pid)).map(m => [m.userId, m.role]).sort()
    expect(await roles(team.id)).toEqual([[erinId, 'viewer'], [frankId, 'editor'], [ginaId, 'owner']].sort())
    expect(await roles(viewers.id)).toEqual([[erinId, 'owner'], [frankId, 'viewer']].sort())
    expect((await gina.patch(`/api/projects/${team.id}`, { name: 'Team (Gina)' })).status).toBe(200) // owner rights
    await waitFor(() => eMeta.events().some(e => e.type === 'access-revoked' && e.userId === daveId), 5_000, 'access-revoked')
    expect(eMeta.events().map(e => e.type)).toEqual(expect.arrayContaining(['members-changed', 'project-changed']))
    await waitFor(() => gMeta.closes.includes('role-changed'), 5_000, 'new owner reconnects with the new role')
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM invites')).toBe(0)

    const transfers = auditEntries(db, 'ownership-transfer')
    expect(transfers.map(t => [t.actorId, t.projectId, t.detail])).toEqual([
      [adminId, team.id, { from: daveId, to: ginaId, reason: 'account-deleted' }],
      [adminId, viewers.id, { from: daveId, to: erinId, reason: 'account-deleted' }],
    ])
    expect(auditEntries(db, 'account.delete')).toEqual([expect.objectContaining({
      actorId: adminId, detail: { userId: daveId, by: 'admin', projectsDeleted: 1, ownershipTransferred: 2, projectsLeft: 0 },
    })])
    expect((await admin.get('/api/admin/users')).body.map((u: { id: string }) => u.id)).not.toContain(daveId)
  })

  it('last admin: refused for self and in the preview; an admin cannot use the admin route on themselves', async () => {
    const { ts, admin } = await start(39744)
    const adminId = (await me(admin)).id
    expect((await admin.get<AccountDeletionPreview>('/api/me/deletion')).body.blocked).toBe('last-admin')
    const r = await deleteMe(admin)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('last-admin')

    for (const res of [await adminDelete(admin, adminId, 'admin'), await admin.get(`/api/admin/users/${adminId}/deletion`)]) {
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('use-account-page')
    }

    // A second admin who is disabled does not count; once enabled, the first may go.
    const sam = await signup(ts.base, 'sam')
    const samId = (await me(sam)).id
    await admin.patch(`/api/admin/users/${samId}`, { isAdmin: true, disabled: true })
    expect((await deleteMe(admin)).body.error).toBe('last-admin')
    // A disabled admin is not an active admin: it can be deleted.
    expect((await admin.get<AccountDeletionPreview>(`/api/admin/users/${samId}/deletion`)).body.blocked).toBe(null)
    await admin.patch(`/api/admin/users/${samId}`, { disabled: false })
    expect((await deleteMe(admin)).status).toBe(200)
    const samAgain = new Client(ts.base)
    expect((await samAgain.post('/api/auth/login', { username: 'sam', password: PASSWORD })).status).toBe(200)
    expect((await samAgain.get('/api/admin/users')).body.map((u: { username: string }) => u.username)).toEqual(['sam'])
  })

  it('is atomic: a failure at the last step leaves everything as it was', async () => {
    const { db, alice, aliceId, bobId, solo, shared, bobs } = await aliceWorld(39745)
    await alice.post(`/api/projects/${shared.id}/transfer`, { userId: bobId })
    const auditBefore: AuditRow[] = auditEntries(db)
    db.exec(`CREATE TRIGGER fail_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`)
    const r = await deleteMe(alice)
    expect(r.status).toBe(500)
    expect(auditEntries(db)).toEqual(auditBefore) // no scrub, no project-delete, no account.delete
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM projects WHERE id = ? AND deleted_at IS NULL', solo.id)).toBe(1)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM invites WHERE created_by = ?', aliceId)).toBe(2) // Bob's (used) and Solo's
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM project_members WHERE user_id = ?', aliceId)).toBe(3)
    expect((await me(alice)).id).toBe(aliceId) // still logged in
    expect(alice.cookie).not.toBe('')
    expect((await alice.get(`/api/projects/${bobs.id}`)).status).toBe(200)

    db.exec('DROP TRIGGER fail_user_delete')
    expect((await deleteMe(alice)).status).toBe(200)
    expect(countOf(db, 'SELECT COUNT(*) AS n FROM users WHERE id = ?', aliceId)).toBe(0)
  })
})
