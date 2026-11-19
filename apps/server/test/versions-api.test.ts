import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import * as Y from 'yjs'
import {
  fileDocName, metaDocName, type ImportResponse, type ProjectDetail, type RestoreVersionResponse, type TrashEntry, type TreeEntry,
  type VersionDetail, type VersionDiff, type VersionPage, type VersionSummary,
} from '@ligature/shared'
import { auditEntries } from '../src/audit.ts'
import { MAIN_TEMPLATE } from '../src/projects/service.ts'
import { connect, waitFor } from './harness.ts'
import { addMember, Client, newProject, openInstance, project, signup, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'
import { craftZip } from './fixtures/zips/craft.ts'

/* History routes: list/detail/file/diff/export, named versions, labels, restore (docs/M3.md §2). */

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

const sha = (b: string | Uint8Array) => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b, 'utf8') : b).digest('hex')

function open(base: string, c: Client, docName: string) {
  const x = connect(base, c.cookie, docName)
  sockets.push(x)
  return x
}

async function setup(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const { ts } = await openInstance(port, { history: { tickMs: 3_600_000 }, ...opts }); servers.push(ts)
  const owner = await signup(ts.base, 'owner', { displayName: 'Olivia Owner' })
  const ed = await signup(ts.base, 'editor', { displayName: 'Eddie Editor' })
  const viewer = await signup(ts.base, 'viewer', { displayName: 'Vera Viewer' })
  const stranger = await signup(ts.base, 'stranger')
  const p = await newProject(owner)
  await addMember(owner, ed, p.id, 'editor')
  await addMember(owner, viewer, p.id, 'viewer')
  // The owner keeps the project open (no "last client left" versions during the test).
  const meta = open(ts.base, owner, metaDocName(p.id))
  await waitFor(() => meta.provider.isSynced, 10_000, 'meta sync')
  return { ts, owner, ed, viewer, stranger, p, meta }
}

const V = (p: ProjectDetail) => `/api/projects/${p.id}/versions`
const mk = async (c: Client, p: ProjectDetail, parentId: string, name: string, kind: 'folder' | 'text', content?: string) => {
  const r = await c.post<TreeEntry>(`/api/projects/${p.id}/files`, { parentId, name, kind, ...(content !== undefined ? { content } : {}) })
  if (r.status !== 200) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}
const named = async (c: Client, p: ProjectDetail, label: string) => {
  const r = await c.post<VersionSummary>(V(p), { label })
  if (r.status !== 200) throw new Error(`named: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}
const restore = (c: Client, p: ProjectDetail, id: string, body?: { paths?: string[] }) =>
  body === undefined ? c.req<RestoreVersionResponse>('POST', `${V(p)}/${id}/restore`) : c.post<RestoreVersionResponse>(`${V(p)}/${id}/restore`, body)

/** path -> content (text as string, binary as sha256) of the live project, through the public API. */
async function snapshot(c: Client, projectId: string): Promise<Record<string, string>> {
  const d = await project(c, projectId)
  const byId = new Map(d.tree.map(e => [e.id, e]))
  const pathOf = (e: TreeEntry): string => {
    const parent = e.parentId ? byId.get(e.parentId) : undefined
    return parent && parent.parentId !== null ? `${pathOf(parent)}/${e.name}` : e.name
  }
  const out: Record<string, string> = {}
  for (const e of d.tree) {
    if (e.kind === 'folder') continue
    const r = await c.req('GET', `/api/projects/${projectId}/files/${e.id}/raw`)
    const bytes = new Uint8Array(await r.raw.arrayBuffer())
    out[pathOf(e)] = e.kind === 'text' ? Buffer.from(bytes).toString('utf8') : `sha:${sha(bytes)}`
  }
  return out
}
const folders = async (c: Client, projectId: string) => (await project(c, projectId)).tree.filter(e => e.kind === 'folder' && e.parentId !== null).map(e => e.name).sort()

describe('history routes', () => {
  it('permissions, 404s, labels, detail, file contents with safe headers', async () => {
    const { ts, owner, ed, viewer, stranger, p } = await setup(39117)
    const png = makePng(3, 3)
    expect((await owner.upload(p.id, p.rootId, 'fig.png', png)).status).toBe(200)
    expect((await viewer.post(V(p), { label: 'x' })).status).toBe(403)
    expect((await stranger.get(V(p))).status).toBe(404)
    expect((await stranger.post(V(p), { label: 'x' })).status).toBe(404)
    expect((await new Client(ts.base).get(V(p))).status).toBe(401)
    for (const label of ['', '   ', 'x'.repeat(201), 'a\u0007b']) expect((await ed.post(V(p), { label })).status, label).toBe(400)
    expect((await ed.post(V(p), { label: 'ok', extra: 1 })).status).toBe(400)

    const v = await named(ed, p, 'Submitted to arXiv')
    // authors: whoever changed something since the previous version (the owner's upload)
    expect(v).toMatchObject({ kind: 'named', label: 'Submitted to arXiv', createdBy: 'Eddie Editor', fileCount: 2, authors: ['Olivia Owner'] })
    expect(auditEntries(ts.lig.db, 'version.create')).toEqual([expect.objectContaining({ projectId: p.id, detail: { versionId: v.id, label: 'Submitted to arXiv' } })])

    // labels: owner/editor only; null clears
    expect((await viewer.patch(`${V(p)}/${v.id}`, { label: 'nope' })).status).toBe(403)
    expect((await ed.patch(`${V(p)}/${v.id}`, { label: 'Camera ready' })).body).toMatchObject({ id: v.id, label: 'Camera ready' })
    expect((await ed.patch(`${V(p)}/${v.id}`, { label: null })).body).toMatchObject({ label: null })
    expect((await ed.patch(`${V(p)}/${v.id}`, {})).status).toBe(400)
    expect(auditEntries(ts.lig.db, 'version.label')).toHaveLength(2)

    // detail (any member)
    const d = (await viewer.get<VersionDetail>(`${V(p)}/${v.id}`)).body
    expect(d.version.id).toBe(v.id)
    expect(d.files).toEqual([
      { path: 'fig.png', fileId: expect.any(String), kind: 'binary', size: png.byteLength, hash: sha(png) },
      { path: 'main.tex', fileId: p.tree.find(f => f.name === 'main.tex')!.id, kind: 'text', size: Buffer.byteLength(MAIN_TEMPLATE), hash: sha(MAIN_TEMPLATE) },
    ])

    // file contents
    const t = await viewer.get(`${V(p)}/${v.id}/file?path=main.tex`)
    expect(t.status).toBe(200)
    expect(t.body).toBe(MAIN_TEMPLATE)
    expect(t.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(t.headers.get('content-disposition')).toMatch(/^attachment; filename="main.tex"/)
    expect(t.headers.get('x-content-type-options')).toBe('nosniff')
    expect(t.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    const b = await viewer.get(`${V(p)}/${v.id}/file?path=fig.png&inline=1`)
    expect(b.headers.get('content-type')).toBe('image/png')
    expect(b.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(Buffer.from(await b.raw.arrayBuffer()).equals(png)).toBe(true)
    expect((await viewer.get(`${V(p)}/${v.id}/file?path=fig.png`)).headers.get('content-disposition')).toMatch(/^attachment;/)
    expect((await viewer.get(`${V(p)}/${v.id}/file?path=nope.tex`)).status).toBe(404)
    expect((await viewer.get(`${V(p)}/${v.id}/file`)).status).toBe(400)

    // ids: malformed, unknown, another project's version
    const q = await newProject(owner, 'Other')
    const w = await named(owner, q, 'other')
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000', w.id]) {
      expect((await viewer.get(`${V(p)}/${id}`)).status, id).toBe(404)
      expect((await viewer.get(`${V(p)}/${id}/file?path=main.tex`)).status, id).toBe(404)
      expect((await viewer.get(`${V(p)}/${id}/diff`)).status, id).toBe(404)
      expect((await ed.patch(`${V(p)}/${id}`, { label: 'x' })).status, id).toBe(404)
      expect((await ed.post(`${V(p)}/${id}/restore`, {})).status, id).toBe(404)
      expect((await viewer.get(`${V(p)}/${id}/export.zip`)).status, id).toBe(404)
    }
    expect((await viewer.post(`${V(p)}/${v.id}/restore`, {})).status).toBe(403)
    expect((await ed.req('POST', `${V(p)}/${v.id}/restore`, {}, { origin: 'https://evil.example' })).status).toBe(403)
  })

  it('diff: renames, modifications, default previous version, "current" on either side', async () => {
    const { owner, viewer, p } = await setup(39118)
    const main = p.tree.find(f => f.name === 'main.tex')!
    const ch = await mk(owner, p, p.rootId, 'ch', 'folder')
    const intro = await mk(owner, p, ch.id, 'intro.tex', 'text', 'Intro')
    const notes = await mk(owner, p, p.rootId, 'notes.md', 'text', 'n')
    const v1 = await named(owner, p, 'one')
    // rename + edit intro, move notes, delete nothing, add a file, edit main
    expect((await owner.patch(`/api/projects/${p.id}/files/${intro.id}`, { name: 'introduction.tex', parentId: p.rootId })).status).toBe(200)
    await owner.upload(p.id, p.rootId, 'introduction.tex', 'Intro, longer')
    expect((await owner.patch(`/api/projects/${p.id}/files/${notes.id}`, { parentId: ch.id })).status).toBe(200)
    await mk(owner, p, p.rootId, 'new.bib', 'text', '@book{x}')
    await owner.upload(p.id, p.rootId, 'main.tex', 'changed')
    const v2 = await named(owner, p, 'two')

    const d = (await viewer.get<VersionDiff>(`${V(p)}/${v2.id}/diff`)).body
    expect(d.from).toBe(v1.id)
    expect(d.to).toBe(v2.id)
    expect(d.files.map(f => [f.change, f.oldPath, f.path, f.modified])).toEqual([
      ['renamed', 'notes.md', 'ch/notes.md', false],
      ['renamed', 'ch/intro.tex', 'introduction.tex', true],
      ['modified', 'main.tex', 'main.tex', true],
      ['added', '', 'new.bib', false],
    ])
    expect(d.files.find(f => f.path === 'main.tex')).toMatchObject({ kind: 'text', oldHash: sha(MAIN_TEMPLATE), newHash: sha('changed') })
    expect(v2.changes).toEqual({ added: 1, removed: 0, modified: 3 })

    // explicit `against`, and the first version of all (no previous: everything added, from '')
    const back = (await viewer.get<VersionDiff>(`${V(p)}/${v1.id}/diff?against=${v2.id}`)).body
    expect(back.files.find(f => f.path === 'ch/intro.tex')).toMatchObject({ change: 'renamed', oldPath: 'introduction.tex' })
    expect(back.files.find(f => f.oldPath === 'new.bib')).toMatchObject({ change: 'removed', path: '' })
    const all = (await viewer.get<VersionPage>(V(p))).body.versions
    const first = all[all.length - 1]!
    const fd = (await viewer.get<VersionDiff>(`${V(p)}/${first.id}/diff`)).body
    expect(fd.from).toBe('')
    expect(fd.files.every(f => f.change === 'added')).toBe(true)

    // current: live state, not stored
    const n = all.length
    await owner.upload(p.id, p.rootId, 'main.tex', 'live edit')
    const cur = (await viewer.get<VersionDiff>(`${V(p)}/${v2.id}/diff?against=current`)).body
    expect(cur.from).toBe('current')
    expect(cur.files.filter(f => f.change !== 'unchanged').map(f => [f.change, f.path, f.oldHash, f.newHash]))
      .toEqual([['modified', 'main.tex', sha('live edit'), sha('changed')]])
    const toCur = (await viewer.get<VersionDiff>(`${V(p)}/current/diff`)).body
    expect(toCur).toMatchObject({ from: v2.id, to: 'current' })
    expect(toCur.files.filter(f => f.change !== 'unchanged').map(f => f.path)).toEqual(['main.tex'])
    expect((await viewer.get<VersionPage>(V(p))).body.versions).toHaveLength(n) // nothing stored
    expect((await viewer.get(`${V(p)}/${v2.id}/diff?against=bogus`)).status).toBe(400)
    void main
  })

  it('export.zip of a version: its files, M2 headers', async () => {
    const { owner, viewer, stranger, p } = await setup(39121)
    const png = makePng(5, 5)
    const sub = await mk(owner, p, p.rootId, 'sub', 'folder')
    await mk(owner, p, sub.id, 'a.tex', 'text', 'été')
    await owner.upload(p.id, sub.id, 'p.png', png)
    const v = await named(owner, p, 'Final/v2: "ok"')
    await owner.upload(p.id, p.rootId, 'main.tex', 'later') // not in the zip
    const r = await viewer.req('GET', `${V(p)}/${v.id}/export.zip`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/zip')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="Paper - Final_v2_ _ok_.zip"/)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    const files = unzipSync(new Uint8Array(await r.raw.arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual(['main.tex', 'sub/a.tex', 'sub/p.png'])
    expect(Buffer.from(files['main.tex']!).toString('utf8')).toBe(MAIN_TEMPLATE)
    expect(Buffer.from(files['sub/a.tex']!).toString('utf8')).toBe('été')
    expect(Buffer.from(files['sub/p.png']!).equals(png)).toBe(true)
    expect((await stranger.get(`${V(p)}/${v.id}/export.zip`)).status).toBe(404)
  })

  it('an imported project starts with an import version of its content', async () => {
    const { owner } = await setup(39122)
    const zip = craftZip([{ name: 'main.tex', data: '\\documentclass{article}\n' }, { name: 'img/x.bin', data: 'binary\u0000data' }])
    const r = await owner.req<ImportResponse>('POST', '/api/projects/import?name=Imp', undefined,
      { raw: zip as BodyInit, headers: { 'content-type': 'application/zip' } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const p = r.body.project
    const list = (await owner.get<VersionPage>(V(p))).body.versions
    expect(list).toEqual([expect.objectContaining({ kind: 'import', createdBy: 'Olivia Owner', fileCount: 2 })])
    expect((await owner.get(`${V(p)}/${list[0]!.id}/file?path=main.tex`)).body).toBe('\\documentclass{article}\n')
  })
})

describe('restore', () => {
  it('whole project: rename back, from the trash, purged -> re-created, binaries, extra files -> trash; minimal diff; events; undo', async () => {
    const { ts, owner, ed, p, meta } = await setup(39123)
    const main = p.tree.find(f => f.name === 'main.tex')!
    const ch = await mk(owner, p, p.rootId, 'chapters', 'folder')
    const intro = await mk(owner, p, ch.id, 'intro.tex', 'text', 'Intro text\n')
    const notes = await mk(owner, p, p.rootId, 'notes.md', 'text', 'my notes')
    const png1 = makePng(2, 2, [1, 2, 3])
    const png2 = makePng(2, 2, [9, 9, 9])
    const logo = (await owner.upload(p.id, p.rootId, 'logo.png', png1)).body
    const fig = (await owner.upload(p.id, ch.id, 'fig.png', makePng(4, 4))).body
    const v1 = await named(owner, p, 'V1')
    const atV1 = await snapshot(owner, p.id)

    // A collaborator has main.tex open while everything changes.
    const doc = open(ts.base, ed, fileDocName(p.id, main.id, 1))
    await waitFor(() => doc.provider.isSynced, 10_000, 'sync')
    const ydoc = doc.doc
    doc.text().insert(MAIN_TEMPLATE.indexOf('\\section'), 'NEW PARAGRAPH\n\n')
    await waitFor(() => !doc.provider.hasUnsyncedChanges, 5_000, 'acked')
    const anchor = Y.createRelativePositionFromTypeIndex(doc.text(), 5) // inside "\documentclass": unchanged by the restore
    expect((await owner.patch(`/api/projects/${p.id}/files/${intro.id}`, { name: 'introduction.tex', parentId: p.rootId })).status).toBe(200)
    await owner.upload(p.id, p.rootId, 'introduction.tex', 'Intro text, rewritten\n')
    expect((await owner.del(`/api/projects/${p.id}/files/${notes.id}`)).status).toBe(200) // -> trash
    expect((await owner.del(`/api/projects/${p.id}/files/${fig.id}`)).status).toBe(200)
    expect((await owner.del(`/api/projects/${p.id}/trash/${fig.id}`)).status).toBe(200) // purged
    await owner.upload(p.id, p.rootId, 'logo.png', png2) // binary replaced
    await mk(owner, p, p.rootId, 'extra.tex', 'text', 'extra') // not in V1
    const scratch = await mk(owner, p, p.rootId, 'scratch', 'folder')
    await mk(owner, p, scratch.id, 's.tex', 'text', 's') // not in V1, in a folder V1 doesn't have
    await mk(owner, p, p.rootId, 'empty', 'folder') // an empty folder: stays
    const before = await snapshot(owner, p.id)
    const treeVersionBefore = (await project(owner, p.id)).treeVersion
    const nEvents = meta.events().length

    const r = await restore(ed, p, v1.id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({ preRestoreVersionId: expect.any(String), restored: 5, trashed: 2 })
    // restored: intro (moved + text), notes (from trash), fig (re-created), logo (blob), main (text)

    expect(await snapshot(owner, p.id)).toEqual(atV1)
    expect(await folders(owner, p.id)).toEqual(['chapters', 'empty'])
    const tree = (await project(owner, p.id)).tree
    expect(tree.find(e => e.id === intro.id)).toMatchObject({ name: 'intro.tex', parentId: ch.id })
    expect(tree.find(e => e.id === notes.id)).toMatchObject({ name: 'notes.md', parentId: p.rootId })
    expect(tree.find(e => e.id === logo.id)).toMatchObject({ name: 'logo.png', size: png1.byteLength })
    const newFig = tree.find(e => e.name === 'fig.png')!
    expect(newFig.id).not.toBe(fig.id)
    expect((await project(owner, p.id)).treeVersion).toBeGreaterThan(treeVersionBefore)

    // the collaborator's doc was edited, not replaced: same Y.Doc, anchors in unchanged text survive
    await waitFor(() => doc.text().toString() === MAIN_TEMPLATE, 5_000, 'collaborator sees the restored text')
    expect(doc.doc).toBe(ydoc)
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, ydoc)?.index).toBe(5)
    doc.text().insert(0, '%')
    await waitFor(() => !doc.provider.hasUnsyncedChanges, 5_000, 'still editable')
    doc.text().delete(0, 1)
    await waitFor(() => !doc.provider.hasUnsyncedChanges, 5_000, 'acked')

    // trash: the two extra items, one entry each, deleted by the caller
    const trash = (await owner.get<TrashEntry[]>(`/api/projects/${p.id}/trash`)).body
    expect(trash.map(e => [e.originalPath, e.fileCount, e.deletedBy]).sort()).toEqual([['extra.tex', 1, 'Eddie Editor'], ['scratch', 1, 'Eddie Editor']])

    // events
    await waitFor(() => meta.events().slice(nEvents).some(e => e.type === 'version-restored'), 5_000, 'version-restored')
    const evs = meta.events().slice(nEvents)
    expect(evs.map(e => e.type)).toEqual(expect.arrayContaining(['versions-changed', 'tree-changed', 'trash-changed', 'version-restored']))
    expect(evs.find(e => e.type === 'version-restored')).toEqual({ type: 'version-restored', versionId: v1.id, preRestoreVersionId: r.body.preRestoreVersionId, by: 'Eddie Editor' })
    expect(evs.map(e => e.type).indexOf('versions-changed')).toBeLessThan(evs.map(e => e.type).indexOf('tree-changed')) // the undo point exists first

    // the pre_restore version: labelled, by the caller, the state before the restore
    const list = (await owner.get<VersionPage>(V(p))).body.versions
    expect(list[0]).toMatchObject({ id: r.body.preRestoreVersionId, kind: 'pre_restore', label: 'Before restoring "V1"', createdBy: 'Eddie Editor' })
    expect(auditEntries(ts.lig.db, 'version.restore')).toEqual([expect.objectContaining({
      actorId: expect.any(String), projectId: p.id, detail: { versionId: v1.id, label: 'V1', versionAt: expect.any(Number), preRestoreVersionId: r.body.preRestoreVersionId, restored: 5, trashed: 2 },
    })])

    // Undo = restore the pre_restore version: every file is back; the re-created figure goes to the trash, with
    // `chapters`, which it leaves empty (versions record files, not folders: an emptied folder goes too)
    const u = await restore(owner, p, r.body.preRestoreVersionId)
    expect(u.status, JSON.stringify(u.body)).toBe(200)
    expect(u.body).toMatchObject({ trashed: 2 }) // the figure and notes.md (trashed before V1 was restored)
    expect(await snapshot(owner, p.id)).toEqual(before)
    expect(await folders(owner, p.id)).toEqual(['empty', 'scratch'])
    await waitFor(() => doc.text().toString() === before['main.tex'], 5_000, 'collaborator sees the undo')
    const trash2 = (await owner.get<TrashEntry[]>(`/api/projects/${p.id}/trash`)).body.map(e => [e.originalPath, e.fileCount]).sort()
    expect(trash2).toEqual([['chapters', 1], ['notes.md', 1]])
    // and the undo itself can be undone
    const list2 = (await owner.get<VersionPage>(V(p))).body.versions
    expect(list2[0]).toMatchObject({ id: u.body.preRestoreVersionId, kind: 'pre_restore', label: 'Before restoring "Before restoring "V1""' })
    // the restore's changes were credited to whoever restored (the editor; the owner only undid it afterwards)
    expect(list2[0]!.authors).toEqual(['Eddie Editor'])
    expect((await restore(owner, p, u.body.preRestoreVersionId)).status).toBe(200)
    expect(await snapshot(owner, p.id)).toEqual(atV1)
  })

  it('partial restore: only the given paths; clash -> the occupant goes to the trash; bad paths', async () => {
    const { ts, owner, ed, p } = await setup(39124)
    const a = await mk(owner, p, p.rootId, 'a.tex', 'text', 'A1')
    const b = await mk(owner, p, p.rootId, 'b.tex', 'text', 'B1')
    const v1 = await named(owner, p, 'V1')
    expect((await owner.patch(`/api/projects/${p.id}/files/${a.id}`, { name: 'moved.tex' })).status).toBe(200)
    await owner.upload(p.id, p.rootId, 'moved.tex', 'A2')
    const squatter = await mk(owner, p, p.rootId, 'a.tex', 'text', 'squatter')
    await owner.upload(p.id, p.rootId, 'b.tex', 'B2')
    await mk(owner, p, p.rootId, 'c.tex', 'text', 'C')

    expect((await restore(ed, p, v1.id, { paths: ['nope.tex'] })).status).toBe(400)
    expect((await restore(ed, p, v1.id, { paths: [] })).status).toBe(400)
    const r = await restore(ed, p, v1.id, { paths: ['a.tex'] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ restored: 1, trashed: 1 })
    expect(await snapshot(owner, p.id)).toEqual({ 'main.tex': MAIN_TEMPLATE, 'a.tex': 'A1', 'b.tex': 'B2', 'c.tex': 'C' })
    expect((await project(owner, p.id)).tree.find(e => e.name === 'a.tex')!.id).toBe(a.id)
    const trash = (await owner.get<TrashEntry[]>(`/api/projects/${p.id}/trash`)).body
    expect(trash.map(e => [e.id, e.originalPath])).toEqual([[squatter.id, 'a.tex']])
    // the undo point took the owner's pending changes; the restore itself is credited to the editor
    const pre = (await owner.get<VersionDetail>(`${V(p)}/${r.body.preRestoreVersionId}`)).body.version
    expect(pre.authors).toEqual(['Olivia Owner'])
    expect(ts.lig.db.prepare('SELECT u.display_name AS n FROM pending_authors pa JOIN users u ON u.id = pa.user_id WHERE pa.project_id = ?').all(p.id))
      .toEqual([{ n: 'Eddie Editor' }])
    // a second partial restore of an unchanged file changes nothing (but still takes the undo point)
    const again = await restore(ed, p, v1.id, { paths: ['a.tex'] })
    expect(again.body).toMatchObject({ restored: 0, trashed: 0 })
    void b
  })

  it('a file restored from inside a trashed folder brings the folder back; the rest of that trash batch stays restorable', async () => {
    const { owner, p } = await setup(39127)
    const d = await mk(owner, p, p.rootId, 'd', 'folder')
    const x = await mk(owner, p, d.id, 'x.tex', 'text', 'X')
    await mk(owner, p, d.id, 'y.tex', 'text', 'Y')
    await mk(owner, p, d.id, 'z.tex', 'text', 'Z')
    const v1 = await named(owner, p, 'V1')
    expect((await owner.del(`/api/projects/${p.id}/files/${d.id}`)).status).toBe(200) // one batch: d, x, y, z
    const r = await restore(owner, p, v1.id, { paths: ['d/x.tex'] })
    expect(r.body).toMatchObject({ restored: 1, trashed: 0 })
    const tree = (await project(owner, p.id)).tree
    expect(tree.find(e => e.id === d.id)).toMatchObject({ name: 'd', parentId: p.rootId }) // the same folder, back from the trash
    expect(tree.find(e => e.id === x.id)).toMatchObject({ parentId: d.id })
    expect(await snapshot(owner, p.id)).toEqual({ 'main.tex': MAIN_TEMPLATE, 'd/x.tex': 'X' })
    // y and z are now two trash entries (one top item per batch), each restorable on its own
    const trash = (await owner.get<TrashEntry[]>(`/api/projects/${p.id}/trash`)).body
    expect(trash.map(e => e.originalPath).sort()).toEqual(['d/y.tex', 'd/z.tex'])
    for (const e of trash) expect((await owner.post(`/api/projects/${p.id}/trash/${e.id}/restore`, {})).status).toBe(200)
    expect(await snapshot(owner, p.id)).toEqual({ 'main.tex': MAIN_TEMPLATE, 'd/x.tex': 'X', 'd/y.tex': 'Y', 'd/z.tex': 'Z' })
    // an unlabelled version: the undo point is labelled with its date
    const first = (await owner.get<VersionPage>(V(p))).body.versions.at(-1)!
    expect(first).toMatchObject({ kind: 'auto', label: null })
    const u = await restore(owner, p, first.id, { paths: ['main.tex'] })
    const pre = (await owner.get<VersionDetail>(`${V(p)}/${u.body.preRestoreVersionId}`)).body.version
    expect(pre.label).toMatch(/^Before restoring "\d{4}-\d\d-\d\d \d\d:\d\d"$/)
  })

  it('limits: a restore that would exceed the project limits fails before changing anything', async () => {
    const { ts, owner, p } = await setup(39125, { limits: { maxFiles: 4 } })
    const a = await mk(owner, p, p.rootId, 'a.tex', 'text', 'a')
    const b = await mk(owner, p, p.rootId, 'b.tex', 'text', 'b')
    const v1 = await named(owner, p, 'V1') // main, a, b
    expect((await owner.del(`/api/projects/${p.id}/files/${a.id}`)).status).toBe(200)
    expect((await owner.del(`/api/projects/${p.id}/files/${b.id}`)).status).toBe(200)
    await mk(owner, p, p.rootId, 'c.tex', 'text', 'c')
    await mk(owner, p, p.rootId, 'd.tex', 'text', 'd')
    await mk(owner, p, p.rootId, 'e.tex', 'text', 'e') // 4 live nodes
    const before = await snapshot(owner, p.id)
    const tv = (await project(owner, p.id)).treeVersion
    const nVersions = (await owner.get<VersionPage>(V(p))).body.versions.length
    const r = await restore(owner, p, v1.id, { paths: ['a.tex', 'b.tex'] }) // would be 6
    expect(r.status).toBe(413)
    expect(r.body.error).toBe('project-too-large')
    expect(await snapshot(owner, p.id)).toEqual(before)
    expect((await project(owner, p.id)).treeVersion).toBe(tv)
    expect((await owner.get<VersionPage>(V(p))).body.versions).toHaveLength(nVersions) // not even a pre_restore version
    // a whole restore fits (c, d, e go to the trash)
    expect((await restore(owner, p, v1.id)).body).toMatchObject({ restored: 2, trashed: 3 })
    expect(Object.keys(await snapshot(owner, p.id)).sort()).toEqual(['a.tex', 'b.tex', 'main.tex'])
    void ts
  })

  it('restores of one project are serialized', async () => {
    const { ts, owner, p } = await setup(39126)
    await mk(owner, p, p.rootId, 'a.tex', 'text', 'one')
    const v1 = await named(owner, p, 'one')
    await owner.upload(p.id, p.rootId, 'a.tex', 'two')
    const v2 = await named(owner, p, 'two')
    await owner.upload(p.id, p.rootId, 'a.tex', 'three')
    const [r1, r2] = await Promise.all([restore(owner, p, v1.id), restore(owner, p, v2.id)])
    expect([r1.status, r2.status]).toEqual([200, 200])
    // Whichever ran second saw the first one's result as its undo point, and won.
    const order = auditEntries(ts.lig.db, 'version.restore').map(e => (e.detail as { versionId: string }).versionId)
    const text: Record<string, string> = { [v1.id]: 'one', [v2.id]: 'two' }
    expect(order.sort()).toEqual([v1.id, v2.id].sort())
    const [firstRun, secondRun] = auditEntries(ts.lig.db, 'version.restore').map(e => e.detail as { versionId: string; preRestoreVersionId: string })
    expect((await snapshot(owner, p.id))['a.tex']).toBe(text[secondRun!.versionId])
    const pre1 = (await owner.get<VersionDetail>(`${V(p)}/${firstRun!.preRestoreVersionId}`)).body
    const pre2 = (await owner.get<VersionDetail>(`${V(p)}/${secondRun!.preRestoreVersionId}`)).body
    expect(pre1.files.find(f => f.path === 'a.tex')!.hash).toBe(sha('three'))
    expect(pre2.files.find(f => f.path === 'a.tex')!.hash).toBe(sha(text[firstRun!.versionId]!))
    expect([r1.body.restored, r2.body.restored]).toEqual([1, 1])
  })
})
