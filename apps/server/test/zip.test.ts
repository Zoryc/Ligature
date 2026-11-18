import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { fileDocName, type ImportResponse, type ProjectDetail, type TreeEntry } from '@ligature/shared'
import { DEFAULT_ZIP_LIMITS } from '../src/zip/reader.ts'
import { exportFileName } from '../src/zip/exporter.ts'
import { connect, waitFor } from './harness.ts'
import { addMember, Client, newProject, openInstance, project, signup, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'
import { craftZip, crcZeros, deflateZeros, S_IFCHR, S_IFLNK, unixMode, type CraftEntry } from './fixtures/zips/craft.ts'

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

const KB = 1024

async function setup(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const { ts } = await openInstance(port, opts); servers.push(ts)
  const owner = await signup(ts.base, 'owner')
  return { ts, owner }
}

const importZip = (c: Client, zip: Uint8Array, name: string | null = 'Imported') =>
  c.req<ImportResponse>('POST', `/api/projects/import${name === null ? '' : `?name=${encodeURIComponent(name)}`}`, undefined,
    { raw: zip as BodyInit, headers: { 'content-type': 'application/zip' } })

async function exportZip(c: Client, projectId: string) {
  const r = await c.req('GET', `/api/projects/${projectId}/export.zip`)
  return { r, bytes: new Uint8Array(await r.raw.arrayBuffer()) }
}

/** path -> bytes of every live file, read back through the raw endpoint. */
async function filesOf(c: Client, p: ProjectDetail): Promise<Map<string, Buffer>> {
  const byId = new Map(p.tree.map(e => [e.id, e]))
  const pathOf = (e: TreeEntry): string => {
    const parent = e.parentId ? byId.get(e.parentId) : undefined
    return parent && parent.parentId !== null ? `${pathOf(parent)}/${e.name}` : e.name
  }
  const out = new Map<string, Buffer>()
  for (const e of p.tree) {
    if (e.kind === 'folder') continue
    const r = await c.req('GET', `/api/projects/${p.id}/files/${e.id}/raw`)
    out.set(pathOf(e), Buffer.from(await r.raw.arrayBuffer()))
  }
  return out
}

const mk = (c: Client, p: ProjectDetail, parentId: string, name: string, kind: 'folder' | 'text', content?: string) =>
  c.post<TreeEntry>(`/api/projects/${p.id}/files`, { parentId, name, kind, ...(content !== undefined ? { content } : {}) }).then(r => r.body)

describe('zip export', () => {
  it('round trip: export -> import gives identical files (live text, binaries, nested folders, UTF-8 names)', async () => {
    const { ts, owner } = await setup(39260)
    const p = await newProject(owner, 'Round trip')
    const ch = await mk(owner, p, p.rootId, 'chapters', 'folder')
    const deep = await mk(owner, p, ch.id, 'deep', 'folder')
    await mk(owner, p, ch.id, 'intro.tex', 'text', 'Intro \u00e9t\u00e9 \u2014 caf\u00e9\n')
    await mk(owner, p, deep.id, 'notes.md', 'text', '# notes\n')
    await mk(owner, p, p.rootId, 'empty.tex', 'text', '')
    const figs = await mk(owner, p, p.rootId, 'figures', 'folder')
    const png = makePng(8, 8)
    expect((await owner.upload(p.id, figs.id, 'plot.png', png)).status).toBe(200)
    const bin = randomBytes(200 * KB)
    expect((await owner.upload(p.id, p.rootId, 'data.bin', bin)).status).toBe(200)
    expect((await owner.upload(p.id, figs.id, 'diagram.eps', '%!PS-Adobe-3.0 EPSF\n'.repeat(100))).status).toBe(200)
    // files streamed in several 1 MiB slices, and a text of exactly one slice
    expect((await owner.upload(p.id, p.rootId, 'big.bin', randomBytes(2.5 * 1024 * KB))).status).toBe(200)
    expect((await owner.upload(p.id, p.rootId, 'scan.png', randomBytes(1024 * KB + 7))).status).toBe(200)
    expect((await owner.upload(p.id, p.rootId, 'big.tex', 'a'.repeat(1024 * KB))).body.kind).toBe('text')
    // a live, not yet compacted edit must be in the export
    const main = p.tree.find(f => f.name === 'main.tex')!
    const live = connect(ts.base, owner.cookie, fileDocName(p.id, main.id, 1)); sockets.push(live)
    await waitFor(() => live.provider.isSynced, 10_000, 'sync')
    live.text().insert(0, '% live edit\n')
    await waitFor(() => !live.provider.hasUnsyncedChanges, 5_000, 'acked')

    const before = await filesOf(owner, await project(owner, p.id))
    expect(before.get('main.tex')!.toString()).toMatch(/^% live edit\n\\documentclass/)

    const { r, bytes } = await exportZip(owner, p.id)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/zip')
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="Round trip.zip"; filename*=UTF-8''Round%20trip.zip`)
    const unzipped = unzipSync(bytes)
    expect(Object.keys(unzipped).sort()).toEqual([...before.keys()].sort())
    for (const [path, data] of before) expect(Buffer.from(unzipped[path]!).equals(data), path).toBe(true)

    const imp = await importZip(owner, bytes, 'Round trip (copy)')
    expect(imp.status, JSON.stringify(imp.body)).toBe(200)
    expect(imp.body.report).toEqual({ skipped: [], detectedMainFile: 'main.tex' })
    const copy = imp.body.project
    expect(copy).toMatchObject({ name: 'Round trip (copy)', role: 'owner', engine: 'pdflatex' })
    expect(copy.tree.find(e => e.id === copy.mainFileId)?.name).toBe('main.tex')
    const after = await filesOf(owner, copy)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, data] of before) expect(after.get(path)!.equals(data), path).toBe(true)
    // classification as for uploads
    const kinds = Object.fromEntries(copy.tree.map(e => [e.name, e.kind]))
    expect(kinds).toMatchObject({ 'main.tex': 'text', 'intro.tex': 'text', 'notes.md': 'text', 'empty.tex': 'text', 'big.tex': 'text',
      'plot.png': 'binary', 'data.bin': 'binary', 'diagram.eps': 'binary', 'big.bin': 'binary', 'scan.png': 'binary',
      chapters: 'folder', deep: 'folder', figures: 'folder' })
    // imported text docs are real Yjs docs seeded by the server
    const intro = copy.tree.find(e => e.name === 'intro.tex')!
    const doc = connect(ts.base, owner.cookie, fileDocName(copy.id, intro.id, intro.epoch!)); sockets.push(doc)
    await waitFor(() => doc.provider.isSynced, 10_000, 'sync imported doc')
    expect(doc.text().toString()).toBe('Intro \u00e9t\u00e9 \u2014 caf\u00e9\n')
    expect((await owner.get('/api/projects')).body.map((x: { name: string }) => x.name).sort()).toEqual(['Round trip', 'Round trip (copy)'])
  })

  it('any member can export; others get 404; the file name is sanitised', async () => {
    const { ts, owner } = await setup(39261)
    const viewer = await signup(ts.base, 'viewer')
    const stranger = await signup(ts.base, 'stranger')
    const p = await newProject(owner, 'My: "Paper"/v2?')
    await addMember(owner, viewer, p.id, 'viewer')
    const v = await exportZip(viewer, p.id)
    expect(v.r.status).toBe(200)
    expect(v.r.headers.get('content-disposition')).toMatch(/^attachment; filename="My_ _Paper__v2_.zip"/)
    expect(Object.keys(unzipSync(v.bytes))).toEqual(['main.tex'])
    expect((await stranger.get(`/api/projects/${p.id}/export.zip`)).status).toBe(404)
    expect((await new Client(ts.base).get(`/api/projects/${p.id}/export.zip`)).status).toBe(401)
    expect(exportFileName('  ..  ')).toBe('project.zip')
    expect(exportFileName('Thèse\u0007')).toBe('Thèse_.zip')
  })
})

describe('zip import', () => {
  it('skips junk, strips the top folder, detects the main file, stores nested zips as files', async () => {
    const { ts, owner } = await setup(39262)
    const inner = craftZip([{ name: 'x.tex', data: 'x' }])
    const zip = craftZip([
      { name: 'thesis/', method: 0 },
      { name: 'thesis/thesis.tex', data: '% main\n\\documentclass{report}\n\\begin{document}\\input{ch/one}\\end{document}\n' },
      { name: 'thesis/thesis.pdf', data: '%PDF-1.5', method: 0 },
      { name: 'thesis/thesis.log', data: 'log' },
      { name: 'thesis/thesis.synctex.gz', data: 'gz', method: 0 },
      { name: 'thesis/ch/one.tex', data: 'Chapter one\r\nwith CRLF\r\n' },
      { name: 'thesis/ch/old.zip', data: inner, method: 0 },
      { name: 'thesis/figures/', method: 0 },
      { name: 'thesis/Thumbs.db', data: 'x' },
      { name: '__MACOSX/thesis/._thesis.tex', data: 'x' },
    ])
    const r = await importZip(owner, zip, '  My thesis  ')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const { project: p, report } = r.body
    expect(p.name).toBe('My thesis')
    expect(report.detectedMainFile).toBe('thesis.tex')
    expect(report.skipped.map(s => s.path).sort()).toEqual([
      '__MACOSX/thesis/._thesis.tex', 'thesis/Thumbs.db', 'thesis/figures/', 'thesis/thesis.log', 'thesis/thesis.pdf', 'thesis/thesis.synctex.gz',
    ])
    expect(p.tree.find(e => e.id === p.mainFileId)?.name).toBe('thesis.tex')
    const files = await filesOf(owner, p)
    expect([...files.keys()].sort()).toEqual(['ch/old.zip', 'ch/one.tex', 'thesis.tex'])
    expect(files.get('ch/one.tex')!.toString()).toBe('Chapter one\nwith CRLF\n')
    expect(files.get('ch/old.zip')!.equals(inner)).toBe(true)
    expect(p.tree.find(e => e.name === 'old.zip')?.kind).toBe('binary')
    // the imported project compiles-ready: a viewer cannot be added implicitly, owner is the caller
    expect((await owner.get(`/api/projects/${p.id}/members`)).body).toEqual([expect.objectContaining({ username: 'owner', role: 'owner' })])
    void ts
  })

  it('no main file candidate -> detectedMainFile null; main.tex at the root wins', async () => {
    const { owner } = await setup(39263)
    const none = await importZip(owner, craftZip([{ name: 'notes.txt', data: 'hi' }, { name: 'a.tex', data: 'no class' }]))
    expect(none.status).toBe(200)
    expect(none.body.report.detectedMainFile).toBeNull()
    expect(none.body.project.mainFileId).toBeNull()
    const two = await importZip(owner, craftZip([
      { name: 'b.tex', data: '\\documentclass{article}' }, { name: 'a.tex', data: '\\documentclass{article}' },
      { name: 'main.tex', data: 'no class here' },
    ]))
    expect(two.body.report.detectedMainFile).toBe('main.tex')
  })

  it('request checks: name, Content-Length, size cap, auth, Origin', async () => {
    const { ts, owner } = await setup(39264)
    const ok = craftZip([{ name: 'main.tex', data: 'x' }])
    expect((await importZip(owner, ok, null)).body.error).toBe('bad-request')
    expect((await importZip(owner, ok, '')).body.error).toBe('bad-request')
    expect((await importZip(owner, ok, 'x'.repeat(121))).body.error).toBe('bad-request')
    expect((await new Client(ts.base).req('POST', '/api/projects/import?name=x', undefined, { raw: ok as BodyInit })).status).toBe(401)
    expect((await owner.req('POST', '/api/projects/import?name=x', undefined, { raw: ok as BodyInit, origin: 'http://evil.example' })).body.error).toBe('bad-origin')
    // declared body over 100 MB: refused before anything is read
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${ts.base}/api/projects/import?name=big`, {
        method: 'POST', headers: { cookie: owner.cookie, origin: 'http://localhost:5173', 'content-length': String(100 * 1024 * 1024 + 1) },
      }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(413)
    expect((await importZip(owner, Buffer.from('this is not a zip file at all'))).body).toMatchObject({ error: 'bad-zip' })
    expect((await owner.get('/api/projects')).body).toEqual([])
  })

  it('project limits apply (413 project-too-large) and a failure leaves nothing behind', async () => {
    const { ts, owner } = await setup(39265, { limits: { maxFiles: 5 } })
    const tooMany = craftZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.tex`, data: `${i}` })))
    expect((await importZip(owner, tooMany)).body.error).toBe('project-too-large')
    // implied folders count too
    const deep = craftZip([{ name: 'a/b/c/d/e.tex', data: 'x' }, { name: 'z.tex', data: 'y' }])
    expect((await importZip(owner, deep)).body.error).toBe('project-too-large')

    // a failure inside the transaction (here: recording a blob) rolls everything back, including the doc
    // states written before it; so does a failure while writing blob files (before the transaction)
    const count = (sql: string) => (ts.lig.db.prepare(sql).get() as { n: number }).n
    const counts = () => ({ projects: count('SELECT COUNT(*) AS n FROM projects'), files: count('SELECT COUNT(*) AS n FROM files'),
      docs: count('SELECT COUNT(*) AS n FROM doc_state'), members: count('SELECT COUNT(*) AS n FROM project_members'),
      blobs: count('SELECT COUNT(*) AS n FROM blobs') })
    const before = counts()
    const zip = () => craftZip([{ name: 'main.tex', data: '\\documentclass{article}' }, { name: 'ch.tex', data: 'x' },
      { name: 'a.bin', data: randomBytes(10) }, { name: 'b.bin', data: randomBytes(10) }])
    const record = ts.lig.blobs.record.bind(ts.lig.blobs)
    let calls = 0
    ts.lig.blobs.record = (hash, size) => { if (++calls === 2) throw new Error('disk full'); record(hash, size) }
    try {
      expect((await importZip(owner, zip())).status).toBe(500)
    } finally { ts.lig.blobs.record = record }
    expect(counts()).toEqual(before)
    const write = ts.lig.blobs.write.bind(ts.lig.blobs)
    calls = 0
    ts.lig.blobs.write = async (data, hash) => { if (++calls === 2) throw new Error('disk full'); return write(data, hash) }
    try {
      expect((await importZip(owner, zip())).status).toBe(500)
    } finally { ts.lig.blobs.write = write }
    expect(counts()).toEqual(before)
    expect((await owner.get('/api/projects')).body).toEqual([])
  })
})

describe('zip import: every hostile-zip rule is refused over HTTP (400 bad-zip naming the entry)', () => {
  const ok: CraftEntry = { name: 'main.tex', data: '\\documentclass{article}' }
  const rand = (n: number) => randomBytes(n)
  const cases: [string, () => Buffer, RegExp][] = [
    ['absolute path', () => craftZip([ok, { name: '/etc/passwd', data: 'x' }]), /"\/etc\/passwd": absolute path/],
    ['..', () => craftZip([ok, { name: 'a/../../../evil.tex', data: 'x' }]), /"a\/..\/..\/..\/evil.tex": path contains '..'/],
    ['backslash', () => craftZip([ok, { name: '..\\evil.tex', data: 'x' }]), /backslash/],
    ['drive letter', () => craftZip([ok, { name: 'C:/evil.tex', data: 'x' }]), /"C:\/evil.tex": name starts with a drive letter/],
    ['NUL', () => craftZip([ok, { name: 'a.tex\u0000.png', data: 'x' }]), /control characters/],
    ['control character', () => craftZip([ok, { name: 'a\u001bb.tex', data: 'x' }]), /control characters/],
    ['invalid segment', () => craftZip([ok, { name: 'a/b|c.tex', data: 'x' }]), /"a\/b\|c.tex": invalid name segment/],
    ['symlink', () => craftZip([ok, { name: 'link.tex', data: '/etc/passwd', externalAttrs: unixMode(S_IFLNK | 0o777) }]), /"link.tex": symbolic links/],
    ['device', () => craftZip([ok, { name: 'tty', method: 0, externalAttrs: unixMode(S_IFCHR | 0o666) }]), /"tty": device, FIFO/],
    ['encrypted', () => craftZip([ok, { name: 'secret.tex', data: 'x', flags: 1 }]), /"secret.tex": encrypted/],
    ['duplicate', () => craftZip([ok, { name: 'main.tex', data: 'again' }]), /"main.tex": duplicate path/],
    ['case-insensitive duplicate', () => craftZip([ok, { name: 'MAIN.TEX', data: 'again' }]), /"MAIN.TEX": duplicate path/],
    ['file vs folder', () => craftZip([ok, { name: 'figs', data: 'x' }, { name: 'figs/a.png', data: 'y' }]), /"figs": a file has the same path as a folder/],
    ['too many entries', () => craftZip(Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.tex`, data: '' }))), /too many entries/],
    ['too deep', () => craftZip([ok, { name: `${'d/'.repeat(32)}x.tex`, data: 'x' }]), /deeper than 32 levels/],
    ['path too long', () => craftZip([ok, { name: `${'abcdefghi/'.repeat(103)}x.tex`, data: 'x' }]), /longer than 1024 characters/],
    ['per-entry size (lying header)', () => craftZip([ok, { name: 'big.bin', data: rand(300 * KB), declaredSize: 1 }]), /"big.bin": larger than 262144 bytes/],
    ['total size', () => craftZip([ok, { name: 'a.bin', data: rand(200 * KB) }, { name: 'b.bin', data: rand(200 * KB) }, { name: 'c.bin', data: rand(200 * KB) }]), /"c.bin": the archive is larger than 524288 bytes/],
    ['ratio', () => craftZip([ok, { name: 'z.bin', compressed: deflateZeros(200 * KB), declaredSize: 200 * KB, crc: crcZeros(200 * KB) }]), /"z.bin": compression ratio above 50:1/],
    ['overlapping entries', () => craftZip([ok, { name: 'b.tex', data: '\\documentclass{article}', sameLocalAs: 0 }]), /"b.tex": overlaps another entry/],
    ['CRC mismatch', () => craftZip([ok, { name: 'c.tex', data: 'x', crc: 42 }]), /"c.tex": CRC-32 mismatch/],
    ['unsupported method', () => craftZip([ok, { name: 'l.tex', data: 'x', method: 14, compressed: Uint8Array.from([1]) }]), /unsupported compression method 14/],
  ]
  it('all cases', async () => {
    const { ts, owner } = await setup(39266, {
      limits: { zip: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 256 * KB, maxTotalBytes: 512 * KB, ratioThreshold: 64 * KB, maxRatio: 50 } },
    })
    for (const [what, make, re] of cases) {
      const r = await importZip(owner, make())
      expect(r.status, what).toBe(400)
      expect(r.body.error, what).toBe('bad-zip')
      expect(r.body.message, what).toMatch(re)
    }
    expect((await owner.get('/api/projects')).body, 'nothing was created').toEqual([])
    expect((ts.lig.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0)
  }, 60_000)

  it('a zip bomb with a lying header at the default limits', async () => {
    const { owner } = await setup(39267)
    const n = 512 * 1024 * 1024
    const t = Date.now()
    const r = await importZip(owner, craftZip([{ name: 'main.tex', compressed: deflateZeros(n), declaredSize: 10, crc: 0 }]))
    // ~500 KB of DEFLATE may inflate to 100 MB by the entry's ratio; the 50 MB per-entry limit stops it first
    expect(r.body).toMatchObject({ error: 'bad-zip', message: expect.stringMatching(/"main.tex": larger than 50 MB/) })
    expect(Date.now() - t).toBeLessThan(20_000)
  }, 60_000)
})

/* ------------------------------------------------------------------ resource limits (security review fixes) */

describe('zip resource limits', () => {
  it('the upload byte budget is charged with what an archive extracts to, not only its size', async () => {
    const { ts, owner } = await setup(39290, { rateLimits: { uploadBytesPerUser: 3 * 1024 * KB } })
    // 1 MiB entries (at the ratio threshold, so the ratio limit does not apply) that compress ~1000:1,
    // each different so content-addressed dedup does not help
    const entry = (i: number): CraftEntry => ({ name: `f${i}.bin`, data: Buffer.concat([randomBytes(16), Buffer.alloc(1024 * KB - 16)]) })
    const amplified = craftZip([0, 1, 2, 3].map(entry))
    expect(amplified.length).toBeLessThan(64 * KB)
    const r = await importZip(owner, amplified)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('rate-limited')
    expect((await owner.get('/api/projects')).body).toEqual([])
    expect((ts.lig.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n).toBe(0) // refused before writing

    const ok = await importZip(owner, craftZip([0, 1].map(entry)))
    expect(ok.status).toBe(200)
    // the 2 MiB it extracted to were charged: less than 1 MiB of budget is left
    expect((await owner.upload(ok.body.project.id, ok.body.project.rootId, 'more.bin', randomBytes(1024 * KB))).body.error).toBe('rate-limited')
  })

  it('a large import does not block the event loop', async () => {
    const { owner } = await setup(39291)
    const n = 150
    const zip = craftZip(Array.from({ length: n }, (_, i) => ({ name: `f${i}.tex`, data: `% ${i}\n${'x'.repeat(1_000_000 - 16)}` })))
    let maxGap = 0
    let last = performance.now()
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now }, 5)
    try {
      const r = await importZip(owner, zip)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.project.tree.filter(e => e.kind === 'text')).toHaveLength(n)
    } finally { clearInterval(timer) }
    // all in one synchronous transaction this took well over a second
    expect(maxGap).toBeLessThan(750)
  }, 60_000)

  it('exports stream behind a per-user gate; a client that stops reading is cut off and frees its slot', async () => {
    const { ts, owner } = await setup(39292, { rateLimits: { exportIdleMs: 1_500 } })
    const viewer = await signup(ts.base, 'viewer')
    const p = await newProject(owner, 'Big')
    await addMember(owner, viewer, p.id, 'viewer')
    // 32 MB (stored, not deflated): more than the socket buffers hold, so a client that does not read stalls it
    for (let i = 0; i < 4; i++) expect((await owner.upload(p.id, p.rootId, `r${i}.png`, randomBytes(8 * 1024 * KB))).status).toBe(200)
    const names = ['main.tex', 'r0.png', 'r1.png', 'r2.png', 'r3.png']
    const gate = ts.lig.limiters.exportGate

    // a client that reads the headers, then nothing
    const stalled = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request(`${ts.base}/api/projects/${p.id}/export.zip`, { headers: { cookie: owner.cookie } }, res => { res.pause(); resolve(res) })
      req.on('error', reject)
      req.end()
      sockets.push(req)
    })
    expect(stalled.statusCode).toBe(200)
    stalled.on('error', () => {})
    expect(gate.stats).toEqual({ active: 1, waiting: 0 })

    // the same user's next export waits for a slot; another member's does not
    const second = exportZip(owner, p.id)
    await waitFor(() => gate.stats.waiting === 1, 5_000, 'second export waiting')
    const v = await exportZip(viewer, p.id)
    expect(v.r.status).toBe(200)
    expect(Object.keys(unzipSync(v.bytes)).sort()).toEqual(names)

    // the stalled client is cut off after the idle timeout, which frees the slot: the waiting export runs
    const s2 = await second
    expect(s2.r.status).toBe(200)
    expect(Object.keys(unzipSync(s2.bytes)).sort()).toEqual(names)
    await waitFor(() => gate.stats.active === 0 && gate.stats.waiting === 0, 5_000, 'gate free')
    // reading again, the stalled client finds its response cut short
    let got = 0
    stalled.on('data', (d: Buffer) => { got += d.length })
    await new Promise<void>(resolve => { stalled.on('close', () => resolve()); stalled.resume() })
    expect(stalled.complete).toBe(false)
    expect(got).toBeLessThan(32 * 1024 * KB)
  }, 60_000)

  it('import bodies are received outside the processing gate, with a deadline (408)', async () => {
    const { ts, owner } = await setup(39293, {
      rateLimits: { importConcurrency: 1, importBodyGraceMs: 1_500, importBodyMinBytesPerSec: 1024 * 1024 * 1024 },
    })
    const other = await signup(ts.base, 'other')
    const t0 = Date.now()
    // declares 100 kB, sends 2 bytes, then nothing
    const trickle = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(`${ts.base}/api/projects/import?name=slow`, {
        method: 'POST', headers: { cookie: owner.cookie, origin: 'http://localhost:5173', 'content-length': '100000' },
      }, res => { let b = ''; res.on('data', d => { b += d }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })) })
      req.on('error', reject)
      req.write('PK')
      sockets.push(req)
    })
    await waitFor(() => ts.lig.limiters.importBodyGate.stats.active === 1, 5_000, 'trickled body being received')
    // another user's import is processed meanwhile, though only one import is processed at a time
    const ok = await importZip(other, craftZip([{ name: 'main.tex', data: '\\documentclass{article}' }]))
    expect(ok.status).toBe(200)
    expect(Date.now() - t0).toBeLessThan(1_500)
    const r = await trickle
    expect(r.status).toBe(408)
    expect(JSON.parse(r.body)).toMatchObject({ error: 'request-timeout' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400)
    expect(ts.lig.limiters.importBodyGate.stats).toEqual({ active: 0, waiting: 0 })
    expect(ts.lig.limiters.importGate.stats).toEqual({ active: 0, waiting: 0 })
    expect((await owner.get('/api/projects')).body).toEqual([])
  }, 30_000)
})
