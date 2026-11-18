import { afterEach, describe, expect, it } from 'vitest'
import { fileDocName, metaDocName, type ProjectDetail, type TrashEntry, type TreeEntry } from '@ligature/shared'
import { auditEntries } from '../src/audit.ts'
import { restoredName } from '../src/files/trash.ts'
import { connect, waitFor } from './harness.ts'
import { addMember, Client, newProject, openInstance, project, signup, startTestServer, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

const DAY = 24 * 60 * 60 * 1000

async function setup(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const { ts } = await openInstance(port, opts); servers.push(ts)
  const owner = await signup(ts.base, 'owner', { displayName: 'Olivia Owner' })
  const ed = await signup(ts.base, 'editor', { displayName: 'Eddie Editor' })
  const viewer = await signup(ts.base, 'viewer')
  const p = await newProject(owner)
  await addMember(owner, ed, p.id, 'editor')
  await addMember(owner, viewer, p.id, 'viewer')
  return { ts, owner, ed, viewer, p }
}

function open(base: string, c: Client, docName: string) {
  const x = connect(base, c.cookie, docName)
  sockets.push(x)
  return x
}

const mk = async (c: Client, p: ProjectDetail, parentId: string, name: string, kind: 'folder' | 'text', content?: string) => {
  const r = await c.post<TreeEntry>(`/api/projects/${p.id}/files`, { parentId, name, kind, ...(content !== undefined ? { content } : {}) })
  if (r.status !== 200) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}
const del = (c: Client, p: ProjectDetail, id: string) => c.del(`/api/projects/${p.id}/files/${id}`)
const trash = async (c: Client, p: ProjectDetail) => (await c.get<TrashEntry[]>(`/api/projects/${p.id}/trash`)).body
const restore = (c: Client, p: ProjectDetail, id: string, body?: { parentId?: string }) =>
  body === undefined ? c.req<TreeEntry>('POST', `/api/projects/${p.id}/trash/${id}/restore`) : c.post<TreeEntry>(`/api/projects/${p.id}/trash/${id}/restore`, body)

describe('trash can', () => {
  it('delete a folder -> one trash entry -> restore with clash rename -> content intact in a connected client', async () => {
    const { ts, owner, ed, p } = await setup(39270)
    const meta = open(ts.base, owner, metaDocName(p.id))
    await waitFor(() => meta.provider.isSynced, 10_000, 'meta sync')
    const ch = await mk(owner, p, p.rootId, 'chapters', 'folder')
    const sub = await mk(owner, p, ch.id, 'sub', 'folder')
    const intro = await mk(owner, p, ch.id, 'intro.tex', 'text', 'Intro')
    await mk(owner, p, sub.id, 'deep.tex', 'text', 'Deep')
    expect((await owner.upload(p.id, sub.id, 'fig.png', makePng(4, 4))).status).toBe(200)
    // a live edit, not yet compacted, before the deletion
    const doc = open(ts.base, ed, fileDocName(p.id, intro.id, 1))
    await waitFor(() => doc.provider.isSynced, 10_000, 'sync')
    doc.text().insert(5, ' — edited live')
    await waitFor(() => !doc.provider.hasUnsyncedChanges, 5_000, 'acked')

    const t0 = Date.now()
    expect((await del(ed, p, ch.id)).status).toBe(200)
    await waitFor(() => meta.events().some(e => e.type === 'trash-changed'), 5_000, 'trash-changed on delete')
    expect(meta.events().map(e => e.type)).toEqual(['tree-changed', 'tree-changed', 'tree-changed', 'tree-changed', 'tree-changed', 'tree-changed', 'trash-changed'])

    const entries = await trash(owner, p)
    expect(entries).toHaveLength(1)
    const e = entries[0]!
    const png = makePng(4, 4).byteLength
    expect(e).toEqual({
      id: ch.id, name: 'chapters', kind: 'folder', originalPath: 'chapters', deletedAt: expect.any(Number),
      deletedBy: 'Eddie Editor', fileCount: 3, size: Buffer.byteLength('Intro — edited live') + 4 + png,
      expiresAt: e.deletedAt + 30 * DAY,
    })
    expect(e.deletedAt).toBeGreaterThanOrEqual(t0)

    // the name is taken meanwhile
    const clash = await mk(owner, p, p.rootId, 'chapters', 'folder')
    const before = meta.events().length
    const r = await restore(ed, p, ch.id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({ id: ch.id, parentId: p.rootId, name: 'chapters (restored)', kind: 'folder' })
    await waitFor(() => meta.events().length >= before + 2, 5_000, 'events after restore')
    expect(meta.events().slice(before).map(x => x.type)).toEqual(['tree-changed', 'trash-changed'])
    expect(await trash(owner, p)).toEqual([])

    const tree = (await project(owner, p.id)).tree
    const names = (parentId: string) => tree.filter(f => f.parentId === parentId).map(f => f.name).sort()
    expect(names(p.rootId)).toEqual(['chapters', 'chapters (restored)', 'main.tex'])
    expect(names(ch.id)).toEqual(['intro.tex', 'sub'])
    expect(names(sub.id)).toEqual(['deep.tex', 'fig.png'])
    expect(tree.find(f => f.id === intro.id)).toMatchObject({ epoch: 1 }) // same epoch: no bump
    void clash

    // a fresh client gets the content (Yjs state kept, compacted on delete)
    const again = open(ts.base, owner, fileDocName(p.id, intro.id, 1))
    await waitFor(() => again.provider.isSynced, 10_000, 'sync restored doc')
    expect(again.text().toString()).toBe('Intro — edited live')
    expect((await owner.get(`/api/projects/${p.id}/files/${intro.id}/raw`)).body).toBe('Intro — edited live')
    // and it can be edited again
    again.text().insert(0, '>')
    await waitFor(() => !again.provider.hasUnsyncedChanges, 5_000, 'acked')
    expect(auditEntries(ts.lig.db, 'file.restore')).toEqual([expect.objectContaining({
      projectId: p.id, detail: expect.objectContaining({ fileId: ch.id, name: 'chapters (restored)', count: 5 }),
    })])
  })

  it('files: suffix before the extension, repeated clashes, main file comes back, target parent rules', async () => {
    const { ts, owner, ed, p } = await setup(39271)
    const meta = open(ts.base, owner, metaDocName(p.id))
    await waitFor(() => meta.provider.isSynced, 10_000, 'meta')
    const main = p.tree.find(f => f.name === 'main.tex')!
    expect((await del(ed, p, main.id)).status).toBe(200)
    expect((await project(owner, p.id)).mainFileId).toBeNull()
    await mk(owner, p, p.rootId, 'main.tex', 'text', 'new main')
    await mk(owner, p, p.rootId, 'main (restored).tex', 'text', 'taken too')
    const r = await restore(ed, p, main.id)
    expect(r.body).toMatchObject({ id: main.id, name: 'main (restored 2).tex', parentId: p.rootId, kind: 'text', epoch: 1 })
    expect((await project(owner, p.id)).mainFileId).toBe(main.id)
    await waitFor(() => meta.events().filter(e => e.type === 'project-changed').length === 2, 5_000, 'project-changed on delete + restore')

    // the main file is not reset when another one was chosen meanwhile
    expect((await del(ed, p, main.id)).status).toBe(200)
    const other = (await project(owner, p.id)).tree.find(f => f.name === 'main.tex')!
    expect((await owner.patch(`/api/projects/${p.id}`, { mainFileId: other.id })).status).toBe(200)
    expect((await restore(ed, p, main.id)).status).toBe(200)
    expect((await project(owner, p.id)).mainFileId).toBe(other.id)

    // original parent still live -> back there; deleted -> root; explicit parentId -> there
    const a = await mk(owner, p, p.rootId, 'a', 'folder')
    const b = await mk(owner, p, p.rootId, 'b', 'folder')
    const f1 = await mk(owner, p, a.id, 'one.tex', 'text', '1')
    const f2 = await mk(owner, p, b.id, 'two.tex', 'text', '2')
    const f3 = await mk(owner, p, a.id, 'three.tex', 'text', '3')
    await del(owner, p, f1.id)
    await del(owner, p, f2.id)
    await del(owner, p, b.id)
    await del(owner, p, f3.id)
    expect((await restore(owner, p, f1.id)).body).toMatchObject({ parentId: a.id, name: 'one.tex' })
    expect((await restore(owner, p, f2.id)).body).toMatchObject({ parentId: p.rootId, name: 'two.tex' })
    expect((await restore(owner, p, f3.id, { parentId: p.rootId })).body).toMatchObject({ parentId: p.rootId, name: 'three.tex' })

    // bad targets and bad ids
    await del(owner, p, f1.id)
    const live = await mk(owner, p, p.rootId, 'live.tex', 'text')
    const other2 = await newProject(owner, 'Other')
    for (const parentId of [live.id, b.id, other2.rootId, 'nope']) {
      expect((await restore(owner, p, f1.id, { parentId })).status, parentId).toBe(400)
    }
    expect((await owner.post(`/api/projects/${p.id}/trash/${f1.id}/restore`, { parentId: a.id, extra: 1 })).status).toBe(400)
    expect((await restore(owner, p, live.id)).status).toBe(404) // not in the trash
    expect((await restore(owner, p, 'not-a-uuid')).status).toBe(404)
    expect((await restore(owner, p, '6f9619ff-8b86-4011-b42d-00cf4fc964ff')).status).toBe(404)
    expect((await restore(owner, other2, f1.id)).status).toBe(404) // wrong project
    void ts
  })

  it('only the top item of a batch can be restored or purged; nested batches; purged parent shows as …/', async () => {
    const { ts, owner, p } = await setup(39272)
    const a = await mk(owner, p, p.rootId, 'A', 'folder')
    const inner = await mk(owner, p, a.id, 'inner', 'folder')
    const f = await mk(owner, p, inner.id, 'f.tex', 'text', 'eff')
    const g = await mk(owner, p, inner.id, 'g.tex', 'text', 'gee')
    await del(owner, p, f.id) // batch 1: A/inner/f.tex
    await del(owner, p, a.id) // batch 2: A, inner, g.tex
    const list = await trash(owner, p)
    expect(list.map(e => [e.name, e.originalPath, e.fileCount])).toEqual([['A', 'A', 1], ['f.tex', 'A/inner/f.tex', 1]])
    expect((await restore(owner, p, g.id)).status).toBe(404) // inside batch 2, not its top
    expect((await restore(owner, p, inner.id)).status).toBe(404)
    expect((await owner.del(`/api/projects/${p.id}/trash/${g.id}`)).status).toBe(404)

    // purge batch 2: f.tex stays in the trash, its path now partly unknown
    const textDoc = fileDocName(p.id, g.id, 1)
    expect(ts.lig.db.prepare('SELECT COUNT(*) AS n FROM doc_state WHERE doc_name = ?').get(textDoc)).toEqual({ n: 1 })
    expect((await owner.del(`/api/projects/${p.id}/trash/${a.id}`)).status).toBe(200)
    expect((await trash(owner, p)).map(e => [e.name, e.originalPath])).toEqual([['f.tex', '…/f.tex']])
    expect(ts.lig.db.prepare('SELECT COUNT(*) AS n FROM files WHERE id IN (?, ?, ?)').get(a.id, inner.id, g.id)).toEqual({ n: 0 })
    expect(ts.lig.db.prepare('SELECT COUNT(*) AS n FROM doc_state WHERE doc_name = ?').get(textDoc)).toEqual({ n: 0 })
    expect(ts.lig.db.prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_name = ?').get(textDoc)).toEqual({ n: 0 })
    expect(auditEntries(ts.lig.db, 'file.purge')).toEqual([expect.objectContaining({ detail: expect.objectContaining({ fileId: a.id, count: 3 }) })])
    // restoring the orphan goes to the root
    expect((await restore(owner, p, f.id)).body).toMatchObject({ parentId: p.rootId, name: 'f.tex' })
    expect((await owner.get(`/api/projects/${p.id}/files/${f.id}/raw`)).body).toBe('eff')
  })

  it('purge keeps blobs; empty trash (owner only) purges everything', async () => {
    const { ts, owner, ed, p } = await setup(39273)
    const meta = open(ts.base, owner, metaDocName(p.id))
    await waitFor(() => meta.provider.isSynced, 10_000, 'meta')
    const png = (await owner.upload(p.id, p.rootId, 'fig.png', makePng(6, 6))).body
    const hash = (ts.lig.db.prepare('SELECT blob_hash AS h FROM files WHERE id = ?').get(png.id) as { h: string }).h
    await del(owner, p, png.id)
    const n0 = meta.events().filter(e => e.type === 'trash-changed').length
    expect((await ed.del(`/api/projects/${p.id}/trash/${png.id}`)).status).toBe(200)
    await waitFor(() => meta.events().filter(e => e.type === 'trash-changed').length === n0 + 1, 5_000, 'trash-changed on purge')
    expect(ts.lig.blobs.has(hash)).toBe(true) // left for the M3 garbage collector
    expect((await ed.del(`/api/projects/${p.id}/trash/${png.id}`)).status).toBe(404)

    for (const n of ['a.tex', 'b.tex', 'c.tex']) await del(owner, p, (await mk(owner, p, p.rootId, n, 'text', n)).id)
    expect(await trash(owner, p)).toHaveLength(3)
    expect((await ed.del(`/api/projects/${p.id}/trash`)).status).toBe(403)
    expect((await owner.del(`/api/projects/${p.id}/trash`)).status).toBe(200)
    expect(await trash(owner, p)).toEqual([])
    expect(ts.lig.db.prepare('SELECT COUNT(*) AS n FROM files WHERE project_id = ? AND deleted_at IS NOT NULL').get(p.id)).toEqual({ n: 0 })
    expect(auditEntries(ts.lig.db, 'trash.empty')).toEqual([expect.objectContaining({ actorId: expect.any(String), detail: { batches: 3, count: 3 } })])
    // the live tree is untouched
    expect((await project(owner, p.id)).tree.map(f => f.name).sort()).toEqual(['', 'main.tex'])
  })

  it('viewers can see the trash but not restore or purge; strangers get 404', async () => {
    const { ts, owner, viewer, p } = await setup(39274)
    const stranger = await signup(ts.base, 'stranger')
    const f = await mk(owner, p, p.rootId, 'x.tex', 'text', 'x')
    await del(owner, p, f.id)
    expect((await trash(viewer, p)).map(e => e.id)).toEqual([f.id])
    expect((await restore(viewer, p, f.id)).status).toBe(403)
    expect((await viewer.del(`/api/projects/${p.id}/trash/${f.id}`)).status).toBe(403)
    expect((await viewer.del(`/api/projects/${p.id}/trash`)).status).toBe(403)
    expect((await stranger.get(`/api/projects/${p.id}/trash`)).status).toBe(404)
    expect((await restore(stranger, p, f.id)).status).toBe(404)
    expect((await stranger.del(`/api/projects/${p.id}/trash`)).status).toBe(404)
    expect(await trash(owner, p)).toHaveLength(1)
  })

  it('restore checks the project limits (413 project-too-large) and path limits', async () => {
    const { owner, p } = await setup(39275, { limits: { maxFiles: 3 } })
    const a = await mk(owner, p, p.rootId, 'a.tex', 'text')
    await mk(owner, p, p.rootId, 'b.tex', 'text') // main.tex + a + b = 3
    await del(owner, p, a.id)
    await mk(owner, p, p.rootId, 'c.tex', 'text')
    const r = await restore(owner, p, a.id)
    expect(r.status).toBe(413)
    expect(r.body.error).toBe('project-too-large')
    expect(await trash(owner, p)).toHaveLength(1)
  })

  it('retention: expired batches are purged by the sweep (fake clock) and at startup', async () => {
    const { ts, owner, p } = await setup(39276, { limits: { trashRetentionMs: 2 * DAY } })
    const old = await mk(owner, p, p.rootId, 'old.tex', 'text', 'old')
    await del(owner, p, old.id)
    const [entry] = await trash(owner, p)
    expect(entry!.expiresAt).toBe(entry!.deletedAt + 2 * DAY)
    expect(await ts.lig.sweepTrash(entry!.deletedAt + 2 * DAY - 1)).toBe(0)
    expect(await ts.lig.sweepTrash(entry!.deletedAt + 2 * DAY)).toBe(1)
    expect(await trash(owner, p)).toEqual([])
    expect(auditEntries(ts.lig.db, 'file.purge')).toEqual([expect.objectContaining({ actorId: null, detail: expect.objectContaining({ reason: 'expired' }) })])

    // startup sweep: restart on the same data with a clock 31 days ahead (default retention: 30 days)
    const keep = await mk(owner, p, p.rootId, 'keep.tex', 'text', 'k')
    await del(owner, p, keep.id)
    expect(await trash(owner, p)).toHaveLength(1)
    await ts.stop()
    servers.splice(servers.indexOf(ts), 1)
    const same = await startTestServer(39277, { dataDir: ts.dataDir, limits: { trashRetentionMs: 2 * DAY } })
    servers.push(same)
    // sessions live in the database: the same cookie works after a restart
    const asOwner = (base: string) => Object.assign(new Client(base), { cookie: owner.cookie })
    // not expired yet with the real clock
    expect(await trash(asOwner(same.base), p)).toHaveLength(1)
    await same.stop()
    servers.splice(servers.indexOf(same), 1)
    const later = await startTestServer(39278, { dataDir: ts.dataDir, clock: () => Date.now() + 31 * DAY })
    servers.push(later)
    await waitFor(() => (later.lig.db.prepare('SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NOT NULL').get() as { n: number }).n === 0, 5_000, 'startup sweep')
    expect(await trash(asOwner(later.base), p)).toEqual([])
  })
})

describe('restoredName', () => {
  const takenOf = (...names: string[]) => (n: string) => names.map(x => x.toLowerCase()).includes(n.toLowerCase())
  it('suffixes before the extension of files, after folder names, case-insensitively', () => {
    expect(restoredName('main.tex', 'text', takenOf())).toBe('main.tex')
    expect(restoredName('main.tex', 'text', takenOf('MAIN.TEX'))).toBe('main (restored).tex')
    expect(restoredName('main.tex', 'text', takenOf('main.tex', 'main (restored).tex', 'Main (Restored 2).tex'))).toBe('main (restored 3).tex')
    expect(restoredName('fig.v2.png', 'binary', takenOf('fig.v2.png'))).toBe('fig.v2 (restored).png')
    expect(restoredName('.latexmkrc', 'text', takenOf('.latexmkrc'))).toBe('.latexmkrc (restored)')
    expect(restoredName('chapters.old', 'folder', takenOf('chapters.old'))).toBe('chapters.old (restored)')
    const long = `${'x'.repeat(251)}.tex`
    const r = restoredName(long, 'text', takenOf(long))
    expect(r.length).toBeLessThanOrEqual(255)
    expect(r.endsWith(' (restored).tex')).toBe(true)
  })
})
