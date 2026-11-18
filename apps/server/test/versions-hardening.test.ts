import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { metaDocName, type ProjectDetail, type TreeEntry, type VersionPage, type VersionSummary } from '@ligature/shared'
import { auditEntries } from '../src/audit.ts'
import { deleteVersions } from '../src/history/store.ts'
import { zipItemsStream } from '../src/zip/exporter.ts'
import { connect, tempDataDir, waitFor } from './harness.ts'
import { addMember, type Client, me, newProject, openInstance, project, signup, type TestServer } from './inproc.ts'

/* Hardening of the history routes (M3 security review): access re-checked by queued restores, streamed
 * version files without long-lived caching, per-user budgets, cached change counts, all-or-nothing zips. */

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

const sha = (b: string | Uint8Array) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b, 'utf8') : b).digest('hex')

async function setup(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const { ts, admin } = await openInstance(port, { history: { tickMs: 3_600_000 }, ...opts }); servers.push(ts)
  const owner = await signup(ts.base, 'owner')
  const eve = await signup(ts.base, 'eve')
  const p = await newProject(owner)
  await addMember(owner, eve, p.id, 'editor')
  const meta = connect(ts.base, owner.cookie, metaDocName(p.id))
  sockets.push(meta)
  await waitFor(() => meta.provider.isSynced, 10_000, 'meta sync')
  return { ts, admin, owner, eve, p }
}

const V = (p: ProjectDetail) => `/api/projects/${p.id}/versions`
async function named(c: Client, p: ProjectDetail, label: string): Promise<VersionSummary> {
  const r = await c.post<VersionSummary>(V(p), { label })
  if (r.status !== 200) throw new Error(`named: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}
async function mkText(c: Client, p: ProjectDetail, name: string, content: string): Promise<TreeEntry> {
  const r = await c.post<TreeEntry>(`/api/projects/${p.id}/files`, { parentId: p.rootId, name, kind: 'text', content })
  if (r.status !== 200) throw new Error(`create ${name}: ${r.status}`)
  return r.body
}

/**
 * Holds the project's restore lock until `release()`; `queued` resolves once a restore has queued behind it
 * (so the test acts deterministically while the restore waits).
 */
function holdLock(ts: TestServer, projectId: string) {
  const h = ts.lig.history as { withProjectLock: typeof ts.lig.history.withProjectLock }
  const orig = h.withProjectLock.bind(ts.lig.history)
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const held = orig(projectId, () => gate)
  let signal!: () => void
  const queued = new Promise<void>(r => { signal = r })
  h.withProjectLock = ((id: string, fn: () => Promise<unknown>) => {
    const out = orig(id, fn)
    signal()
    return out
  }) as typeof h.withProjectLock
  return { queued, release: async () => { release(); await held; h.withProjectLock = orig } }
}

const preRestoreCount = (ts: TestServer, projectId: string) =>
  (ts.lig.db.prepare(`SELECT COUNT(*) AS n FROM versions WHERE project_id = ? AND kind = 'pre_restore'`).get(projectId) as { n: number }).n

describe('queued restores re-check access', () => {
  it('a restore queued behind another fails once the caller was removed, demoted, or the project deleted', async () => {
    const { ts, owner, eve, p } = await setup(39132)
    const v1 = await named(eve, p, 'V1')
    const after = await mkText(owner, p, 'after.tex', 'added later')
    const eveId = (await me(eve)).id

    // Removed while waiting: 404, nothing changed, no undo point credited to her.
    let lock = holdLock(ts, p.id)
    let pending = eve.post(`${V(p)}/${v1.id}/restore`, {})
    await lock.queued
    expect((await owner.del(`/api/projects/${p.id}/members/${eveId}`)).status).toBe(200)
    await lock.release()
    expect((await pending).status).toBe(404)
    expect((await project(owner, p.id)).tree.some(e => e.id === after.id)).toBe(true)
    expect(preRestoreCount(ts, p.id)).toBe(0)
    expect(auditEntries(ts.lig.db, 'version.restore')).toHaveLength(0)

    // Demoted to viewer while waiting: 403.
    await addMember(owner, eve, p.id, 'editor')
    lock = holdLock(ts, p.id)
    pending = eve.post(`${V(p)}/${v1.id}/restore`, {})
    await lock.queued
    expect((await owner.patch(`/api/projects/${p.id}/members/${eveId}`, { role: 'viewer' })).status).toBe(200)
    await lock.release()
    expect((await pending).status).toBe(403)
    expect(preRestoreCount(ts, p.id)).toBe(0)

    // Project deleted while waiting: 404, no version taken on the deleted project.
    lock = holdLock(ts, p.id)
    pending = owner.post(`${V(p)}/${v1.id}/restore`, {})
    await lock.queued
    expect((await owner.del(`/api/projects/${p.id}`)).status).toBe(200)
    await lock.release()
    expect((await pending).status).toBe(404)
    expect(preRestoreCount(ts, p.id)).toBe(0)
    expect(auditEntries(ts.lig.db, 'version.restore')).toHaveLength(0)
  })
})

describe('version file contents', () => {
  it('streamed from disk (never read whole), no long-lived caching, ETag revalidation, 404 when the blob is gone', async () => {
    const { ts, owner, eve, p } = await setup(39133)
    const big = randomBytes(3 * 1024 * 1024 + 17)
    expect((await owner.upload(p.id, p.rootId, 'big.bin', big)).status).toBe(200)
    const v = await named(owner, p, 'with big')
    const read = vi.spyOn(ts.lig.blobs, 'read')

    const r = await eve.req('GET', `${V(p)}/${v.id}/file?path=big.bin`)
    expect(r.status).toBe(200)
    expect(Buffer.from(await r.raw.arrayBuffer()).equals(big)).toBe(true)
    expect(r.headers.get('content-length')).toBe(String(big.byteLength))
    expect(r.headers.get('cache-control')).toBe('private, no-cache')
    expect(r.headers.get('etag')).toBe(`"${sha(big)}"`)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    const t = await eve.get(`${V(p)}/${v.id}/file?path=main.tex`)
    expect(t.status).toBe(200)
    expect(t.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(t.headers.get('cache-control')).toBe('private, no-cache')
    expect(read).not.toHaveBeenCalled()

    // Revalidation: 304 without a body; a removed member gets 404 even with the ETag.
    const etag = r.headers.get('etag')!
    const nm = await eve.req('GET', `${V(p)}/${v.id}/file?path=big.bin`, undefined, { headers: { 'if-none-match': `W/${etag}, "x"` } })
    expect(nm.status).toBe(304)
    expect((await nm.raw.arrayBuffer()).byteLength).toBe(0)
    const other = await eve.req('GET', `${V(p)}/${v.id}/file?path=big.bin`, undefined, { headers: { 'if-none-match': '"nope"' } })
    expect(other.status).toBe(200)
    await other.raw.arrayBuffer()

    rmSync(ts.lig.blobs.pathOf(sha(big)))
    expect((await eve.get(`${V(p)}/${v.id}/file?path=big.bin`)).status).toBe(404)
    const eveId = (await me(eve)).id
    expect((await owner.del(`/api/projects/${p.id}/members/${eveId}`)).status).toBe(200)
    expect((await eve.req('GET', `${V(p)}/${v.id}/file?path=main.tex`, undefined, { headers: { 'if-none-match': etag } })).status).toBe(404)
  })
})

describe('per-user budgets', () => {
  it('named versions and restores share one budget; diffs against the live state have their own', async () => {
    const { ts, owner, eve, p } = await setup(39134, { rateLimits: { versionWritesPerUser: 3, liveDiffsPerUser: 2 } })
    const viewer = await signup(ts.base, 'vic')
    await addMember(owner, viewer, p.id, 'viewer')
    const v1 = await named(eve, p, 'one')
    const v2 = await named(eve, p, 'two')
    expect((await eve.post(`${V(p)}/${v1.id}/restore`, {})).status).toBe(200)
    const over = await eve.post(V(p), { label: 'three' })
    expect(over.status).toBe(429)
    expect(over.body.error).toBe('rate-limited')
    expect((await eve.post(`${V(p)}/${v2.id}/restore`, {})).status).toBe(429)
    // Per user; viewers still get 403, not 429.
    expect((await owner.post(V(p), { label: 'owner' })).status).toBe(200)
    expect((await viewer.post(V(p), { label: 'x' })).status).toBe(403)

    expect((await viewer.get(`${V(p)}/${v1.id}/diff?against=current`)).status).toBe(200)
    expect((await viewer.get(`${V(p)}/current/diff?against=${v1.id}`)).status).toBe(200)
    expect((await viewer.get(`${V(p)}/current/diff`)).status).toBe(429)
    // Between stored versions: no snapshot, no budget.
    for (let i = 0; i < 4; i++) expect((await viewer.get(`${V(p)}/${v2.id}/diff?against=${v1.id}`)).status).toBe(200)
    expect((await eve.get(`${V(p)}/${v1.id}/diff?against=current`)).status).toBe(200)
  })
})

describe('change counts', () => {
  it('stay right when the previous version changes (thinning) and on repeated listings', async () => {
    const { ts, owner, p } = await setup(39135)
    const v1 = await named(owner, p, 'one')
    await mkText(owner, p, 'a.tex', 'a')
    const v2 = await named(owner, p, 'two')
    await mkText(owner, p, 'b.tex', 'b')
    const v3 = await named(owner, p, 'three')
    const list = async () => (await owner.get<VersionPage>(V(p))).body.versions
    const first = await list()
    expect(first.find(v => v.id === v3.id)).toMatchObject({ fileCount: 3, changes: { added: 1, removed: 0, modified: 0 } })
    expect(await list()).toEqual(first)
    // Page boundaries: v3 alone, its counts still against v2.
    expect((await owner.get<VersionPage>(`${V(p)}?limit=1`)).body.versions[0]).toMatchObject({ id: v3.id, changes: { added: 1 } })

    ts.lig.db.transaction(() => deleteVersions(ts.lig.db, p.id, [v2.id]))()
    const after = await list()
    expect(after.map(v => v.id)).toEqual([v3.id, v1.id])
    expect(after[0]).toMatchObject({ fileCount: 3, changes: { added: 2, removed: 0, modified: 0 } })
    expect((await owner.get(`${V(p)}/${v3.id}`)).body.version).toMatchObject({ changes: { added: 2 } })
  })
})

describe('version zip', () => {
  it('refuses up front when a blob is missing (409 content-missing)', async () => {
    const { ts, owner, p } = await setup(39136)
    await owner.upload(p.id, p.rootId, 'fig.bin', randomBytes(64))
    const v = await named(owner, p, 'v')
    const bin = (await owner.get(`${V(p)}/${v.id}`)).body.files.find((f: { path: string }) => f.path === 'fig.bin')
    rmSync(ts.lig.blobs.pathOf(bin.hash))
    const r = await owner.get(`${V(p)}/${v.id}/export.zip`)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('content-missing')
    // The gate slot was given back: the next export is served.
    await owner.upload(p.id, p.rootId, 'fig.bin', randomBytes(64))
    const w = await named(owner, p, 'w')
    expect((await owner.get(`${V(p)}/${w.id}/export.zip`)).status).toBe(200)
  })

  it('a blob vanishing mid-stream fails the stream (versions) instead of skipping the file (live export)', async () => {
    const dir = join(tempDataDir(), 'blobs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'present'), 'here')
    const s = { blobs: { pathOf: (h: string) => join(dir, h) } } as unknown as Parameters<typeof zipItemsStream>[0]
    const items = [{ path: 'a.bin', blobHash: 'present' }, { path: 'b.bin', blobHash: 'gone' }]
    const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const _ of stream as unknown as AsyncIterable<Uint8Array>) { /* read */ } }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let done = 0
    await expect(drain(zipItemsStream(s, items, { missingBlob: 'fail', onDone: () => done++ }))).rejects.toThrow(/gone missing for b\.bin/)
    expect(done).toBe(1)
    await drain(zipItemsStream(s, items, { onDone: () => done++ }))
    expect(done).toBe(2)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('missing for b.bin'))
  })
})

describe('admin storage report', () => {
  it('reading it is audited (storage.view)', async () => {
    const { ts, admin } = await openInstance(39137); servers.push(ts)
    expect((await admin.get('/api/admin/storage')).status).toBe(200)
    const adminId = (await me(admin)).id
    expect(auditEntries(ts.lig.db, 'storage.view')).toEqual([expect.objectContaining({ actorId: adminId, projectId: null })])
  })
})
