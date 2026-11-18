import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { metaDocName, type BuildResult, type CompileRequest, type ProjectDetail, type TreeEntry } from '@ligature/shared'
import { gunzipSynctex, loadBuildSynctex, readBuildRecord } from '../src/compile/builds.ts'
import { NO_MAIN_FILE_MESSAGE } from '../src/compile/orchestrator.ts'
import { detectMainFile, hasDocumentClass } from '../src/files/mainFile.ts'
import { connect, HAS_LATEXMK, startCompiler, waitFor } from './harness.ts'
import { addMember, newProject, openInstance, project, signup, type Client, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

/** Replace the compiler worker with an in-process stub; `hold()` makes compiles wait until released. */
function stubCompiler(ts: TestServer) {
  const calls: CompileRequest[] = []
  let gate: Promise<void> | null = null
  let open: () => void = () => {}
  const c = ts.lig.compiler
  c.sync = async () => ({ missing: [] })
  c.putBlob = async () => {}
  c.compile = async (_projectId, req) => {
    calls.push(req)
    if (gate) await gate
    return { status: 'success', durationMs: 42, outputs: ['output.pdf', 'output.synctex.gz', 'output.log'], log: 'This is pdfTeX, stub\n' }
  }
  c.output = async (_projectId, name) => name === 'output.pdf' ? Buffer.from('%PDF-1.5 stub')
    : name === 'output.synctex.gz' ? gzipSync('SyncTeX Version:1\nInput:1:/build/src/main.tex\n') : null
  return {
    calls,
    hold() { gate = new Promise(r => { open = r }) },
    release() { gate = null; open() },
  }
}

async function setup(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const { ts } = await openInstance(port, opts); servers.push(ts)
  const owner = await signup(ts.base, 'owner', { displayName: 'Olivia Owner' })
  return { ts, owner, stub: stubCompiler(ts) }
}

const compile = (c: Client, p: { id: string }) => c.post<BuildResult>(`/api/projects/${p.id}/compile`)
const mk = async (c: Client, p: ProjectDetail, parentId: string, name: string, kind: 'folder' | 'text', content?: string) =>
  (await c.post<TreeEntry>(`/api/projects/${p.id}/files`, { parentId, name, kind, ...(content !== undefined ? { content } : {}) })).body

describe('build bookkeeping', () => {
  it('BuildResult has diagnostics and startedBy; build.json stores it with the path map; GET builds/latest', async () => {
    const { ts, owner, stub } = await setup(39281)
    const viewer = await signup(ts.base, 'viewer')
    const stranger = await signup(ts.base, 'stranger')
    const p = await newProject(owner)
    await addMember(owner, viewer, p.id, 'viewer')
    expect((await viewer.get(`/api/projects/${p.id}/builds/latest`)).body).toMatchObject({ error: 'no-build' })
    expect((await viewer.get(`/api/projects/${p.id}/builds/latest`)).status).toBe(404)

    const fig = await mk(owner, p, p.rootId, 'figures', 'folder')
    const png = (await owner.upload(p.id, fig.id, 'plot.png', makePng(4, 4))).body
    const r = await compile(owner, p)
    expect(r.status).toBe(200)
    const b = r.body
    expect(Object.keys(b).sort()).toEqual(['buildId', 'diagnostics', 'durationMs', 'hasPdf', 'log', 'snapshot', 'startedBy', 'status'])
    expect(b).toMatchObject({ status: 'success', durationMs: 42, hasPdf: true, diagnostics: [], startedBy: 'Olivia Owner', log: 'This is pdfTeX, stub\n' })
    expect(stub.calls.map(c => c.mainFile)).toEqual(['main.tex'])

    const main = p.tree.find(f => f.name === 'main.tex')!
    const rec = readBuildRecord(ts.lig.orchestrator.outputs, p.id, b.buildId)!
    expect(rec.paths).toEqual({ 'main.tex': main.id, 'figures/plot.png': png.id })
    expect(rec.finishedAt).toBeGreaterThan(0)
    const { paths: _p, finishedAt: _f, ...stored } = rec
    expect(stored).toEqual(b)
    expect(JSON.parse(readFileSync(join(ts.lig.orchestrator.outputs, p.id, b.buildId, 'build.json'), 'utf8')).log).toBe(b.log)

    const latest = await viewer.get<BuildResult>(`/api/projects/${p.id}/builds/latest`)
    expect(latest.status).toBe(200)
    expect(latest.body).toEqual(b)
    expect((await stranger.get(`/api/projects/${p.id}/builds/latest`)).status).toBe(404)
    // the existing output route still works next to /latest
    expect((await viewer.req('GET', `/api/projects/${p.id}/builds/${b.buildId}/output.pdf`)).status).toBe(200)

    const second = (await compile(owner, p)).body
    expect((await viewer.get<BuildResult>(`/api/projects/${p.id}/builds/latest`)).body.buildId).toBe(second.buildId)

    // stage-2 seam: a build's synctex.gz + path map
    const syn = loadBuildSynctex(ts.lig.orchestrator.outputs, p.id, b.buildId)!
    expect(gunzipSynctex(syn.gz)).toMatch(/^SyncTeX Version:1/)
    expect(syn.paths).toEqual(rec.paths)
    expect(loadBuildSynctex(ts.lig.orchestrator.outputs, p.id, '6f9619ff-8b86-4011-b42d-00cf4fc964ff')).toBeNull()
    expect(loadBuildSynctex(ts.lig.orchestrator.outputs, p.id, '../../etc')).toBeNull()
  })

  it('gunzipSynctex refuses more than the limit', () => {
    const gz = gzipSync(Buffer.alloc(2 * 1024 * 1024))
    expect(() => gunzipSynctex(gz, 1024 * 1024)).toThrow(RangeError)
    expect(gunzipSynctex(gz).length).toBe(2 * 1024 * 1024)
  })
})

describe('compile limits', () => {
  it('per-user rate limit: 429 rate-limited after the budget, other users unaffected', async () => {
    const { ts, owner } = await setup(39282, { rateLimits: { compilePerUser: 3 } })
    const ed = await signup(ts.base, 'editor')
    const p = await newProject(owner)
    await addMember(owner, ed, p.id, 'editor')
    for (let i = 0; i < 3; i++) expect((await compile(owner, p)).status).toBe(200)
    const r = await compile(owner, p)
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('rate-limited')
    expect((await compile(ed, p)).status).toBe(200)
  })

  it('the default budget is 30 compiles per 5 minutes', async () => {
    const { ts } = await setup(39283)
    expect(ts.lig.limiters.compile.max).toBe(30)
    expect(ts.lig.limiters.compile.windowMs).toBe(5 * 60 * 1000)
  })

  it('instance queue limit: 503 compiler-busy once maxQueue builds wait; coalescing still applies', async () => {
    const { ts, owner, stub } = await setup(39284, { compileConcurrency: 1, compileQueueLimit: 2 })
    const ps = [await newProject(owner, 'p1'), await newProject(owner, 'p2'), await newProject(owner, 'p3'), await newProject(owner, 'p4')]
    stub.hold()
    const running = compile(owner, ps[0]!)
    await waitFor(() => stub.calls.length === 1, 5_000, 'first build running')
    const queued = [compile(owner, ps[1]!), compile(owner, ps[2]!)]
    await waitFor(() => ts.lig.orchestrator.queueLength === 2, 5_000, 'two waiting')
    const busy = await compile(owner, ps[3]!)
    expect(busy.status).toBe(503)
    expect(busy.body.error).toBe('compiler-busy')
    // a second request for p1 would add a follow-up build: also refused
    expect((await compile(owner, ps[0]!)).body.error).toBe('compiler-busy')
    stub.release()
    expect((await running).status).toBe(200)
    for (const q of queued) expect((await q).status).toBe(200)
    expect(ts.lig.orchestrator.queueLength).toBe(0)
    expect((await compile(owner, ps[3]!)).status).toBe(200)

    // coalescing: requests during a build collapse into one follow-up
    stub.calls.length = 0
    stub.hold()
    const first = compile(owner, ps[0]!)
    await waitFor(() => stub.calls.length === 1, 5_000, 'running')
    const followers = [compile(owner, ps[0]!), compile(owner, ps[0]!), compile(owner, ps[0]!)]
    await waitFor(() => ts.lig.orchestrator.queueLength === 1, 5_000, 'one follow-up')
    stub.release()
    const ids = new Set((await Promise.all(followers)).map(r => r.body.buildId))
    expect(ids.size).toBe(1)
    expect((await first).body.buildId).not.toBe([...ids][0])
    expect(stub.calls.length).toBe(2)
  })

  it('per-user queue share: one user cannot fill the instance queue (503 compiler-busy, refunded); others still queue', async () => {
    const { ts, owner, stub } = await setup(39288, { compileConcurrency: 1, compileQueueLimit: 10, compileQueuePerUser: 2 })
    const other = await signup(ts.base, 'other')
    const ps = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(n => newProject(owner, n)))
    const q = await newProject(other, 'q')
    stub.hold()
    const running = compile(owner, ps[0]!)
    await waitFor(() => stub.calls.length === 1, 5_000, 'first build running')
    const queued = [compile(owner, ps[1]!), compile(owner, ps[2]!)]
    await waitFor(() => ts.lig.orchestrator.queueLength === 2, 5_000, 'two of owner waiting')
    const busy = await compile(owner, ps[3]!)
    expect(busy.status).toBe(503)
    expect(busy.body.error).toBe('compiler-busy')
    // a request that would add a follow-up build counts too
    expect((await compile(owner, ps[0]!)).body.error).toBe('compiler-busy')
    // another user still gets a place in the queue
    const theirs = compile(other, q)
    await waitFor(() => ts.lig.orchestrator.queueLength === 3, 5_000, 'other user queued')
    stub.release()
    for (const r of [running, ...queued, theirs]) expect((await r).status).toBe(200)
    expect(ts.lig.orchestrator.queueLength).toBe(0)
    // the refused request was refunded and the per-user count went back to zero
    expect((await compile(owner, ps[3]!)).status).toBe(200)
  })
})

describe('main-file detection at compile time', () => {
  it('unit: main.tex at the root, else the only root .tex with \\documentclass, else the first by path', () => {
    const doc = '\\documentclass{article}\n'
    expect(detectMainFile([{ path: 'a.tex', text: doc }, { path: 'main.tex', text: 'anything' }])).toBe('main.tex')
    expect(detectMainFile([{ path: 'sub/main.tex', text: doc }, { path: 'paper.tex', text: doc }, { path: 'x.tex', text: 'no' }])).toBe('paper.tex')
    expect(detectMainFile([{ path: 'z.tex', text: doc }, { path: 'b.tex', text: doc }, { path: 'a/q.tex', text: doc }])).toBe('a/q.tex')
    expect(detectMainFile([{ path: 'ch/b.tex', text: doc }, { path: 'ch/a.tex', text: doc }])).toBe('ch/a.tex')
    expect(detectMainFile([{ path: 'notes.txt', text: doc }, { path: 'x.tex', text: '% \\documentclass{article}' }])).toBeNull()
    expect(detectMainFile([])).toBeNull()
    expect(hasDocumentClass('  \\documentclass[a4paper]{article}')).toBe(true)
    expect(hasDocumentClass('x % \\documentclass{article}')).toBe(false)
    expect(hasDocumentClass('\\documentclassx')).toBe(false)
  })

  it('persists the detected file and broadcasts project-changed; none -> failure with a clear log', async () => {
    const { ts, owner, stub } = await setup(39285)
    const p = await newProject(owner)
    const meta = connect(ts.base, owner.cookie, metaDocName(p.id)); sockets.push(meta)
    await waitFor(() => meta.provider.isSynced, 10_000, 'meta')
    const main = p.tree.find(f => f.name === 'main.tex')!
    await owner.del(`/api/projects/${p.id}/files/${main.id}`)
    await waitFor(() => meta.events().some(e => e.type === 'project-changed'), 5_000, 'main cleared')
    const sub = await mk(owner, p, p.rootId, 'sub', 'folder')
    await mk(owner, p, sub.id, 'a.tex', 'text', '\\documentclass{article}')
    const paper = await mk(owner, p, p.rootId, 'paper.tex', 'text', '\\documentclass{article}\n\\begin{document}x\\end{document}')
    await mk(owner, p, p.rootId, 'notes.tex', 'text', 'just notes')
    const before = meta.events().filter(e => e.type === 'project-changed').length
    const r = await compile(owner, p)
    expect(r.body.status).toBe('success')
    expect(stub.calls.at(-1)!.mainFile).toBe('paper.tex')
    expect((await project(owner, p.id)).mainFileId).toBe(paper.id)
    await waitFor(() => meta.events().filter(e => e.type === 'project-changed').length === before + 1, 5_000, 'project-changed')

    // no candidate at all
    const q = await newProject(owner, 'Empty')
    const qmain = q.tree.find(f => f.name === 'main.tex')!
    await owner.del(`/api/projects/${q.id}/files/${qmain.id}`)
    await mk(owner, q, q.rootId, 'notes.tex', 'text', 'no class')
    const n = stub.calls.length
    const f = await compile(owner, q)
    expect(f.status).toBe(200)
    expect(f.body).toMatchObject({ status: 'failure', hasPdf: false, startedBy: 'Olivia Owner' })
    expect(f.body.log).toContain(NO_MAIN_FILE_MESSAGE)
    expect(f.body.diagnostics).toEqual([{ severity: 'error', kind: 'no-main-file', message: NO_MAIN_FILE_MESSAGE }])
    expect(stub.calls.length).toBe(n) // the worker was not asked
    expect((await project(owner, q.id)).mainFileId).toBeNull()
    expect((await owner.get<BuildResult>(`/api/projects/${q.id}/builds/latest`)).body.buildId).toBe(f.body.buildId)
    expect((await owner.req('GET', `/api/projects/${q.id}/builds/${f.body.buildId}/output.log`)).body).toContain(NO_MAIN_FILE_MESSAGE)
  })
})

describe.skipIf(!HAS_LATEXMK)('build bookkeeping with real TeX', () => {
  let compiler: ChildProcess
  let ts: TestServer
  beforeAll(async () => {
    compiler = await startCompiler(39286)
    ;({ ts } = await openInstance(39287, { compilerUrl: 'http://127.0.0.1:39286' }))
  }, 30_000)
  afterAll(async () => {
    await ts?.stop()
    if (compiler && compiler.exitCode === null && compiler.signalCode === null) compiler.kill('SIGKILL')
  })

  it('stores the path map and a loadable synctex for a multi-file project', async () => {
    const alice = await signup(ts.base, 'alice', { displayName: 'Alice A.' })
    const p = await newProject(alice, 'Real')
    const ch = await mk(alice, p, p.rootId, 'chapters', 'folder')
    const intro = await mk(alice, p, ch.id, 'intro.tex', 'text', 'Hello from the intro.\n')
    const main = p.tree.find(f => f.name === 'main.tex')!
    await alice.upload(p.id, p.rootId, 'main.tex', '\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n')
    const r = await compile(alice, p)
    expect(r.status).toBe(200)
    expect(r.body.status, r.body.log.slice(-2000)).toBe('success')
    expect(r.body).toMatchObject({ hasPdf: true, startedBy: 'Alice A.', diagnostics: [] })
    expect((await alice.get<BuildResult>(`/api/projects/${p.id}/builds/latest`)).body).toEqual(r.body)
    const syn = loadBuildSynctex(ts.lig.orchestrator.outputs, p.id, r.body.buildId)!
    expect(syn.paths).toEqual({ 'main.tex': main.id, 'chapters/intro.tex': intro.id })
    const text = gunzipSynctex(syn.gz)
    expect(text).toMatch(/^SyncTeX Version:/)
    expect(text).toMatch(/Input:\d+:.*chapters[\\/]intro\.tex/)
  }, 120_000)
})
