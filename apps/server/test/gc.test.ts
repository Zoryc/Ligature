import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileDocName, type GcReport, type ProjectDetail, type StorageReport, type TrashEntry, type TreeEntry } from '@ligature/shared'
import { auditEntries } from '../src/audit.ts'
import { openDb } from '../src/db/index.ts'
import { BlobStore } from '../src/files/blobStore.ts'
import { removeOrphanDocs } from '../src/maintenance/orphanDocs.ts'
import { MAIN_TEMPLATE } from '../src/projects/service.ts'
import { Client, newProject, openInstance, PASSWORD, signup, startTestServer, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'
import { sleep, waitFor } from './harness.ts'

/* Blob GC, orphan docs, project purge, thinning and trash retention via the GC, the admin storage routes (docs/M3.md §3, §5). */

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.stop() })

const DAY = 24 * 60 * 60 * 1000
const hashOf = (b: Uint8Array) => BlobStore.hashOf(b)

async function setup(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const { ts, admin } = await openInstance(port, { history: { tickMs: 3_600_000 }, ...opts }); servers.push(ts)
  const p = await newProject(admin)
  return { ts, admin, p }
}

async function upload(c: Client, p: ProjectDetail, name: string, data: Uint8Array): Promise<TreeEntry> {
  const r = await c.upload(p.id, p.rootId, name, data)
  if (r.status !== 200) throw new Error(`upload ${name}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}

/** Upload, delete and purge from the trash: the blob is then unreferenced. */
async function orphanBlob(c: Client, p: ProjectDetail, name: string, data: Uint8Array): Promise<string> {
  const f = await upload(c, p, name, data)
  expect((await c.del(`/api/projects/${p.id}/files/${f.id}`)).status).toBe(200)
  expect((await c.del(`/api/projects/${p.id}/trash/${f.id}`)).status).toBe(200)
  return hashOf(data)
}

function blobFiles(dir: string): string[] {
  const out: string[] = []
  for (const sub of readdirSync(dir)) {
    if (!/^[0-9a-f]{2}$/.test(sub)) continue
    for (const n of readdirSync(join(dir, sub))) if (/^[0-9a-f]{62}$/.test(n)) out.push(sub + n)
  }
  return out
}

/** Make every blob (except `keep`) look written two days ago: row and file mtime. */
function ageBlobs(ts: TestServer, keep: string[] = []) {
  const old = Date.now() - 2 * DAY
  ts.lig.db.prepare('UPDATE blobs SET created_at = ? WHERE hash NOT IN (SELECT value FROM json_each(?))').run(old, JSON.stringify(keep))
  for (const h of blobFiles(ts.lig.blobs.dir)) if (!keep.includes(h)) utimesSync(ts.lig.blobs.pathOf(h), new Date(old), new Date(old))
}

const hasRow = (ts: TestServer, h: string) => ts.lig.db.prepare('SELECT 1 FROM blobs WHERE hash = ?').get(h) !== undefined

async function gc(c: Client): Promise<GcReport> {
  const r = await c.post<GcReport>('/api/admin/gc')
  expect(r.status).toBe(200)
  return r.body
}

describe('blob GC safety', () => {
  it('keeps blobs referenced only by an old version or only by a trashed file; removes unreferenced old blobs; spares fresh ones', async () => {
    const { ts, admin, p } = await setup(39202)
    const A = makePng(4, 4, [1, 2, 3]), A2 = makePng(4, 4, [9, 9, 9]), B = makePng(5, 5, [4, 5, 6]), C = makePng(6, 6, [7, 8, 9])
    await upload(admin, p, 'a.png', A)
    const named = await admin.post(`/api/projects/${p.id}/versions`, { label: 'with A' })
    expect(named.status).toBe(200)
    await upload(admin, p, 'a.png', A2) // replaces a.png: A is now only in the version
    const b = await upload(admin, p, 'b.png', B)
    expect((await admin.del(`/api/projects/${p.id}/files/${b.id}`)).status).toBe(200) // B only in the trash
    const hC = await orphanBlob(admin, p, 'c.png', C)
    const [hA, hB] = [hashOf(A), hashOf(B)]
    const db = ts.lig.db
    // Preconditions: A only in a version, B only in a trashed file, C nowhere.
    expect(db.prepare('SELECT 1 FROM files WHERE blob_hash = ?').get(hA)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM version_files WHERE blob_hash = ?').get(hA)).toBeDefined()
    expect(db.prepare('SELECT deleted_at AS d FROM files WHERE blob_hash = ?').get(hB)).toMatchObject({ d: expect.any(Number) })
    expect(db.prepare('SELECT 1 FROM version_files WHERE blob_hash = ?').get(hB)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM version_files WHERE blob_hash = ? UNION SELECT 1 FROM files WHERE blob_hash = ?').get(hC, hC)).toBeUndefined()

    ageBlobs(ts)
    const D = makePng(7, 7, [10, 11, 12])
    const hD = ts.lig.blobs.put(D) // unreferenced but fresh: inside the grace period

    const before = (await admin.get<StorageReport>('/api/admin/storage')).body
    expect(before.unreferenced).toEqual({ count: 2, bytes: C.byteLength + D.byteLength })

    const report = await gc(admin)
    expect(report).toMatchObject({ blobsRemoved: 1, bytesFreed: C.byteLength, projectsPurged: 0 })
    expect(ts.lig.blobs.has(hC)).toBe(false)
    expect(hasRow(ts, hC)).toBe(false)
    for (const h of [hA, hB, hD]) { expect(ts.lig.blobs.has(h)).toBe(true); expect(hasRow(ts, h)).toBe(true) }

    // A is still served from the version, B comes back from the trash intact.
    const vf = await admin.req('GET', `/api/projects/${p.id}/versions/${named.body.id}/file?path=a.png`)
    expect(vf.status).toBe(200)
    expect(Buffer.from(await vf.raw.arrayBuffer()).equals(A)).toBe(true)
    expect((await admin.post(`/api/projects/${p.id}/trash/${b.id}/restore`)).status).toBe(200)
    const raw = await admin.req('GET', `/api/projects/${p.id}/files/${b.id}/raw`)
    expect(Buffer.from(await raw.raw.arrayBuffer()).equals(B)).toBe(true)

    // Text snapshots of the versions are blobs too: all still there.
    const textHashes = db.prepare("SELECT DISTINCT blob_hash AS h FROM version_files WHERE kind = 'text'").all() as { h: string }[]
    expect(textHashes.length).toBeGreaterThan(0)
    for (const { h } of textHashes) expect(ts.lig.blobs.has(h)).toBe(true)

    const after = (await admin.get<StorageReport>('/api/admin/storage')).body
    expect(after.unreferenced).toEqual({ count: 1, bytes: D.byteLength })
    expect(after.lastGc).toEqual(report)
  })

  it('a blob uploaded, written or created during the sweep survives', async () => {
    const { ts, admin, p } = await setup(39203)
    const E = makePng(8, 8, [1, 1, 1]), F = makePng(9, 9, [2, 2, 2]), G = makePng(10, 10, [3, 3, 3]), H = makePng(11, 11, [4, 4, 4])
    const hE = await orphanBlob(admin, p, 'e.png', E)
    const hF = await orphanBlob(admin, p, 'f.png', F)
    const hH = await orphanBlob(admin, p, 'h.png', H)
    ageBlobs(ts)
    let listed: readonly string[] = []
    let e2: TreeEntry | null = null
    const report = await ts.lig.maintenance.runGc({
      hooks: {
        afterList: async hashes => {
          listed = hashes
          e2 = await upload(admin, p, 'e2.png', E) // the same content again, committed during the sweep
          await ts.lig.blobs.write(F, hF) // an upload in flight: file written, its reference not committed yet
          ts.lig.blobs.put(G) // a brand-new blob
        },
      },
    })
    expect(listed).toEqual(expect.arrayContaining([hE, hF, hH]))
    expect(listed).not.toContain(hashOf(G))
    // H had nothing writing it: removed in the same run, so the sweep really ran.
    expect(report.blobsRemoved).toBe(1)
    expect(ts.lig.blobs.has(hH)).toBe(false)
    for (const h of [hE, hF, hashOf(G)]) expect(ts.lig.blobs.has(h)).toBe(true)
    const raw = await admin.req('GET', `/api/projects/${p.id}/files/${e2!.id}/raw`)
    expect(Buffer.from(await raw.raw.arrayBuffer()).equals(E)).toBe(true)
  })

  it('removes leftover temp files and dangling rows; keeps referenced rows', async () => {
    const { ts, admin } = await setup(39204)
    const dir = ts.lig.blobs.dir
    mkdirSync(join(dir, 'ab'), { recursive: true })
    const oldTmp = join(dir, 'ab', '.tmp-0123456789abcdef')
    const newTmp = join(dir, 'ab', '.tmp-fedcba9876543210')
    writeFileSync(oldTmp, 'partial'); writeFileSync(newTmp, 'in flight')
    utimesSync(oldTmp, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY))
    const ghost = 'f'.repeat(64)
    ts.lig.db.prepare('INSERT INTO blobs (hash, size, created_at) VALUES (?, 10, ?)').run(ghost, Date.now() - 2 * DAY)
    await gc(admin)
    expect(existsSync(oldTmp)).toBe(false)
    expect(existsSync(newTmp)).toBe(true)
    expect(hasRow(ts, ghost)).toBe(false)
  })
})

describe('GC runs', () => {
  it('never runs twice at once; the last report is persisted and audited', async () => {
    const port = 39205
    const { ts, admin } = await setup(port)
    const [r1, r2] = await Promise.all([admin.post<GcReport>('/api/admin/gc'), admin.post<GcReport>('/api/admin/gc')])
    expect(r1.status).toBe(200)
    expect(r2.body).toEqual(r1.body)
    expect(auditEntries(ts.lig.db, 'gc.run')).toHaveLength(1)
    expect(auditEntries(ts.lig.db, 'gc.run')[0]).toMatchObject({ actorId: expect.any(String), detail: { trigger: 'admin', blobsRemoved: 0 } })
    expect(ts.lig.maintenance.isRunning()).toBe(false)
    const third = await gc(admin)
    expect(third.at).toBeGreaterThanOrEqual(r1.body.at)

    await ts.stop(); servers.splice(servers.indexOf(ts), 1)
    const ts2 = await startTestServer(39216, { dataDir: ts.dataDir }); servers.push(ts2) // a fresh port: no pooled keep-alive sockets
    const again = new Client(ts2.base)
    expect((await again.post('/api/auth/login', { username: 'admin', password: PASSWORD })).status).toBe(200)
    expect((await again.get<StorageReport>('/api/admin/storage')).body.lastGc).toEqual(third)
  })

  it('the scheduler runs the GC when the last run is old enough', async () => {
    let now = Date.now()
    const { ts } = await setup(39206, { clock: () => now, gc: { startupDelayMs: 20, checkMs: 40, intervalMs: DAY } })
    await waitFor(() => ts.lig.maintenance.lastReport() !== null, 5_000, 'first scheduled run')
    const first = ts.lig.maintenance.lastReport()!
    expect(auditEntries(ts.lig.db, 'gc.run')[0]).toMatchObject({ actorId: null, detail: { trigger: 'schedule' } })
    await sleep(200) // several checks: not due again
    expect(auditEntries(ts.lig.db, 'gc.run')).toHaveLength(1)
    now += DAY
    await waitFor(() => ts.lig.maintenance.lastReport()!.at > first.at, 5_000, 'second scheduled run')
    expect(auditEntries(ts.lig.db, 'gc.run')).toHaveLength(2)
  })

  it('admin only, Origin-checked', async () => {
    const { ts, p } = await setup(39207)
    const user = await signup(ts.base, 'someone')
    const anon = new Client(ts.base)
    const fileId = p.tree.find(f => f.name === 'main.tex')!.id
    for (const [m, path] of [['GET', '/api/admin/storage'], ['POST', '/api/admin/gc'], ['POST', `/api/admin/files/${fileId}/rebuild`]] as const) {
      expect((await user.req(m, path, m === 'POST' ? {} : undefined)).status).toBe(403)
      expect((await anon.req(m, path, m === 'POST' ? {} : undefined)).status).toBe(401)
    }
    const admin = new Client(ts.base)
    await admin.post('/api/auth/login', { username: 'admin', password: PASSWORD })
    expect((await admin.req('POST', '/api/admin/gc', {}, { origin: 'http://evil.example' })).status).toBe(403)
    expect(auditEntries(ts.lig.db, 'gc.run')).toHaveLength(0)
  })
})

describe('GC housekeeping', () => {
  it('purges soft-deleted projects past the retention (rows, docs, versions, outputs); later sweeps free their blobs', async () => {
    const { ts, admin, p } = await setup(39208)
    const keep = await newProject(admin, 'Recently deleted')
    const X = makePng(12, 12, [5, 5, 5])
    await upload(admin, p, 'x.png', X)
    expect((await admin.post(`/api/projects/${p.id}/versions`, { label: 'v' })).status).toBe(200)
    const outputs = join(ts.dataDir, 'outputs', p.id, 'some-build')
    mkdirSync(outputs, { recursive: true }); writeFileSync(join(outputs, 'output.pdf'), 'pdf')
    expect((await admin.del(`/api/projects/${p.id}`)).status).toBe(200)
    expect((await admin.del(`/api/projects/${keep.id}`)).status).toBe(200)
    const db = ts.lig.db
    db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(Date.now() - 31 * DAY, p.id)
    db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(Date.now() - 10 * DAY, keep.id)

    const listed = (await admin.get<StorageReport>('/api/admin/storage')).body.projects
    expect(listed.find(x => x.id === p.id)).toMatchObject({ deleted: true, owner: 'admin' })

    const r1 = await gc(admin)
    expect(r1.projectsPurged).toBe(1)
    const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n
    expect(count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', p.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM files WHERE project_id = ?', p.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?', p.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?', p.id)).toBe(0)
    expect(count("SELECT COUNT(*) AS n FROM doc_state WHERE doc_name LIKE 'proj/' || ? || '/%'", p.id)).toBe(0)
    expect(existsSync(join(ts.dataDir, 'outputs', p.id))).toBe(false)
    expect(count('SELECT COUNT(*) AS n FROM projects WHERE id = ?', keep.id)).toBe(1)
    expect(auditEntries(db, 'project.purge')).toMatchObject([{ projectId: p.id, actorId: null }])
    // Its blobs were written moments ago (grace period); once old, the next sweep frees them.
    expect(ts.lig.blobs.has(hashOf(X))).toBe(true)
    ageBlobs(ts)
    const r2 = await gc(admin)
    expect(ts.lig.blobs.has(hashOf(X))).toBe(false)
    expect(r2.blobsRemoved).toBeGreaterThanOrEqual(2) // x.png and the text snapshot of main.tex
    expect(r2.projectsPurged).toBe(0)
  })

  it('removes orphan doc rows past the grace period (missing file, stale epoch), keeps the rest', async () => {
    const { ts, admin, p } = await setup(39209)
    const db = ts.lig.db
    const main = p.tree.find(f => f.name === 'main.tex')!
    const current = fileDocName(p.id, main.id, 1)
    const missing = fileDocName(p.id, randomUUID(), 1)
    const stale = fileDocName(p.id, main.id, 3)
    const fresh = fileDocName(p.id, randomUUID(), 1)
    const logOnly = fileDocName(randomUUID(), randomUUID(), 1)
    const old = Date.now() - 2 * DAY
    const insState = db.prepare(`INSERT INTO doc_state (doc_name, upto_seq, state, text, text_hash, updated_at) VALUES (?, 0, x'00', 't', 'h', ?)
      ON CONFLICT(doc_name) DO UPDATE SET updated_at = excluded.updated_at`)
    for (const n of [missing, stale, 'not-a-doc-name']) insState.run(n, old)
    insState.run(fresh, Date.now())
    db.prepare('UPDATE doc_state SET updated_at = ? WHERE doc_name = ?').run(old, current)
    db.prepare("INSERT INTO doc_updates (doc_name, seq, update_blob, user_id, ts) VALUES (?, 1, x'00', NULL, ?)").run(logOnly, old)
    const r = await gc(admin)
    expect(r.orphanDocsRemoved).toBe(3)
    const names = new Set([
      ...(db.prepare('SELECT doc_name AS n FROM doc_state').all() as { n: string }[]).map(x => x.n),
      ...(db.prepare('SELECT doc_name AS n FROM doc_updates').all() as { n: string }[]).map(x => x.n),
    ])
    for (const n of [missing, stale, logOnly]) expect(names.has(n)).toBe(false)
    for (const n of [current, fresh, 'not-a-doc-name']) expect(names.has(n)).toBe(true)
    // The project still opens with its text.
    expect(ts.lig.store.storedText(current)?.text).toBe(MAIN_TEMPLATE)
  })

  it('orphan docs: a loaded doc is never removed', () => {
    const db = openDb(':memory:')
    const name = fileDocName(randomUUID(), randomUUID(), 1)
    db.prepare(`INSERT INTO doc_state (doc_name, upto_seq, state, text, text_hash, updated_at) VALUES (?, 0, x'00', '', '', 0)`).run(name)
    expect(removeOrphanDocs(db, Date.now(), n => n === name)).toBe(0)
    expect(removeOrphanDocs(db, Date.now(), () => false)).toBe(1)
    db.close()
  })

  it('runs version thinning and the trash retention sweep', async () => {
    const { ts, admin, p } = await setup(39214)
    const db = ts.lig.db
    const now = Date.now()
    const HOUR = 60 * 60 * 1000
    // Four automatic versions in one hour three days ago (one survives), plus a newer latest one.
    const hourStart = Math.floor((now - 3 * DAY) / HOUR) * HOUR
    const ins = db.prepare(`INSERT INTO versions (id, project_id, kind, label, created_by, created_at, tree_version, manifest_hash)
      VALUES (?, ?, ?, NULL, NULL, ?, 0, 'm')`)
    for (let i = 0; i < 4; i++) ins.run(randomUUID(), p.id, 'auto', hourStart + i * 60_000)
    ins.run(randomUUID(), p.id, 'named', hourStart + 5 * 60_000)
    ins.run(randomUUID(), p.id, 'auto', now)
    // A trash batch past the retention.
    const t = await upload(admin, p, 't.png', makePng(3, 3))
    expect((await admin.del(`/api/projects/${p.id}/files/${t.id}`)).status).toBe(200)
    db.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').run(now - 31 * DAY, t.id)
    const r = await gc(admin)
    expect(r.versionsThinned).toBe(3)
    expect((await admin.get<TrashEntry[]>(`/api/projects/${p.id}/trash`)).body).toEqual([])
    expect(db.prepare("SELECT COUNT(*) AS n FROM versions WHERE project_id = ? AND kind = 'named'").get(p.id)).toEqual({ n: 1 })
  })
})

describe('GET /api/admin/storage', () => {
  it('reports totals, per-project numbers and unreferenced blobs', async () => {
    const { ts, admin, p } = await setup(39215)
    const X = makePng(13, 13, [1, 0, 0]), Y = makePng(14, 14, [0, 1, 0]), Z = makePng(15, 15, [0, 0, 1])
    await upload(admin, p, 'x.png', X)
    const y = await upload(admin, p, 'y.png', Y)
    expect((await admin.del(`/api/projects/${p.id}/files/${y.id}`)).status).toBe(200)
    await orphanBlob(admin, p, 'z.png', Z)
    const gone = await newProject(admin, 'Gone')
    expect((await admin.del(`/api/projects/${gone.id}`)).status).toBe(200)

    const r = await admin.get<StorageReport>('/api/admin/storage')
    expect(r.status).toBe(200)
    const db = ts.lig.db
    expect(r.body.databaseBytes).toBeGreaterThan(0)
    expect(r.body.blobs).toEqual(db.prepare('SELECT COUNT(*) AS count, SUM(size) AS bytes FROM blobs').get())
    expect(r.body.unreferenced).toEqual({ count: 1, bytes: Z.byteLength })
    const versions = (db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').get(p.id) as { n: number }).n
    expect(versions).toBeGreaterThan(0)
    const mine = r.body.projects.find(x => x.id === p.id)
    expect(mine).toEqual({
      id: p.id, name: 'Paper', owner: 'admin', deleted: false, liveFiles: 2,
      liveBytes: Buffer.byteLength(MAIN_TEMPLATE) + X.byteLength, trashBytes: Y.byteLength, versions,
    })
    expect(r.body.projects.find(x => x.id === gone.id)).toMatchObject({ deleted: true, name: 'Gone', liveFiles: 1 })
    // Sorted by size, largest first.
    const sizes = r.body.projects.map(x => x.liveBytes + x.trashBytes)
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes)
    expect(r.body.lastGc).toBeNull()
  })
})
