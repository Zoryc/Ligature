import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { fileDocName, metaDocName, type ProjectDetail, type TreeEntry } from '@ligature/shared'
import { auditEntries } from '../src/audit.ts'
import { connect, sleep, waitFor } from './harness.ts'
import { addMember, me, newProject, openInstance, project, signup, type Client, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

async function setup(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const { ts } = await openInstance(port, opts); servers.push(ts)
  const owner = await signup(ts.base, 'owner')
  const ed = await signup(ts.base, 'editor')
  const p = await newProject(owner)
  await addMember(owner, ed, p.id, 'editor')
  return { ts, owner, ed, p }
}

function open(base: string, c: Client, docName: string) {
  const x = connect(base, c.cookie, docName)
  sockets.push(x)
  return x
}

const mk = (c: Client, p: ProjectDetail, parentId: string, name: string, kind: 'folder' | 'text', content?: string) =>
  c.post<TreeEntry>(`/api/projects/${p.id}/files`, { parentId, name, kind, ...(content !== undefined ? { content } : {}) })

describe('file tree', () => {
  it('create, rename, move, name-taken, invalid names, root protection, tree-changed broadcast', async () => {
    const { ts, owner, ed, p } = await setup(39180)
    const meta = open(ts.base, owner, metaDocName(p.id))
    await waitFor(() => meta.provider.isSynced, 10_000, 'meta sync')

    const fig = await mk(ed, p, p.rootId, 'figures', 'folder')
    expect(fig.status).toBe(200)
    expect(fig.body).toEqual({ id: expect.any(String), parentId: p.rootId, name: 'figures', kind: 'folder' })
    const ch = (await mk(ed, p, p.rootId, 'chapter.tex', 'text', 'Hello\r\nworld\n')).body
    expect(ch).toMatchObject({ kind: 'text', epoch: 1 })
    expect((await owner.get(`/api/projects/${p.id}/files/${ch.id}/raw`)).body).toBe('Hello\nworld\n')
    await waitFor(() => meta.events().filter(e => e.type === 'tree-changed').length === 2, 5_000, 'tree-changed events')
    // (M3: the first change also takes a version of the original state: `versions-changed`)
    expect(meta.events().filter(e => e.type === 'tree-changed').map(e => e.treeVersion)).toEqual([1, 2])
    expect((await project(owner, p.id)).treeVersion).toBe(2)

    expect((await mk(ed, p, p.rootId, 'chapter.tex', 'text')).body.error).toBe('name-taken')
    expect((await mk(ed, p, p.rootId, 'CHAPTER.TEX', 'folder')).body.error).toBe('name-taken') // case-insensitive
    for (const bad of ['a/b', '..', '.', ' x', 'x ', 'a\\b', 'a:b', '', 'x'.repeat(256), 'tab\there']) {
      expect((await mk(ed, p, p.rootId, bad, 'text')).status, bad).toBe(400)
    }
    expect((await mk(ed, p, ch.id, 'inside.tex', 'text')).status).toBe(400) // parent is a file
    const other = await newProject(owner, 'Other')
    expect((await mk(ed, p, other.rootId, 'x.tex', 'text')).status).toBe(400) // parent in another project
    expect((await ed.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'f', kind: 'folder', content: 'x' })).status).toBe(400)
    expect((await ed.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'b.png', kind: 'binary' })).status).toBe(400)

    // rename + move (epoch and doc untouched)
    const doc = open(ts.base, ed, fileDocName(p.id, ch.id, 1))
    await waitFor(() => doc.provider.isSynced, 10_000, 'doc sync')
    const mv = await ed.patch(`/api/projects/${p.id}/files/${ch.id}`, { name: 'intro.tex', parentId: fig.body.id })
    expect(mv.body).toMatchObject({ id: ch.id, name: 'intro.tex', parentId: fig.body.id, epoch: 1 })
    await sleep(100)
    expect(doc.closes).toEqual([])
    doc.text().insert(0, 'still connected ')
    await waitFor(() => !doc.provider.hasUnsyncedChanges, 5_000, 'acked')
    expect((await ed.get(`/api/projects/${p.id}/files/${ch.id}/raw`)).body).toBe('still connected Hello\nworld\n')

    // moving a folder into itself or a descendant
    const sub = (await mk(ed, p, fig.body.id, 'sub', 'folder')).body
    expect((await ed.patch(`/api/projects/${p.id}/files/${fig.body.id}`, { parentId: sub.id })).body.error).toBe('cycle')
    expect((await ed.patch(`/api/projects/${p.id}/files/${fig.body.id}`, { parentId: fig.body.id })).body.error).toBe('cycle')
    expect((await ed.patch(`/api/projects/${p.id}/files/${sub.id}`, { parentId: p.rootId })).status).toBe(200)
    // name taken at destination
    await mk(ed, p, p.rootId, 'intro.tex', 'text')
    expect((await ed.patch(`/api/projects/${p.id}/files/${ch.id}`, { parentId: p.rootId })).body.error).toBe('name-taken')
    expect((await ed.patch(`/api/projects/${p.id}/files/${ch.id}`, { name: 'bad/name' })).status).toBe(400)
    expect((await ed.patch(`/api/projects/${p.id}/files/${ch.id}`, {})).status).toBe(400)
    expect((await ed.patch(`/api/projects/${p.id}/files/${ch.id}`, { parentId: '3f0e8a52-1c1b-4c3e-9d4a-0b9a0d6c1e2f' })).status).toBe(400)
    expect((await ed.patch(`/api/projects/${p.id}/files/3f0e8a52-1c1b-4c3e-9d4a-0b9a0d6c1e2f`, { name: 'x' })).status).toBe(404)
    // the same name is fine when only the case of the node itself changes
    expect((await ed.patch(`/api/projects/${p.id}/files/${ch.id}`, { name: 'Intro.tex' })).status).toBe(200)

    // root protection
    expect((await ed.patch(`/api/projects/${p.id}/files/${p.rootId}`, { name: 'x' })).status).toBe(400)
    expect((await ed.patch(`/api/projects/${p.id}/files/${p.rootId}`, { parentId: fig.body.id })).status).toBe(400)
    expect((await ed.del(`/api/projects/${p.id}/files/${p.rootId}`)).status).toBe(400)
    // a file id from another project is not-found here
    expect((await owner.patch(`/api/projects/${p.id}/files/${other.mainFileId}`, { name: 'x.tex' })).status).toBe(404)
  })

  it('depth (32) and path length (1024) limits, also when moving a subtree', async () => {
    const { owner, p } = await setup(39181)
    let parent = p.rootId
    const ids: string[] = []
    for (let i = 0; i < 32; i++) {
      const r = await mk(owner, p, parent, 'd', 'folder')
      expect(r.status, `level ${i + 1}`).toBe(200)
      parent = r.body.id; ids.push(parent)
    }
    expect((await mk(owner, p, parent, 'too-deep.tex', 'text')).status).toBe(400)
    // moving a 2-level subtree under level 31 would put its leaf at depth 33
    const a = (await mk(owner, p, p.rootId, 'a', 'folder')).body
    await mk(owner, p, a.id, 'b', 'folder')
    expect((await owner.patch(`/api/projects/${p.id}/files/${a.id}`, { parentId: ids[30] })).status).toBe(400)
    expect((await owner.patch(`/api/projects/${p.id}/files/${a.id}`, { parentId: ids[29] })).status).toBe(200)

    const long = 'x'.repeat(255)
    let lp = p.rootId
    for (let i = 0; i < 4; i++) lp = (await mk(owner, p, lp, `${long.slice(0, 254)}${i}`, 'folder')).body.id // 4*255+3 = 1023
    expect((await mk(owner, p, lp, 'y', 'text')).status).toBe(400) // 1025
  })

  it('per-project limits: file count and binary bytes (413 project-too-large)', async () => {
    const { owner, p } = await setup(39182, { limits: { maxFiles: 4, maxBinaryBytes: 3000 } })
    await mk(owner, p, p.rootId, 'a.tex', 'text') // main.tex + a.tex = 2
    expect((await owner.upload(p.id, p.rootId, 'x.bin', new Uint8Array(2000))).status).toBe(200) // 3
    const big = await owner.upload(p.id, p.rootId, 'y.bin', new Uint8Array(1500))
    expect(big.status).toBe(413)
    expect(big.body.error).toBe('project-too-large')
    expect((await owner.upload(p.id, p.rootId, 'y.bin', new Uint8Array(900))).status).toBe(200) // 4 files, 2900 bytes
    expect((await mk(owner, p, p.rootId, 'b.tex', 'text')).body.error).toBe('project-too-large')
    // replacing a binary counts only the difference
    expect((await owner.upload(p.id, p.rootId, 'x.bin', new Uint8Array(2100))).status).toBe(200)
    expect((await owner.upload(p.id, p.rootId, 'x.bin', new Uint8Array(2200))).status).toBe(413)
    // deleting frees capacity
    const x = (await project(owner, p.id)).tree.find(f => f.name === 'x.bin')!
    await owner.del(`/api/projects/${p.id}/files/${x.id}`)
    expect((await mk(owner, p, p.rootId, 'b.tex', 'text')).status).toBe(200)
  })

  it('soft delete is recursive, clears the main file, closes and unloads deleted docs', async () => {
    const { ts, owner, ed, p } = await setup(39183)
    const meta = open(ts.base, owner, metaDocName(p.id))
    const dir = (await mk(owner, p, p.rootId, 'dir', 'folder')).body
    const sub = (await mk(owner, p, dir.id, 'sub', 'folder')).body
    const t1 = (await mk(owner, p, dir.id, 'one.tex', 'text', 'one')).body
    const t2 = (await mk(owner, p, sub.id, 'two.tex', 'text', 'two')).body
    await owner.patch(`/api/projects/${p.id}`, { mainFileId: t1.id })
    const keep = (await mk(owner, p, p.rootId, 'keep.tex', 'text', 'keep')).body

    const d1 = open(ts.base, ed, fileDocName(p.id, t1.id, 1))
    const d2 = open(ts.base, owner, fileDocName(p.id, t2.id, 1))
    const dk = open(ts.base, ed, fileDocName(p.id, keep.id, 1))
    await waitFor(() => [meta, d1, d2, dk].every(c => c.provider.isSynced), 10_000, 'sync')
    d1.text().insert(3, ' edited')
    await waitFor(() => !d1.provider.hasUnsyncedChanges, 5_000, 'acked')

    expect((await ed.del(`/api/projects/${p.id}/files/${dir.id}`)).status).toBe(200)
    await waitFor(() => d1.closes.includes('file-deleted') && d2.closes.includes('file-deleted'), 5_000, 'closed')
    expect(dk.closes).toEqual([])
    const after = await project(owner, p.id)
    expect(after.mainFileId).toBeNull()
    expect(after.tree.map(f => f.name).sort()).toEqual(['', 'keep.tex', 'main.tex'])
    await waitFor(() => meta.events().some(e => e.type === 'project-changed'), 5_000, 'project-changed')
    const rows = ts.lig.db.prepare('SELECT name, deleted_at AS d FROM files WHERE id IN (?, ?, ?, ?)').all(dir.id, sub.id, t1.id, t2.id) as { d: number | null }[]
    expect(rows.every(r => r.d !== null)).toBe(true)
    await waitFor(() => !ts.lig.collab.hocuspocus.documents.has(fileDocName(p.id, t1.id, 1)), 5_000, 'unloaded')
    expect(ts.lig.store.storedText(fileDocName(p.id, t1.id, 1))?.text).toBe('one edited') // compacted, not lost

    const again = open(ts.base, ed, fileDocName(p.id, t1.id, 1))
    await waitFor(() => again.denied() !== null, 5_000, 'denied')
    expect(again.denied()).toBe('not-found')
    expect((await ed.get(`/api/projects/${p.id}/files/${t1.id}/raw`)).status).toBe(404)
    expect((await ed.del(`/api/projects/${p.id}/files/${dir.id}`)).status).toBe(404)
    // the name is free again
    expect((await mk(owner, p, p.rootId, 'dir', 'folder')).status).toBe(200)
    expect(auditEntries(ts.lig.db, 'file-delete')).toEqual([expect.objectContaining({ detail: expect.objectContaining({ count: 4 }) })])
  })
})

describe('uploads', () => {
  it('text vs binary detection: allow-list, BOM, CRLF, invalid UTF-8, > 1 MB', async () => {
    const { owner, p } = await setup(39184)
    const up = (name: string, data: Uint8Array | string) => owner.upload(p.id, p.rootId, name, data)
    const t = await up('refs.bib', '@article{x, title={T}}\n')
    expect(t.body).toMatchObject({ kind: 'text', epoch: 1 })
    const bom = await up('bom.tex', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\r\nworld')]))
    expect(bom.body.kind).toBe('text')
    expect((await owner.get(`/api/projects/${p.id}/files/${bom.body.id}/raw`)).body).toBe('héllo\nworld')
    const bad = await up('bad.tex', Buffer.from([0x61, 0xff, 0xfe, 0x62]))
    expect(bad.body).toMatchObject({ kind: 'binary', size: 4 })
    const huge = await up('huge.tex', Buffer.alloc(1024 * 1024 + 1, 0x61))
    expect(huge.body).toMatchObject({ kind: 'binary', size: 1024 * 1024 + 1 })
    const exact = await up('exact.tex', Buffer.alloc(1024 * 1024, 0x61))
    expect(exact.body.kind).toBe('text')
    const png = await up('fig.png', makePng(4, 4))
    expect(png.body.kind).toBe('binary')
    expect((await up('notes.TXT', 'plain')).body.kind).toBe('text')
    expect((await up('Makefile', 'all:')).body.kind).toBe('binary') // not allow-listed
    expect((await up('a/b.tex', 'x')).status).toBe(400)
    expect((await owner.req('POST', `/api/projects/${p.id}/upload?name=x.tex`, undefined, { raw: 'x' })).status).toBe(400)
  })

  it('size limit (413 too-large) and Content-Length required (411)', async () => {
    const { ts, owner, p } = await setup(39185, { limits: { maxUploadBytes: 1000 } })
    const r = await owner.upload(p.id, p.rootId, 'big.bin', new Uint8Array(1001))
    expect(r.status).toBe(413)
    expect(r.body.error).toBe('too-large')
    expect((await owner.upload(p.id, p.rootId, 'ok.bin', new Uint8Array(1000))).status).toBe(200)
    // chunked body without Content-Length
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${ts.base}/api/projects/${p.id}/upload?parentId=${p.rootId}&name=c.bin`, {
        method: 'POST', headers: { cookie: owner.cookie, origin: 'http://localhost:5173', 'transfer-encoding': 'chunked' },
      }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.write(Buffer.alloc(10)); req.end()
    })
    expect(status).toBe(411)
  })

  it('replace text via minimal diff while another client has the doc open: content, cursors and attribution survive', async () => {
    const { ts, owner, ed, p } = await setup(39186)
    const v1 = 'line one\nline two\nline three\n'
    const f = (await owner.upload(p.id, p.rootId, 'doc.tex', v1)).body
    const b = open(ts.base, ed, fileDocName(p.id, f.id, f.epoch!))
    await waitFor(() => b.provider.isSynced, 10_000, 'sync')
    expect(b.text().toString()).toBe(v1)
    b.text().insert(0, '% bob\n')
    await waitFor(() => !b.provider.hasUnsyncedChanges, 5_000, 'acked')

    // A cursor anchored in an unchanged region ("line three").
    const at = b.text().toString().indexOf('line three')
    const cursor = Y.createRelativePositionFromTypeIndex(b.text(), at + 5)
    const v2 = '﻿line one\r\nline 2\r\nline three\r\nline four\r\n'
    const r = await owner.upload(p.id, p.rootId, 'doc.tex', v2)
    expect(r.status).toBe(200)
    expect(r.body).toEqual(f) // same file, same epoch
    const expected = 'line one\nline 2\nline three\nline four\n'
    await waitFor(() => b.text().toString() === expected, 5_000, 'collaborator converges')
    const abs = Y.createAbsolutePositionFromRelativePosition(cursor, b.doc)!
    expect(abs.index).toBe(expected.indexOf('line three') + 5)
    // the client's later edits still converge with the server
    b.text().insert(b.text().length, '% tail\n')
    await waitFor(() => !b.provider.hasUnsyncedChanges, 5_000, 'acked')
    expect((await owner.get(`/api/projects/${p.id}/files/${f.id}/raw`)).body).toBe(`${expected}% tail\n`)
    // the server-originated edit is logged and attributed to the uploader
    const ownerId = (await me(owner)).id
    ts.lig.store.flush()
    const users = (ts.lig.db.prepare('SELECT DISTINCT user_id AS u FROM doc_updates WHERE doc_name = ?')
      .all(fileDocName(p.id, f.id, 1)) as { u: string | null }[]).map(x => x.u)
    expect(users).toContain(ownerId)
    // the tree did not change (no tree_version bump for a text replace)
    expect((await project(owner, p.id)).treeVersion).toBe(1)
  })

  it('replace text of a doc nobody has open; replace binary; kind mismatch', async () => {
    const { ts, owner, p } = await setup(39187)
    const f = (await owner.upload(p.id, p.rootId, 'data.csv', 'a,b\n1,2\n')).body
    expect((await owner.upload(p.id, p.rootId, 'data.csv', 'a,b\n1,3\n')).body.id).toBe(f.id)
    expect((await owner.get(`/api/projects/${p.id}/files/${f.id}/raw`)).body).toBe('a,b\n1,3\n')
    await waitFor(() => !ts.lig.collab.hocuspocus.documents.has(fileDocName(p.id, f.id, 1)), 5_000, 'unloaded again')
    expect(ts.lig.store.storedText(fileDocName(p.id, f.id, 1))?.text).toBe('a,b\n1,3\n')

    const mm = await owner.upload(p.id, p.rootId, 'data.csv', Buffer.from([0xff, 0x00]))
    expect(mm.status).toBe(409)
    expect(mm.body.error).toBe('kind-mismatch')

    const img1 = (await owner.upload(p.id, p.rootId, 'fig.png', makePng(2, 2))).body
    const tv = (await project(owner, p.id)).treeVersion
    const png2 = makePng(8, 8, [0, 0, 255])
    const img2 = (await owner.upload(p.id, p.rootId, 'fig.png', png2)).body
    expect(img2).toEqual({ ...img1, size: png2.length })
    expect((await project(owner, p.id)).treeVersion).toBe(tv + 1)
    const raw = await owner.req('GET', `/api/projects/${p.id}/files/${img1.id}/raw`)
    expect(Buffer.from(await raw.raw.arrayBuffer()).equals(png2)).toBe(true)
    expect((await owner.upload(p.id, p.rootId, 'fig.png', 'plain text')).status).toBe(200) // .png is never text

    const textMain = await owner.upload(p.id, p.rootId, 'main.tex', Buffer.from([0xc3, 0x28]))
    expect(textMain.body.error).toBe('kind-mismatch')
    await owner.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'folder', kind: 'folder' })
    expect((await owner.upload(p.id, p.rootId, 'folder', 'x')).body.error).toBe('name-taken')
    expect((await owner.upload(p.id, p.rootId, 'FIG.png', makePng(2, 2))).body.error).toBe('name-taken')
    // blobs are content-addressed and recorded
    expect((ts.lig.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n).toBeGreaterThanOrEqual(2)
  })
})

describe('raw download headers', () => {
  it('attachment by default; inline only for png/jpg/gif/webp with ?inline=1; never inline SVG; nosniff + CSP', async () => {
    const { ts, owner, p } = await setup(39188)
    const viewer = await signup(ts.base, 'viewer')
    await addMember(owner, viewer, p.id, 'viewer')
    const png = (await owner.upload(p.id, p.rootId, 'fig.png', makePng(2, 2))).body
    const svg = (await owner.upload(p.id, p.rootId, 'evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).body
    const pdf = (await owner.upload(p.id, p.rootId, 'résumé x%.pdf', Buffer.from('%PDF-1.4'))).body
    const main = p.tree.find(f => f.name === 'main.tex')!
    const get = (id: string, q = '') => viewer.req('GET', `/api/projects/${p.id}/files/${id}/raw${q}`)
    const common = (h: Headers) => {
      expect(h.get('x-content-type-options')).toBe('nosniff')
      expect(h.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    }

    let r = await get(png.id)
    common(r.headers)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="fig.png"/)
    r = await get(png.id, '?inline=1')
    expect(r.headers.get('content-disposition')).toMatch(/^inline; filename="fig.png"/)

    r = await get(svg.id, '?inline=1')
    common(r.headers)
    expect(r.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(r.headers.get('content-type')).toBe('image/svg+xml')

    r = await get(pdf.id, '?inline=1')
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="r_sum_ x_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20x%25.pdf`)

    r = await get(main.id, '?inline=1')
    common(r.headers)
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="main.tex"/)

    expect((await get(p.rootId)).status).toBe(404) // folders have no content
    expect((await get('nope')).status).toBe(404)
  })
})
