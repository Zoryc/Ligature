import { afterEach, describe, expect, it } from 'vitest'
import { fileDocName, metaDocName, type ProjectDetail } from '@ligature/shared'
import { connect, sleep, waitFor } from './harness.ts'
import { addMember, me, newProject, openInstance, signup, type Client, type TestServer } from './inproc.ts'

/**
 * Revocation is immediate (docs/M1.md §3): real WebSockets against the in-process server.
 */
const servers: TestServer[] = []
const clients: { destroy(): void }[] = []
afterEach(async () => {
  clients.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

function open(base: string, c: Client, docName: string) {
  const x = connect(base, c.cookie, docName)
  clients.push(x)
  return x
}

async function setup(port: number) {
  const { ts, admin } = await openInstance(port); servers.push(ts)
  const owner = await signup(ts.base, 'owner')
  const bob = await signup(ts.base, 'bob')
  const p = await newProject(owner)
  await addMember(owner, bob, p.id, 'editor')
  const main = p.tree.find(f => f.name === 'main.tex')!
  const docName = fileDocName(p.id, main.id, main.epoch!)
  const bobId = (await me(bob)).id
  return { ts, admin, owner, bob, bobId, p: p as ProjectDetail, docName }
}

describe('revocation over real WebSockets', () => {
  it('removed member: socket closed, access-revoked broadcast, re-auth denied, later edits never land', async () => {
    const { ts, owner, bob, bobId, p, docName } = await setup(39170)
    const oFile = open(ts.base, owner, docName)
    const oMeta = open(ts.base, owner, metaDocName(p.id))
    const bFile = open(ts.base, bob, docName)
    const bMeta = open(ts.base, bob, metaDocName(p.id))
    await waitFor(() => [oFile, oMeta, bFile, bMeta].every(c => c.provider.isSynced), 10_000, 'sync')
    bFile.text().insert(0, 'bob was here ')
    await waitFor(() => oFile.text().toString().startsWith('bob was here'), 5_000, 'bob edit visible')

    expect((await owner.del(`/api/projects/${p.id}/members/${bobId}`)).status).toBe(200)
    await waitFor(() => bFile.closes.includes('access-revoked') && bMeta.closes.includes('access-revoked'), 5_000, 'bob closed')
    await waitFor(() => oMeta.events().some(e => e.type === 'access-revoked' && e.userId === bobId), 5_000, 'broadcast')
    expect(oMeta.events().some(e => e.type === 'members-changed')).toBe(true)
    expect(oFile.closes).toEqual([]) // the owner is unaffected

    // Edits typed after the close never reach the server.
    bFile.text().insert(0, 'AFTER REMOVAL ')
    await sleep(300)
    expect(oFile.text().toString()).not.toContain('AFTER REMOVAL')

    // Reconnect (new socket) is denied.
    const again = open(ts.base, bob, docName)
    const againMeta = open(ts.base, bob, metaDocName(p.id))
    await waitFor(() => again.denied() !== null && againMeta.denied() !== null, 5_000, 'denied')
    expect(again.denied()).toBe('forbidden')
    expect(againMeta.denied()).toBe('forbidden')
  })

  it('demoted editor is closed and reconnects read-only; promotion back restores write access', async () => {
    const { ts, owner, bob, bobId, p, docName } = await setup(39171)
    const oFile = open(ts.base, owner, docName)
    const bFile = open(ts.base, bob, docName)
    await waitFor(() => oFile.provider.isSynced && bFile.provider.isSynced, 10_000, 'sync')
    expect(bFile.provider.authorizedScope).toBe('read-write')

    await owner.patch(`/api/projects/${p.id}/members/${bobId}`, { role: 'viewer' })
    await waitFor(() => bFile.closes.includes('role-changed'), 5_000, 'closed')

    const ro = open(ts.base, bob, docName)
    await waitFor(() => ro.provider.isSynced, 10_000, 'ro sync')
    expect(ro.provider.authorizedScope).toBe('readonly')
    ro.text().insert(0, 'VIEWER EDIT ')
    oFile.text().insert(0, 'owner edit ')
    await waitFor(() => ro.text().toString().includes('owner edit'), 5_000, 'viewer receives owner edits')
    await sleep(300)
    expect(oFile.text().toString()).not.toContain('VIEWER EDIT')

    await owner.patch(`/api/projects/${p.id}/members/${bobId}`, { role: 'editor' })
    await waitFor(() => ro.closes.includes('role-changed'), 5_000, 'closed again')
    const rw = open(ts.base, bob, docName)
    await waitFor(() => rw.provider.isSynced, 10_000, 'rw sync')
    expect(rw.provider.authorizedScope).toBe('read-write')
    rw.text().insert(0, 'editor again ')
    await waitFor(() => oFile.text().toString().includes('editor again'), 5_000, 'edit lands')
  })

  it('deleted project: project-deleted broadcast, every socket closed, reconnect denied', async () => {
    const { ts, owner, bob, p, docName } = await setup(39172)
    const oFile = open(ts.base, owner, docName)
    const oMeta = open(ts.base, owner, metaDocName(p.id))
    const bFile = open(ts.base, bob, docName)
    await waitFor(() => [oFile, oMeta, bFile].every(c => c.provider.isSynced), 10_000, 'sync')
    oFile.text().insert(0, 'last words ')
    await waitFor(() => !oFile.provider.hasUnsyncedChanges, 5_000, 'acked')

    expect((await owner.del(`/api/projects/${p.id}`)).status).toBe(200)
    await waitFor(() => oMeta.events().some(e => e.type === 'project-deleted'), 5_000, 'event')
    await waitFor(() => [oFile, oMeta, bFile].every(c => c.closes.includes('project-deleted')), 5_000, 'all closed')
    expect(ts.lig.collab.hocuspocus.documents.has(docName)).toBe(false) // unloaded (compacted first)
    expect(ts.lig.store.storedText(docName)?.text).toContain('last words')

    const again = open(ts.base, owner, docName)
    await waitFor(() => again.denied() !== null, 5_000, 'denied')
    expect(again.denied()).toBe('forbidden')
  })

  it('disabled user: closed everywhere, reconnect denied as unauthenticated', async () => {
    const { ts, admin, bob, bobId, docName, p } = await setup(39173)
    const bFile = open(ts.base, bob, docName)
    const bMeta = open(ts.base, bob, metaDocName(p.id))
    await waitFor(() => bFile.provider.isSynced && bMeta.provider.isSynced, 10_000, 'sync')
    await admin.patch(`/api/admin/users/${bobId}`, { disabled: true })
    await waitFor(() => bFile.closes.includes('account-disabled') && bMeta.closes.includes('account-disabled'), 5_000, 'closed')
    const again = open(ts.base, bob, docName)
    await waitFor(() => again.denied() !== null, 5_000, 'denied')
    expect(again.denied()).toBe('unauthenticated')
  })

  it('password change closes the sockets of other sessions only', async () => {
    const { ts, bob, docName } = await setup(39174)
    const other = new (bob.constructor as typeof Client)(ts.base)
    await other.post('/api/auth/login', { username: 'bob', password: 'correct horse battery' })
    const mine = open(ts.base, bob, docName)
    const theirs = open(ts.base, other, docName)
    await waitFor(() => mine.provider.isSynced && theirs.provider.isSynced, 10_000, 'sync')
    expect((await bob.post('/api/me/password', { currentPassword: 'correct horse battery', newPassword: 'another password' })).status).toBe(200)
    await waitFor(() => theirs.closes.includes('session-ended'), 5_000, 'other session closed')
    await sleep(200)
    expect(mine.closes).toEqual([])
    const again = open(ts.base, other, docName)
    await waitFor(() => again.denied() !== null, 5_000, 'denied')
    expect(again.denied()).toBe('unauthenticated')
  })
})
