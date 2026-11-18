import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { BuildResult, ProjectDetail, SynctexEditResponse, SynctexViewResponse, TreeEntry } from '@ligature/shared'
import { buildDir, writeBuildRecord, type BuildRecord } from '../src/compile/builds.ts'
import { SynctexCache } from '../src/compile/synctex.ts'
import { ApiError } from '../src/errors.ts'
import { addMember, newProject, openInstance, signup, type Client, type TestServer } from './inproc.ts'

/*
 * A hand-written SyncTeX file. `Unit:65781.76` makes one raw unit one PDF point, so the numbers read as PDF
 * coordinates (origin top-left). Page 1: main.tex:5 at baseline 100, intro.tex:9 at 112, a line typeset from
 * article.cls at 200, a line from a src file that is NOT in the build's path map at 300, and one from the
 * out dir's .aux at 400. Page 2: intro.tex:20 at baseline 100.
 */
function synthetic(root: string): string {
  return `SyncTeX Version:1
Input:1:${root}/./main.tex
Input:2:${root}/chapters/intro.tex
Input:3:/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Input:4:${root}/../out/output.aux
Input:5:${root}/stray.tex
Output:pdf
Magnification:1000
Unit:65781.76
X Offset:0
Y Offset:0
Content:
!100
{1
[1,30:72,720:468,648,0
(1,5:72,100:468,8,2
x1,5:72,100
g1,5:200,100
x1,5:250,100
)
(2,9:72,112:468,8,2
x2,9:72,112
g2,9:100,112
x2,9:300,112
)
(3,40:72,200:468,8,2
x3,40:72,200
g3,40:300,200
)
(5,2:72,300:468,8,2
x5,2:72,300
g5,2:300,300
)
(4,1:72,400:468,8,2
x4,1:72,400
g4,1:300,400
)
]
}1
{2
[1,30:72,720:468,648,0
(2,20:72,100:468,8,2
x2,20:72,100
g2,20:100,100
)
]
}2
Postamble:
Count:30
Post scriptum:
`
}

const MAIN = '11111111-1111-4111-8111-111111111111'
const INTRO = '22222222-2222-4222-8222-222222222222'

function record(buildId: string, paths: Record<string, string>): BuildRecord {
  return {
    buildId, status: 'success', durationMs: 1, log: '', hasPdf: true, diagnostics: [], startedBy: 'x',
    snapshot: { treeVersion: 1, docs: {}, docSnapshots: {} }, paths, finishedAt: 1,
  }
}

/** Store a build with the given synctex payload (`null`: no synctex file) and return its id. */
function storeBuild(outputs: string, projectId: string, gz: Buffer | null, paths: Record<string, string> = { 'main.tex': MAIN, 'chapters/intro.tex': INTRO }): string {
  const buildId = randomUUID()
  writeBuildRecord(outputs, projectId, record(buildId, paths))
  if (gz) writeFileSync(join(buildDir(outputs, projectId, buildId), 'output.synctex.gz'), gz)
  return buildId
}

const status = async (f: () => Promise<unknown>): Promise<number | null> => {
  try { await f(); return null } catch (e) { return e instanceof ApiError ? e.status : -1 }
}

const caches: SynctexCache[] = []
const mkCache = (...args: ConstructorParameters<typeof SynctexCache>) => { const c = new SynctexCache(...args); caches.push(c); return c }
afterEach(async () => { for (const c of caches.splice(0)) await c.close() })

describe('SynctexCache', () => {
  const outputs = () => mkdtempSync(join(tmpdir(), 'ligature-synctex-'))

  it('forward search maps a file id to boxes on the right page', async () => {
    const out = outputs(); const pid = randomUUID()
    const b = storeBuild(out, pid, gzipSync(synthetic(`/srv/b/${pid}/src`)))
    const cache = mkCache(out)
    const [box, ...rest] = await cache.view(pid, b, { fileId: MAIN, line: 5 })
    expect(rest).toEqual([])
    expect(box!.page).toBe(1)
    expect(box!.y).toBeLessThanOrEqual(100)
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(100)
    expect((await cache.view(pid, b, { fileId: INTRO, line: 20 }))[0]!.page).toBe(2)
    expect((await cache.view(pid, b, { fileId: INTRO, line: 9, column: 3 }))[0]!.page).toBe(1)
    // a file that is not part of this build
    expect(await cache.view(pid, b, { fileId: randomUUID(), line: 1 })).toEqual([])
  })

  it('inverse search returns project files only, falling back to the nearest project record', async () => {
    const out = outputs(); const pid = randomUUID()
    const b = storeBuild(out, pid, gzipSync(synthetic(`C:\\Builds\\${pid}\\src`)))
    const cache = mkCache(out)
    expect(await cache.edit(pid, b, { page: 1, x: 100, y: 98 })).toEqual({ fileId: MAIN, path: 'main.tex', line: 5, column: -1 })
    expect(await cache.edit(pid, b, { page: 2, x: 90, y: 99 })).toEqual({ fileId: INTRO, path: 'chapters/intro.tex', line: 20, column: -1 })
    // TeX Live, a src file outside the path map and the out dir are never returned
    for (const y of [198, 298, 398]) {
      const r = (await cache.edit(pid, b, { page: 1, x: 100, y }))!
      expect([MAIN, INTRO]).toContain(r.fileId)
      expect(r.path).not.toMatch(/stray|article|aux/)
    }
    expect(await cache.edit(pid, b, { page: 3, x: 100, y: 100 })).toBeNull()
  })

  it('finds the src root without the project id in the path (voting on the path map)', async () => {
    const out = outputs(); const pid = randomUUID()
    const b = storeBuild(out, pid, gzipSync(synthetic('/build/src')))
    const cache = mkCache(out)
    expect(await cache.edit(pid, b, { page: 1, x: 100, y: 110 })).toMatchObject({ fileId: INTRO, line: 9 })
    expect((await cache.view(pid, b, { fileId: MAIN, line: 5 })).length).toBe(1)
  })

  it('a build whose paths do not map gives no results rather than foreign files', async () => {
    const out = outputs(); const pid = randomUUID()
    const b = storeBuild(out, pid, gzipSync(synthetic('/build/src')), { 'other.tex': MAIN })
    const cache = mkCache(out)
    expect(await cache.edit(pid, b, { page: 1, x: 100, y: 100 })).toBeNull()
    expect(await cache.view(pid, b, { fileId: MAIN, line: 5 })).toEqual([])
  })

  it('404s for missing builds, missing synctex, other projects, and unusable files (remembered)', async () => {
    const out = outputs(); const pid = randomUUID()
    const good = storeBuild(out, pid, gzipSync(synthetic('/build/src')))
    const none = storeBuild(out, pid, null)
    const junk = storeBuild(out, pid, Buffer.from('not gzip'))
    const notSynctex = storeBuild(out, pid, gzipSync('hello'))
    const cache = mkCache(out)
    expect(await status(() => cache.view(pid, randomUUID(), { fileId: MAIN, line: 1 }))).toBe(404)
    expect(await status(() => cache.view(randomUUID(), good, { fileId: MAIN, line: 1 }))).toBe(404)
    expect(await status(() => cache.edit(pid, none, { page: 1, x: 1, y: 1 }))).toBe(404)
    expect(await status(() => cache.edit(pid, junk, { page: 1, x: 1, y: 1 }))).toBe(404)
    expect(await status(() => cache.edit(pid, notSynctex, { page: 1, x: 1, y: 1 }))).toBe(404)
    const parses = cache.parses
    expect(await status(() => cache.edit(pid, junk, { page: 1, x: 1, y: 1 }))).toBe(404)
    expect(cache.parses).toBe(parses) // not re-read
  })

  it('refuses synctex files over the size limit', async () => {
    const out = outputs(); const pid = randomUUID()
    const text = synthetic('/build/src')
    const b = storeBuild(out, pid, gzipSync(text + '%'.repeat(10_000)))
    expect(await status(() => mkCache(out, { maxBytes: 5000 }).view(pid, b, { fileId: MAIN, line: 5 }))).toBe(404)
    expect((await mkCache(out, { maxBytes: 50_000 }).view(pid, b, { fileId: MAIN, line: 5 })).length).toBe(1)
  })

  it('caches parsed builds: LRU by build count', async () => {
    const out = outputs(); const pid = randomUUID()
    const gz = gzipSync(synthetic('/build/src'))
    const ids = [0, 1, 2].map(() => storeBuild(out, pid, gz))
    const cache = mkCache(out, { maxBuilds: 2 })
    const q = { fileId: MAIN, line: 5 }
    await cache.view(pid, ids[0]!, q); await cache.view(pid, ids[1]!, q); await cache.view(pid, ids[0]!, q)
    expect(cache.parses).toBe(2)
    await cache.view(pid, ids[2]!, q) // evicts ids[1], the least recently used
    expect(cache.cached).toEqual([`${pid}/${ids[0]}`, `${pid}/${ids[2]}`])
    await cache.view(pid, ids[0]!, q)
    expect(cache.parses).toBe(3)
    await cache.view(pid, ids[1]!, q)
    expect(cache.parses).toBe(4)
  })

  it('caches parsed builds: bounded by total records, always keeping the newest', async () => {
    const out = outputs(); const pid = randomUUID()
    const gz = gzipSync(synthetic('/build/src'))
    const ids = [0, 1, 2].map(() => storeBuild(out, pid, gz))
    const q = { fileId: MAIN, line: 5 }
    const one = mkCache(out)
    await one.view(pid, ids[0]!, q)
    const per = one.cachedRecords
    expect(per).toBeGreaterThan(10)
    const cache = mkCache(out, { maxRecords: per * 2 })
    for (const id of ids) await cache.view(pid, id, q)
    expect(cache.cached).toEqual([`${pid}/${ids[1]}`, `${pid}/${ids[2]}`])
    expect(cache.cachedRecords).toBe(per * 2)
    const tiny = mkCache(out, { maxRecords: 1, maxRecordsPerBuild: 1000 })
    for (const id of ids) expect((await tiny.view(pid, id, q)).length).toBe(1)
    expect(tiny.cached).toEqual([`${pid}/${ids[2]}`])
  })

  it('by default a build holds at most half the record budget: alternating between two builds never re-parses', async () => {
    const out = outputs(); const pid = randomUUID()
    const gz = gzipSync(synthetic('/build/src'))
    const [a, b] = [storeBuild(out, pid, gz), storeBuild(out, pid, gz)]
    const per = await (async () => { const one = mkCache(out); await one.view(pid, a, { fileId: MAIN, line: 5 }); return one.cachedRecords })()
    // a budget one full build would fill: each build is cut to half of it, so both stay cached
    const cache = mkCache(out, { maxRecords: per })
    for (let i = 0; i < 6; i++) await cache.edit(pid, i % 2 ? b : a, { page: 1, x: 100, y: 100 })
    expect(cache.parses).toBe(2)
    expect(cache.cached).toHaveLength(2)
    expect(cache.cachedRecords).toBeLessThanOrEqual(per)
  })

  it('unusable synctex files are remembered outside the LRU: they never evict parsed builds', async () => {
    const out = outputs(); const pid = randomUUID()
    const good = storeBuild(out, pid, gzipSync(synthetic('/build/src')))
    const junk = [0, 1, 2].map(() => storeBuild(out, pid, Buffer.from('not gzip')))
    const cache = mkCache(out, { maxBuilds: 1 })
    expect((await cache.view(pid, good, { fileId: MAIN, line: 5 })).length).toBe(1)
    for (const j of junk) expect(await status(() => cache.view(pid, j, { fileId: MAIN, line: 5 }))).toBe(404)
    expect(cache.cached).toEqual([`${pid}/${good}`])
    expect(cache.parses).toBe(4)
    for (const j of junk) expect(await status(() => cache.edit(pid, j, { page: 1, x: 1, y: 1 }))).toBe(404)
    await cache.view(pid, good, { fileId: MAIN, line: 5 })
    expect(cache.parses).toBe(4)
  })

  it('concurrent queries share one parse; a miss is admitted once; too many parses at once is 503 synctex-busy', async () => {
    const out = outputs(); const pid = randomUUID()
    const gz = gzipSync(synthetic('/build/src'))
    const [a, b, c] = [storeBuild(out, pid, gz), storeBuild(out, pid, gz), storeBuild(out, pid, gz)]
    const cache = mkCache(out, { maxPendingParses: 1 })
    let admitted = 0
    const admit = { admit: () => { admitted++ } }
    const q = { fileId: MAIN, line: 5 }
    const both = await Promise.all([cache.view(pid, a, q, admit), cache.view(pid, a, q, admit), cache.edit(pid, a, { page: 1, x: 100, y: 100 }, admit)])
    expect(both[0]).toEqual(both[1])
    expect(cache.parses).toBe(1)
    expect(admitted).toBe(1)
    await cache.view(pid, a, q, admit) // cached: not admitted again
    expect(admitted).toBe(1)
    // a refused admission parses nothing
    const refuse = { admit: () => { throw new ApiError(429, 'rate-limited') } }
    expect(await status(() => cache.view(pid, b, q, refuse))).toBe(429)
    expect(cache.parses).toBe(1)
    // one parse in progress is the limit here: a second build is refused meanwhile
    const pending = cache.view(pid, b, q)
    let busy: unknown
    try { await cache.view(pid, c, q) } catch (e) { busy = e }
    expect(busy).toMatchObject({ status: 503, code: 'synctex-busy' })
    expect((await pending).length).toBe(1)
    expect((await cache.view(pid, c, q)).length).toBe(1)
  })

  it('parses in a worker thread: a large synctex file does not block the event loop', async () => {
    const out = outputs(); const pid = randomUUID()
    // ~1.5M records (~24 MB of text): parsing it on the main thread takes several hundred ms
    const lines: string[] = []
    for (let i = 0; i < 500_000; i++) lines.push(`(1,${i % 50 + 1}:72,${100 + (i % 600)}:468,8,2`, `x1,5:72,100`, `g1,5:200,100`, ')')
    const text = synthetic('/build/src').replace('Content:\n', `Content:\n!100\n{9\n${lines.join('\n')}\n}9\n`)
    const b = storeBuild(out, pid, gzipSync(text, { level: 1 }))
    const cache = mkCache(out)
    let maxGap = 0
    let last = performance.now()
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now }, 2)
    try {
      expect((await cache.view(pid, b, { fileId: MAIN, line: 5 })).length).toBeGreaterThan(0)
    } finally { clearInterval(timer) }
    expect(cache.cachedRecords).toBeGreaterThan(1_400_000)
    expect(maxGap).toBeLessThan(150)
  }, 30_000)
})

/* ------------------------------------------------------------------ routes (stub compiler) */

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.stop() })

/** Stub worker: every compile "succeeds" with the synthetic synctex (paths under /build/src). */
function stubCompiler(ts: TestServer, opts: { synctex: boolean } = { synctex: true }) {
  const c = ts.lig.compiler
  c.sync = async () => ({ missing: [] })
  c.putBlob = async () => {}
  c.compile = async () => ({ status: 'success', durationMs: 1, outputs: opts.synctex ? ['output.pdf', 'output.synctex.gz'] : ['output.pdf'], log: 'stub\n' })
  c.output = async (_p, name) => name === 'output.pdf' ? Buffer.from('%PDF-1.5 stub')
    : name === 'output.synctex.gz' && opts.synctex ? gzipSync(synthetic('/build/src')) : null
}

const mk = async (c: Client, p: ProjectDetail, parentId: string, name: string, kind: 'folder' | 'text', content?: string) =>
  (await c.post<TreeEntry>(`/api/projects/${p.id}/files`, { parentId, name, kind, ...(content !== undefined ? { content } : {}) })).body

describe('SyncTeX routes', () => {
  it('view/edit for members, with validation and project scoping', async () => {
    const { ts } = await openInstance(39210); servers.push(ts)
    stubCompiler(ts)
    const owner = await signup(ts.base, 'owner')
    const viewer = await signup(ts.base, 'viewer')
    const stranger = await signup(ts.base, 'stranger')
    const p = await newProject(owner)
    await addMember(owner, viewer, p.id, 'viewer')
    const ch = await mk(owner, p, p.rootId, 'chapters', 'folder')
    const intro = await mk(owner, p, ch.id, 'intro.tex', 'text', 'x\n')
    const main = p.tree.find(f => f.name === 'main.tex')!
    const b = (await owner.post<BuildResult>(`/api/projects/${p.id}/compile`)).body
    const base = `/api/projects/${p.id}/builds/${b.buildId}/synctex`

    const v = await viewer.get<SynctexViewResponse>(`${base}/view?fileId=${main.id}&line=5`)
    expect(v.status).toBe(200)
    expect(v.body.boxes).toHaveLength(1)
    expect(v.body.boxes[0]).toMatchObject({ page: 1 })
    expect(v.headers.get('cache-control')).toContain('private')
    expect((await viewer.get(`${base}/view?fileId=${intro.id}&line=20&column=0`)).body.boxes[0].page).toBe(2)
    expect((await viewer.get(`${base}/view?fileId=${intro.id}&line=20&column=-1`)).status).toBe(200)
    // a file of the project that was not in the build, and a random id
    expect((await viewer.get(`${base}/view?fileId=${ch.id}&line=1`)).body).toEqual({ boxes: [] })

    const e = await viewer.get<SynctexEditResponse>(`${base}/edit?page=1&x=100.5&y=110`)
    expect(e.status).toBe(200)
    expect(e.body).toEqual({ fileId: intro.id, path: 'chapters/intro.tex', line: 9, column: -1 })
    expect((await viewer.get(`${base}/edit?page=1&x=-3&y=0`)).body.fileId).toBe(main.id)
    const miss = await viewer.get(`${base}/edit?page=9&x=1&y=1`)
    expect(miss.status).toBe(404)
    expect(miss.body.error).toBe('not-found')

    // validation
    for (const q of ['', 'fileId=x&line=1', `fileId=${main.id}`, `fileId=${main.id}&line=0`, `fileId=${main.id}&line=1.5`,
      `fileId=${main.id}&line=abc`, `fileId=${main.id}&line=1e3`, `fileId=${main.id}&line=99999999999`, `fileId=${main.id}&line=1&column=x`,
      `fileId=${main.id}&line=1&column=-2`]) {
      const r = await viewer.get(`${base}/view?${q}`)
      expect(r.status, q).toBe(400)
      expect(r.body.error).toBe('bad-request')
    }
    for (const q of ['', 'page=1&x=1', 'page=0&x=1&y=1', 'page=1.5&x=1&y=1', 'page=1&x=NaN&y=1', 'page=1&x=Infinity&y=1',
      'page=1&x=1e5&y=1', 'page=1&x=0x10&y=1', 'page=1&x=1&y=2000000', 'page=-1&x=1&y=1']) {
      const r = await viewer.get(`${base}/edit?${q}`)
      expect(r.status, q).toBe(400)
    }

    // access: strangers and anonymous users, other projects' builds, unknown builds
    expect((await stranger.get(`${base}/view?fileId=${main.id}&line=5`)).status).toBe(404)
    expect((await stranger.get(`${base}/edit?page=1&x=1&y=1`)).status).toBe(404)
    const anon = await fetch(`${ts.base}${base}/edit?page=1&x=1&y=1`)
    expect(anon.status).toBe(401)
    const q = await newProject(stranger, 'Other')
    expect((await stranger.get(`/api/projects/${q.id}/builds/${b.buildId}/synctex/edit?page=1&x=1&y=1`)).status).toBe(404)
    expect((await owner.get(`/api/projects/${p.id}/builds/${crypto.randomUUID()}/synctex/edit?page=1&x=1&y=1`)).status).toBe(404)
    expect((await owner.get(`/api/projects/${p.id}/builds/not-a-uuid/synctex/edit?page=1&x=1&y=1`)).status).toBe(404)
    expect((await owner.get(`/api/projects/not-a-uuid/builds/${b.buildId}/synctex/edit?page=1&x=1&y=1`)).status).toBe(404)
    // a non-member is told 404 before any query validation
    expect((await stranger.get(`${base}/edit?page=zz`)).status).toBe(404)
  })

  it('404 when the build has no synctex output', async () => {
    const { ts } = await openInstance(39211); servers.push(ts)
    stubCompiler(ts, { synctex: false })
    const owner = await signup(ts.base, 'owner')
    const p = await newProject(owner)
    const b = (await owner.post<BuildResult>(`/api/projects/${p.id}/compile`)).body
    const main = p.tree.find(f => f.name === 'main.tex')!
    const r = await owner.get(`/api/projects/${p.id}/builds/${b.buildId}/synctex/view?fileId=${main.id}&line=1`)
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('not-found')
  })

  it('cache misses count against a per-user parse budget (429); cached builds and other users are unaffected', async () => {
    const { ts } = await openInstance(39289, { rateLimits: { synctexParsesPerUser: 1 } }); servers.push(ts)
    stubCompiler(ts)
    const owner = await signup(ts.base, 'owner')
    const viewer = await signup(ts.base, 'viewer')
    const p = await newProject(owner)
    await addMember(owner, viewer, p.id, 'viewer')
    const b1 = (await owner.post<BuildResult>(`/api/projects/${p.id}/compile`)).body.buildId
    const b2 = (await owner.post<BuildResult>(`/api/projects/${p.id}/compile`)).body.buildId
    const edit = (c: Client, b: string) => c.get(`/api/projects/${p.id}/builds/${b}/synctex/edit?page=1&x=100&y=100`)
    expect((await edit(owner, b1)).status).toBe(200)
    expect((await edit(owner, b1)).status).toBe(200) // cached
    const limited = await edit(owner, b2)
    expect(limited.status).toBe(429)
    expect(limited.body.error).toBe('rate-limited')
    expect((await edit(viewer, b2)).status).toBe(200)
    expect((await edit(owner, b2)).status).toBe(200) // now cached
    expect(ts.lig.orchestrator.synctex.parses).toBe(2)
  })
})
