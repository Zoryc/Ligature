import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuditEntryView, AuditPage } from '@ligature/shared'
import type { DB } from '../src/db/index.ts'
import { addMember, Client, me, newProject, openInstance, signup, type TestServer } from './inproc.ts'

// Ports: 39620–39639 only (docs/M4.md §2 tests).
const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.stop() })

interface Row { actor?: string | null; project?: string | null; action: string; detail?: Record<string, unknown>; at: number }

/** Insert an audit row with a chosen timestamp (audit() always uses now). Returns its id. */
function put(db: DB, r: Row): number {
  return Number(db.prepare('INSERT INTO audit_log (actor_id, project_id, action, detail_json, at) VALUES (?, ?, ?, ?, ?)')
    .run(r.actor ?? null, r.project ?? null, r.action, r.detail ? JSON.stringify(r.detail) : null, r.at).lastInsertRowid)
}

async function page(c: Client, query = ''): Promise<AuditPage> {
  const r = await c.get<AuditPage>(`/api/admin/audit${query}`)
  if (r.status !== 200) throw new Error(`audit ${query}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}

const ids = (p: AuditPage) => p.entries.map(e => e.id)

describe('GET /api/admin/audit', () => {
  it('is for admins only: 403 for a non-admin, 401 without login', async () => {
    const { ts, admin } = await openInstance(39620); servers.push(ts)
    const u = await signup(ts.base, 'user1')
    expect((await u.get('/api/admin/audit')).status).toBe(403)
    expect((await new Client(ts.base).get('/api/admin/audit')).status).toBe(401)
    const r = await admin.get('/api/admin/audit')
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it('lists newest first and pages by id without gaps or repeats; reading is not audited', async () => {
    const { ts, admin } = await openInstance(39621); servers.push(ts)
    const db = ts.lig.db
    for (let i = 0; i < 23; i++) put(db, { action: 'login', at: 1000 + i })
    const all = (db.prepare('SELECT id FROM audit_log ORDER BY id DESC').all() as { id: number }[]).map(r => r.id)
    expect(all.length).toBeGreaterThan(23) // plus signup and settings-update from openInstance

    const first = await page(admin)
    expect(ids(first)).toEqual(all) // default limit 100 covers everything
    expect(first.next).toBeNull()

    const seen: number[] = []
    let before: number | null = null
    let pages = 0
    do {
      const p: AuditPage = await page(admin, `?limit=7${before !== null ? `&before=${before}` : ''}`)
      expect(p.entries.length).toBeLessThanOrEqual(7)
      seen.push(...ids(p))
      before = p.next
      pages++
    } while (before !== null)
    expect(seen).toEqual(all)
    expect(pages).toBe(Math.ceil(all.length / 7))

    // An exact multiple: the last full page says there is nothing older.
    const exact = await page(admin, `?limit=${all.length}`)
    expect(exact.next).toBeNull()
    const short = await page(admin, `?limit=${all.length - 1}`)
    expect(short.next).toBe(all[all.length - 2])

    // None of the reads above left a row.
    expect((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(all.length)
  })

  it('filters by category, actor, project and period, alone and combined', async () => {
    const { ts, admin } = await openInstance(39622); servers.push(ts)
    const db = ts.lig.db
    db.prepare('DELETE FROM audit_log').run()
    const alice = randomUUID(), bob = randomUUID(), p1 = randomUUID(), p2 = randomUUID()
    const a = put(db, { actor: alice, action: 'login', at: 1000 })
    const b = put(db, { actor: alice, project: p1, action: 'project-create', detail: { name: 'One' }, at: 2000 })
    const c = put(db, { actor: bob, project: p1, action: 'version.create', at: 3000 })
    const d = put(db, { actor: bob, project: p2, action: 'file-delete', detail: { name: 'x.tex' }, at: 4000 })
    const e = put(db, { actor: null, action: 'gc.run', at: 5000 })
    const f = put(db, { actor: alice, project: p2, action: 'some-future-action', at: 6000 })

    expect(ids(await page(admin))).toEqual([f, e, d, c, b, a])
    expect(ids(await page(admin, '?category=account'))).toEqual([a])
    expect(ids(await page(admin, '?category=projects'))).toEqual([d, b])
    expect(ids(await page(admin, '?category=history'))).toEqual([c])
    expect(ids(await page(admin, '?category=admin'))).toEqual([e])
    expect(ids(await page(admin, '?category=members'))).toEqual([])
    expect(ids(await page(admin, `?actor=${alice}`))).toEqual([f, b, a])
    expect(ids(await page(admin, `?project=${p1}`))).toEqual([c, b])
    expect(ids(await page(admin, '?since=3000'))).toEqual([f, e, d, c]) // inclusive
    expect(ids(await page(admin, '?until=3000'))).toEqual([b, a]) // exclusive
    expect(ids(await page(admin, '?since=2000&until=5000'))).toEqual([d, c, b])

    expect(ids(await page(admin, `?actor=${alice}&category=projects`))).toEqual([b])
    expect(ids(await page(admin, `?actor=${bob}&project=${p2}`))).toEqual([d])
    expect(ids(await page(admin, `?project=${p2}&since=5000`))).toEqual([f])
    expect(ids(await page(admin, `?actor=${alice}&since=1500&until=7000&limit=1`))).toEqual([f])
    expect(ids(await page(admin, `?actor=${alice}&since=1500&before=${f}`))).toEqual([b])

    const all = await page(admin)
    expect(all.entries.find(x => x.id === f)!.category).toBeNull() // unknown actions: no category
    expect(all.entries.find(x => x.id === e)!.actor).toBeNull() // the server itself
    // Ids without an account row (should not happen): empty names, shown as "a deleted account".
    expect(all.entries.find(x => x.id === a)!.actor).toEqual({ id: alice, username: '', displayName: '' })
  })

  it('names people and projects: actor, users named in detail, deleted and purged projects', async () => {
    const { ts, admin } = await openInstance(39623); servers.push(ts)
    const db = ts.lig.db
    const ed = await signup(ts.base, 'eddie', { displayName: 'Ed Itor' })
    const adminMe = await me(admin), edMe = await me(ed)

    const live = await newProject(admin, 'Live paper')
    const gone = await newProject(admin, 'Gone paper')
    const purged = await newProject(admin, 'Old name')
    await addMember(admin, ed, live.id, 'editor')
    expect((await admin.post(`/api/projects/${live.id}/transfer`, { userId: edMe.id })).status).toBe(200)
    expect((await admin.patch(`/api/projects/${purged.id}`, { name: 'Final name' })).status).toBe(200)
    expect((await admin.del(`/api/projects/${gone.id}`)).status).toBe(200)
    // A purge as maintenance does it, but without its own project.purge entry: the name still comes from
    // the trail (the rename), not from an unrelated row's detail.name (a file name).
    put(db, { actor: adminMe.id, project: purged.id, action: 'file-delete', detail: { fileId: randomUUID(), name: 'main.tex' }, at: Date.now() })
    db.transaction(() => {
      db.prepare('DELETE FROM files WHERE project_id = ?').run(purged.id)
      db.prepare('DELETE FROM projects WHERE id = ?').run(purged.id)
    })()
    const ghost = randomUUID()
    put(db, { actor: adminMe.id, project: live.id, action: 'member-remove', detail: { userId: ghost, role: 'viewer' }, at: Date.now() })

    const { entries } = await page(admin)
    const one = (action: string, projectId: string) => entries.find(e => e.action === action && e.project?.id === projectId)!

    const create = one('project-create', live.id)
    expect(create.actor).toEqual({ id: adminMe.id, username: 'admin', displayName: 'admin' })
    expect(create.project).toEqual({ id: live.id, name: 'Live paper', deleted: false })
    expect(create.category).toBe('projects')
    expect(create.detail).toEqual({ name: 'Live paper' })
    expect(create.users).toEqual({})

    const added = one('member-add', live.id)
    expect(added.actor?.id).toBe(edMe.id)
    expect(added.users).toEqual({ [edMe.id]: { id: edMe.id, username: 'eddie', displayName: 'Ed Itor' } })

    const transfer = one('ownership-transfer', live.id)
    expect(transfer.detail).toEqual({ from: adminMe.id, to: edMe.id })
    expect(Object.keys(transfer.users).sort()).toEqual([adminMe.id, edMe.id].sort())
    expect(transfer.users[adminMe.id]!.username).toBe('admin')

    // A user id with no account is left out of `users`.
    expect(one('member-remove', live.id).users).toEqual({})

    expect(one('project-delete', gone.id).project).toEqual({ id: gone.id, name: 'Gone paper', deleted: true })
    expect(one('project-create', gone.id).project).toEqual({ id: gone.id, name: 'Gone paper', deleted: true })

    const purgedRows = entries.filter(e => e.project?.id === purged.id)
    expect(purgedRows.length).toBeGreaterThanOrEqual(3) // create, rename, file-delete
    for (const e of purgedRows) expect(e.project).toEqual({ id: purged.id, name: 'Final name', deleted: true })
    const rename = purgedRows.find(e => e.action === 'project.setting')!
    expect(rename.detail).toEqual({ key: 'name', from: 'Old name', to: 'Final name' })

    // The project filter works for deleted and purged projects too.
    expect((await page(admin, `?project=${purged.id}`)).entries.map(e => e.id)).toEqual(purgedRows.map(e => e.id))
    expect((await page(admin, `?project=${gone.id}`)).entries.every((e: AuditEntryView) => e.project?.deleted)).toBe(true)
  })

  it('bad input is 400 bad-request; limit bounds', async () => {
    const { ts, admin } = await openInstance(39624); servers.push(ts)
    for (let i = 0; i < 205; i++) put(ts.lig.db, { action: 'login', at: i })
    expect((await page(admin, '?limit=1')).entries).toHaveLength(1)
    expect((await page(admin, '?limit=200')).entries).toHaveLength(200)
    expect((await page(admin)).entries).toHaveLength(100)
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'limit=-1', 'limit=', 'before=0', 'before=x', 'before=1e3',
      'category=everything', 'category=', 'actor=bob', 'project=..%2F..', 'since=-5', 'until=soon', `limit=${'9'.repeat(20)}`]) {
      const r = await admin.get(`/api/admin/audit?${q}`)
      expect(r.status, q).toBe(400)
      expect(r.body.error, q).toBe('bad-request')
    }
  })

  it('migration 6 adds the actor index, and the actor filter uses it', async () => {
    const { ts } = await openInstance(39625); servers.push(ts)
    const db = ts.lig.db
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(6)
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'audit_log_actor'").get() as { sql: string } | undefined
    expect(idx?.sql).toMatch(/audit_log\s*\(\s*actor_id\s*,\s*id\s*\)/)
    const plan = (db.prepare('EXPLAIN QUERY PLAN SELECT id FROM audit_log WHERE actor_id = ? ORDER BY id DESC LIMIT 10')
      .all('x') as { detail: string }[]).map(r => r.detail).join('\n')
    expect(plan).toContain('audit_log_actor')
  })
})
