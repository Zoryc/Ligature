import { afterEach, describe, expect, it } from 'vitest'
import { fileDocName, type TreeEntry } from '@ligature/shared'
import { etagMatches } from '../src/http/routes/files.ts'
import { connect, waitFor } from './harness.ts'
import { addMember, Client, newProject, openInstance, signup, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'

/** ETag / 304 on text downloads (docs/AUTOCOMPLETE.md, cheap reloads). Ports 39770–39779 only. */

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

async function setup(port: number) {
  const { ts } = await openInstance(port); servers.push(ts)
  const owner = await signup(ts.base, 'owner')
  const p = await newProject(owner)
  return { ts, owner, p }
}

const raw = (c: Client, projectId: string, fileId: string, ifNoneMatch?: string) =>
  c.req('GET', `/api/projects/${projectId}/files/${fileId}/raw`, undefined,
    { headers: ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch } })

describe('raw text ETag', () => {
  it('stable for unchanged text, 304 on match, 200 with body otherwise, changes after an edit', async () => {
    const { ts, owner, p } = await setup(39770)
    const f = (await owner.post<TreeEntry>(`/api/projects/${p.id}/files`,
      { parentId: p.rootId, name: 'ch.tex', kind: 'text', content: 'Hello\n' })).body

    const first = await raw(owner, p.id, f.id)
    expect(first.status).toBe(200)
    expect(first.body).toBe('Hello\n')
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/) // strong, quoted
    expect(first.headers.get('cache-control')).toBe('private, no-cache')
    expect((await raw(owner, p.id, f.id)).headers.get('etag')).toBe(etag)

    // match: exact, weak form, inside a list, and *
    for (const inm of [etag, `W/${etag}`, `"nope", ${etag}`, `"a,b" , W/${etag}`, '*']) {
      const r = await raw(owner, p.id, f.id, inm)
      expect(r.status, inm).toBe(304)
      expect(await r.raw.text(), inm).toBe('')
      expect(r.headers.get('etag')).toBe(etag)
      expect(r.headers.get('cache-control')).toBe('private, no-cache')
    }
    // mismatch: other tags, unquoted, empty
    for (const inm of ['"nope"', etag.slice(1, -1), '', `W/"x", "y"`]) {
      const r = await raw(owner, p.id, f.id, inm)
      expect(r.status, inm).toBe(200)
      expect(r.body).toBe('Hello\n')
    }

    // edit through the collaboration socket (the live doc is what the route serves)
    const doc = connect(ts.base, owner.cookie, fileDocName(p.id, f.id, f.epoch!))
    sockets.push(doc)
    await waitFor(() => doc.provider.isSynced, 10_000, 'doc sync')
    expect((await raw(owner, p.id, f.id, etag)).status).toBe(304) // syncing alone changes nothing
    doc.text().insert(0, 'Edited ')
    await waitFor(() => !doc.provider.hasUnsyncedChanges, 5_000, 'acked')
    const edited = await raw(owner, p.id, f.id, etag)
    expect(edited.status).toBe(200)
    expect(edited.body).toBe('Edited Hello\n')
    const etag2 = edited.headers.get('etag')!
    expect(etag2).not.toBe(etag)
    expect((await raw(owner, p.id, f.id, etag2)).status).toBe(304)

    // replacing the text by upload changes it too
    expect((await owner.upload(p.id, p.rootId, 'ch.tex', 'Replaced\n')).status).toBe(200)
    const replaced = await raw(owner, p.id, f.id, etag2)
    expect(replaced.status).toBe(200)
    expect(replaced.body).toBe('Replaced\n')

    // a rename changes it as well (a 304 would keep the old Content-Disposition filename)
    const before = (await raw(owner, p.id, f.id)).headers.get('etag')!
    expect((await owner.patch(`/api/projects/${p.id}/files/${f.id}`, { name: 'intro.tex' })).status).toBe(200)
    const renamed = await raw(owner, p.id, f.id, before)
    expect(renamed.status).toBe(200)
    expect(renamed.headers.get('content-disposition')).toMatch(/filename="intro.tex"/)
  })

  it('binary files have no ETag and ignore If-None-Match; access control unchanged', async () => {
    const { ts, owner, p } = await setup(39771)
    const png = (await owner.upload(p.id, p.rootId, 'fig.png', makePng(2, 2))).body
    const r = await raw(owner, p.id, png.id, '*')
    expect(r.status).toBe(200)
    expect(r.headers.get('etag')).toBeNull()
    expect(r.headers.get('content-type')).toBe('image/png')

    const main = p.tree.find(e => e.name === 'main.tex')!
    const etag = (await raw(owner, p.id, main.id)).headers.get('etag')!
    const stranger = await signup(ts.base, 'stranger')
    expect((await raw(stranger, p.id, main.id)).status).toBe(404)
    expect((await raw(stranger, p.id, main.id, etag)).status).toBe(404) // never a 304 that leaks existence
    const viewer = await signup(ts.base, 'viewer')
    await addMember(owner, viewer, p.id, 'viewer')
    expect((await raw(viewer, p.id, main.id, etag)).status).toBe(304)
    expect((await raw(new Client(ts.base), p.id, main.id, etag)).status).toBe(401)
  })
})

describe('etagMatches', () => {
  it('weak comparison over a list', () => {
    expect(etagMatches(undefined, '"a"')).toBe(false)
    expect(etagMatches('"a"', '"a"')).toBe(true)
    expect(etagMatches('W/"a"', '"a"')).toBe(true)
    expect(etagMatches('"b",W/"a"', '"a"')).toBe(true)
    expect(etagMatches('  *  ', '"a"')).toBe(true)
    expect(etagMatches('"a,b"', '"a"')).toBe(false) // commas inside a tag are part of it
    expect(etagMatches('a', '"a"')).toBe(false)
    expect(etagMatches('"A"', '"a"')).toBe(false) // opaque tags are case-sensitive
  })
})
