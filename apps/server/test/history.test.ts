import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fileDocName, metaDocName, type BuildResult, type ProjectDetail, type TreeEntry, type VersionDetail, type VersionPage } from '@ligature/shared'
import { MAIN_TEMPLATE } from '../src/projects/service.ts'
import { insertVersion, versionBlobHashes } from '../src/history/store.ts'
import { connect, HAS_LATEXMK, startCompiler, waitFor } from './harness.ts'
import { addMember, newProject, openInstance, signup, type Client, type TestServer } from './inproc.ts'

/* Versions: snapshots, dedupe, authors, scheduler triggers (fake clock), events, thinning (docs/M3.md §1). */

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

const MIN = 60_000
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

function open(base: string, c: Client, docName: string) {
  const x = connect(base, c.cookie, docName)
  sockets.push(x)
  return x
}

/**
 * A server whose history clock the test moves by hand (the periodic tick is off; tests call tick()).
 * With `keepOpen`, the owner holds the project's meta doc open, so "the last client left" never fires
 * (server-side edits load and unload docs too).
 */
async function setup(port: number, keepOpen = true) {
  const clock = { now: Date.now() }
  const { ts } = await openInstance(port, { clock: () => clock.now, history: { tickMs: 3_600_000 } })
  servers.push(ts)
  const owner = await signup(ts.base, 'owner', { displayName: 'Olivia Owner' })
  const ed = await signup(ts.base, 'editor', { displayName: 'Eddie Editor' })
  const p = await newProject(owner)
  await addMember(owner, ed, p.id, 'editor')
  const meta = keepOpen ? open(ts.base, owner, metaDocName(p.id)) : null
  if (meta) await waitFor(() => meta.provider.isSynced, 10_000, 'meta sync')
  return { ts, owner, ed, p, clock, h: ts.lig.history, meta }
}

const versions = async (c: Client, p: ProjectDetail) => (await c.get<VersionPage>(`/api/projects/${p.id}/versions`)).body.versions
const detail = async (c: Client, p: ProjectDetail, id: string) => (await c.get<VersionDetail>(`/api/projects/${p.id}/versions/${id}`)).body
const fileText = async (c: Client, p: ProjectDetail, id: string, path: string) =>
  (await c.get(`/api/projects/${p.id}/versions/${id}/file?path=${encodeURIComponent(path)}`)).body as string
const mk = async (c: Client, p: ProjectDetail, name: string, content: string, parentId = p.rootId) => {
  const r = await c.post<TreeEntry>(`/api/projects/${p.id}/files`, { parentId, name, kind: 'text', content })
  if (r.status !== 200) throw new Error(`create ${name}: ${r.status}`)
  return r.body
}

describe('snapshots', () => {
  it('first change -> version of the state before it; auto after 5 min (fake clock); dedupe; texts stored as blobs', async () => {
    const { ts, owner, p, clock, h } = await setup(39107)
    const db = ts.lig.db
    expect(await versions(owner, p)).toEqual([]) // created, never changed: no version yet
    expect(h.tick()).toBe(0)

    await mk(owner, p, 'a.tex', 'Alpha')
    let list = await versions(owner, p)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'auto', label: null, createdBy: '', authors: [], fileCount: 1, changes: { added: 0, removed: 0, modified: 0 } })
    const base = await detail(owner, p, list[0]!.id)
    expect(base.files).toEqual([{ path: 'main.tex', fileId: p.tree.find(f => f.name === 'main.tex')!.id, kind: 'text', size: Buffer.byteLength(MAIN_TEMPLATE), hash: sha(MAIN_TEMPLATE) }])
    expect(await fileText(owner, p, list[0]!.id, 'main.tex')).toBe(MAIN_TEMPLATE)
    expect(ts.lig.blobs.has(sha(MAIN_TEMPLATE))).toBe(true) // text stored as a blob

    // dirty since the change: nothing before 5 minutes, an auto version at 5 minutes
    expect(db.prepare('SELECT dirty_since AS d FROM projects WHERE id = ?').get(p.id)).toEqual({ d: clock.now })
    clock.now += 4 * MIN
    expect(h.tick()).toBe(0)
    clock.now += 1 * MIN
    expect(h.tick()).toBe(1)
    list = await versions(owner, p)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ kind: 'auto', authors: ['Olivia Owner'], fileCount: 2, changes: { added: 1, removed: 0, modified: 0 }, createdAt: clock.now })
    expect(db.prepare('SELECT dirty_since AS d FROM projects WHERE id = ?').get(p.id)).toEqual({ d: null })
    expect(h.tick()).toBe(0) // clean

    // identical state: automatic versions are skipped, named ones are not
    expect(h.takeVersion(p.id, 'auto')).toBeNull()
    expect(h.takeVersion(p.id, 'compile')).toBeNull()
    expect(await versions(owner, p)).toHaveLength(2)
    const named = await owner.post(`/api/projects/${p.id}/versions`, { label: '  Draft 1 ' })
    expect(named.status, JSON.stringify(named.body)).toBe(200)
    expect(named.body).toMatchObject({ kind: 'named', label: 'Draft 1', createdBy: 'Olivia Owner', changes: { added: 0, removed: 0, modified: 0 } })
    expect(await versions(owner, p)).toHaveLength(3)

    // unchanged files cost nothing: one more text blob for one changed file
    const blobsBefore = (db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n
    await owner.upload(p.id, p.rootId, 'a.tex', 'Alpha 2')
    clock.now += 5 * MIN
    expect(h.tick()).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n).toBe(blobsBefore + 1)
    list = await versions(owner, p)
    expect(list[0]).toMatchObject({ changes: { added: 0, removed: 0, modified: 1 }, authors: ['Olivia Owner'] })
    expect(versionBlobHashes(db)).toEqual(new Set([sha(MAIN_TEMPLATE), sha('Alpha'), sha('Alpha 2')]))
  })

  it('a doc edit as the first change: the version holds the text before the edit; manifest/tree version recorded', async () => {
    const { ts, ed, owner, p, clock, h } = await setup(39108)
    const main = p.tree.find(f => f.name === 'main.tex')!
    const doc = open(ts.base, ed, fileDocName(p.id, main.id, 1))
    await waitFor(() => doc.provider.isSynced, 10_000, 'sync')
    expect(await versions(owner, p)).toEqual([]) // syncing is not a change
    doc.text().insert(0, '% edited\n')
    await waitFor(() => !doc.provider.hasUnsyncedChanges, 5_000, 'acked')
    await waitFor(() => ts.lig.history.hasVersion(p.id), 5_000, 'baseline version')
    const [first] = await versions(owner, p)
    expect(first).toMatchObject({ kind: 'auto', authors: [] })
    expect(await fileText(owner, p, first!.id, 'main.tex')).toBe(MAIN_TEMPLATE)
    doc.text().insert(0, '% more\n')
    await waitFor(() => !doc.provider.hasUnsyncedChanges, 5_000, 'acked')
    clock.now += 5 * MIN
    expect(h.tick()).toBe(1)
    const [second] = await versions(owner, p)
    expect(second).toMatchObject({ kind: 'auto', authors: ['Eddie Editor'], changes: { added: 0, removed: 0, modified: 1 } })
    expect(await fileText(owner, p, second!.id, 'main.tex')).toBe(`% more\n% edited\n${MAIN_TEMPLATE}`)
    const row = ts.lig.db.prepare('SELECT tree_version AS tv, manifest_hash AS mh FROM versions WHERE id = ?').get(second!.id) as { tv: number; mh: string }
    expect(row.tv).toBe(0)
    expect(row.mh).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('authors', () => {
  it('doc edits and tree operations credit their users; reverted edits keep their authors pending', async () => {
    const { ts, owner, ed, p, clock, h } = await setup(39109)
    const viewer = await signup(ts.base, 'viewer', { displayName: 'Vera Viewer' })
    await addMember(owner, viewer, p.id, 'viewer')
    const a = await mk(owner, p, 'a.tex', 'A') // owner: baseline, then author
    clock.now += 5 * MIN
    h.tick()
    expect((await versions(owner, p))[0]!.authors).toEqual(['Olivia Owner'])

    // editor edits through the collab socket, the viewer only reads
    const docE = open(ts.base, ed, fileDocName(p.id, a.id, 1))
    const docV = open(ts.base, viewer, fileDocName(p.id, a.id, 1))
    await waitFor(() => docE.provider.isSynced && docV.provider.isSynced, 10_000, 'sync')
    docE.text().insert(1, 'B')
    await waitFor(() => !docE.provider.hasUnsyncedChanges, 5_000, 'acked')
    await waitFor(() => docV.text().toString() === 'AB', 5_000, 'viewer sees it')
    // owner renames, viewer cannot
    expect((await owner.patch(`/api/projects/${p.id}/files/${a.id}`, { name: 'b.tex' })).status).toBe(200)
    expect((await viewer.patch(`/api/projects/${p.id}/files/${a.id}`, { name: 'c.tex' })).status).toBe(403)
    clock.now += 5 * MIN
    expect(h.tick()).toBe(1)
    const [v2] = await versions(owner, p)
    expect(v2!.authors).toEqual(['Eddie Editor', 'Olivia Owner'])
    expect(ts.lig.db.prepare('SELECT COUNT(*) AS n FROM pending_authors WHERE project_id = ?').get(p.id)).toEqual({ n: 0 })

    // the editor types and deletes it again: identical content -> no version, but the editor stays pending
    docE.text().insert(0, 'x')
    await waitFor(() => !docE.provider.hasUnsyncedChanges, 5_000, 'acked')
    docE.text().delete(0, 1)
    await waitFor(() => !docE.provider.hasUnsyncedChanges, 5_000, 'acked')
    clock.now += 5 * MIN
    expect(h.tick()).toBe(0)
    expect(await versions(owner, p)).toHaveLength(3)
    // then the owner deletes a file (tree operation): the next version credits both
    expect((await owner.del(`/api/projects/${p.id}/files/${a.id}`)).status).toBe(200)
    clock.now += 5 * MIN
    expect(h.tick()).toBe(1)
    const [v3] = await versions(owner, p)
    expect(v3).toMatchObject({ authors: ['Eddie Editor', 'Olivia Owner'], changes: { added: 0, removed: 1, modified: 0 } })
  })
})

describe('triggers', () => {
  it('the last client leaving a dirty project takes an auto version; leaving a clean one does not', async () => {
    const { ts, ed, owner, p } = await setup(39110, false)
    const count = () => (ts.lig.db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').get(p.id) as { n: number }).n
    const main = p.tree.find(f => f.name === 'main.tex')!
    const meta = open(ts.base, ed, metaDocName(p.id))
    const doc = open(ts.base, ed, fileDocName(p.id, main.id, 1))
    await waitFor(() => doc.provider.isSynced && meta.provider.isSynced, 10_000, 'sync')
    doc.text().insert(0, 'x')
    await waitFor(() => !doc.provider.hasUnsyncedChanges, 5_000, 'acked')
    expect(await versions(owner, p)).toHaveLength(1) // the baseline
    // closing the file is not enough while the meta doc (the project) is still open
    doc.destroy()
    await waitFor(() => !ts.lig.collab.liveDoc(fileDocName(p.id, main.id, 1)), 10_000, 'file doc unloaded')
    expect(await versions(owner, p)).toHaveLength(1)
    meta.destroy()
    await waitFor(() => count() === 2, 10_000, 'idle version')
    const list = await versions(owner, p)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ kind: 'auto', authors: ['Eddie Editor'] })
    expect(await fileText(owner, p, list[0]!.id, 'main.tex')).toBe(`x${MAIN_TEMPLATE}`)

    // clean project: leaving does not create anything
    const again = open(ts.base, ed, fileDocName(p.id, main.id, 1))
    await waitFor(() => again.provider.isSynced, 10_000, 'sync')
    again.destroy()
    await waitFor(() => ts.lig.collab.hocuspocus.documents.size === 0, 10_000, 'unloaded')
    await new Promise(r => setTimeout(r, 100))
    expect(count()).toBe(2)
  })

  it('compile versions: after a successful build, at most every 10 min, only if something changed', async () => {
    const { ts, owner, p, clock, h } = await setup(39111)
    const c = ts.lig.compiler
    let status: BuildResult['status'] = 'success'
    c.sync = async () => ({ missing: [] })
    c.putBlob = async () => {}
    c.compile = async () => ({ status, durationMs: 1, outputs: [], log: 'stub\n' })
    c.output = async () => null
    const compile = async () => (await owner.post<BuildResult>(`/api/projects/${p.id}/compile`)).body.status

    // a project without versions: the first successful build takes one
    expect(await compile()).toBe('success')
    let list = await versions(owner, p)
    expect(list.map(v => v.kind)).toEqual(['compile'])
    // a change, but the latest version is younger than 10 min: none
    await mk(owner, p, 'a.tex', 'A')
    clock.now += 9 * MIN
    expect(await compile()).toBe('success')
    expect((await versions(owner, p)).map(v => v.kind)).toEqual(['compile'])
    // a failed build never takes one
    clock.now += 2 * MIN
    status = 'failure'
    expect(await compile()).toBe('failure')
    expect((await versions(owner, p)).map(v => v.kind)).toEqual(['compile'])
    status = 'success'
    expect(await compile()).toBe('success')
    list = await versions(owner, p)
    expect(list.map(v => v.kind)).toEqual(['compile', 'compile'])
    expect(list[0]!.changes).toEqual({ added: 1, removed: 0, modified: 0 })
    // nothing changed since: none, even 10 min later
    clock.now += 11 * MIN
    expect(await compile()).toBe('success')
    expect(await versions(owner, p)).toHaveLength(2)
    expect(h.onCompileSuccess(p.id)).toBeNull()
  })

  it('versions-changed is broadcast when a version is created or labelled', async () => {
    const { owner, p, clock, h, meta: m } = await setup(39112)
    const meta = m!
    const count = () => meta.events().filter(e => e.type === 'versions-changed').length
    await mk(owner, p, 'a.tex', 'A')
    await waitFor(() => count() === 1, 5_000, 'baseline event')
    clock.now += 5 * MIN
    h.tick()
    await waitFor(() => count() === 2, 5_000, 'auto event')
    const v = (await owner.post(`/api/projects/${p.id}/versions`, { label: 'x' })).body
    await waitFor(() => count() === 3, 5_000, 'named event')
    expect((await owner.patch(`/api/projects/${p.id}/versions/${v.id}`, { label: 'y' })).status).toBe(200)
    await waitFor(() => count() === 4, 5_000, 'label event')
  })
})

describe('thinning applied to the database', () => {
  it('removes old automatic versions, carries their authors to the next kept version, keeps the rest', async () => {
    const { ts, owner, ed, p, clock, h, meta: m } = await setup(39113)
    const db = ts.lig.db
    const ids = { owner: (await owner.get('/api/me')).body.id as string, ed: (await ed.get('/api/me')).body.id as string }
    const HOUR = 60 * MIN
    const DAY = 24 * HOUR
    const t0 = Math.floor((clock.now - 30 * DAY) / DAY) * DAY + HOUR // 30 days ago, 01:00 UTC: "newest per day"
    const mkV = (id: string, kind: 'auto' | 'compile' | 'named', at: number, authors: string[], label: string | null = null) =>
      insertVersion(db, { id, projectId: p.id, kind, label, createdBy: null, createdAt: at, treeVersion: 0, manifestHash: id.padEnd(64, '0') }, [], authors)
    const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    mkV(U(1), 'auto', t0, [ids.ed])
    mkV(U(2), 'auto', t0 + HOUR, [ids.owner]) // same day as 1, newer: keeps the day
    mkV(U(3), 'named', t0 + 2 * HOUR, [], 'Submitted')
    mkV(U(4), 'compile', t0 + 3 * HOUR, [ids.ed]) // the newest auto/compile of that day: 1 and 2 go, their authors move to 3
    mkV(U(5), 'auto', clock.now - HOUR, []) // recent
    const meta = m!
    expect(h.thin(p.id)).toBe(2)
    await waitFor(() => meta.events().some(e => e.type === 'versions-changed'), 5_000, 'event')
    const left = (await versions(owner, p)).map(v => [v.id, v.authors])
    expect(left).toEqual([
      [U(5), []],
      [U(4), ['Eddie Editor']],
      [U(3), ['Eddie Editor', 'Olivia Owner']], // carried over from 1 and 2
    ])
    expect(h.thin(p.id)).toBe(0)
    expect(h.thinAll()).toBe(0)
  })
})

describe('paging', () => {
  it('lists newest first with before/limit and hasMore; validates params', async () => {
    const { owner, ed, p, h } = await setup(39114)
    for (let i = 0; i < 5; i++) h.takeVersion(p.id, 'named', { label: `v${i}` })
    const page1 = (await ed.get<VersionPage>(`/api/projects/${p.id}/versions?limit=2`)).body
    expect(page1.versions.map(v => v.label)).toEqual(['v4', 'v3'])
    expect(page1.hasMore).toBe(true)
    const page2 = (await ed.get<VersionPage>(`/api/projects/${p.id}/versions?limit=2&before=${page1.versions[1]!.id}`)).body
    expect(page2.versions.map(v => v.label)).toEqual(['v2', 'v1'])
    const page3 = (await ed.get<VersionPage>(`/api/projects/${p.id}/versions?limit=2&before=${page2.versions[1]!.id}`)).body
    expect(page3).toMatchObject({ hasMore: false })
    expect(page3.versions.map(v => v.label)).toEqual(['v0'])
    expect((await ed.get<VersionPage>(`/api/projects/${p.id}/versions`)).body.versions).toHaveLength(5)
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'before=nope', `before=${p.id}`]) {
      expect((await owner.get(`/api/projects/${p.id}/versions?${q}`)).status, q).toBe(400)
    }
  })
})

describe.skipIf(!HAS_LATEXMK)('compile version with real TeX', () => {
  let compiler: ChildProcess
  let ts: TestServer
  beforeAll(async () => {
    compiler = await startCompiler(39115)
    ;({ ts } = await openInstance(39116, { compilerUrl: 'http://127.0.0.1:39115' }))
  }, 30_000)
  afterAll(async () => {
    await ts?.stop()
    if (compiler && compiler.exitCode === null && compiler.signalCode === null) compiler.kill('SIGKILL')
  })

  it('a successful build of a project takes a compile version of what was built', async () => {
    const alice = await signup(ts.base, 'alice')
    const p = await newProject(alice, 'Real')
    const r = await alice.post<BuildResult>(`/api/projects/${p.id}/compile`)
    expect(r.body.status, r.body.log?.slice(-2000)).toBe('success')
    const list = (await alice.get<VersionPage>(`/api/projects/${p.id}/versions`)).body.versions
    expect(list.map(v => v.kind)).toEqual(['compile'])
    expect((await alice.get(`/api/projects/${p.id}/versions/${list[0]!.id}/file?path=main.tex`)).body).toBe(MAIN_TEMPLATE)
  }, 120_000)
})
