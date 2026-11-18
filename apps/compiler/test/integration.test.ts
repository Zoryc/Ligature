import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { alive, compile, eventually, manifestOf, postJson, putBlob, sha, startTestWorker, syncFiles, type TestWorker } from './harness.ts'

let t: TestWorker
beforeAll(async () => { t = await startTestWorker() })
afterAll(async () => { await t.w.close() })

/** Send a request with the path exactly as given (no URL normalisation). */
function rawStatus(method: string, path: string): Promise<number> {
  const u = new URL(t.base)
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method, path, headers: { 'content-type': 'application/json' } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(method === 'POST' ? '{"manifest":{}}' : undefined)
  })
}

const get = async (path: string) => {
  const r = await fetch(t.base + path)
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') }
}

describe('worker over HTTP (sandbox none, fake latexmk)', () => {
  it('GET /healthz', async () => {
    const r = await get('/healthz')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body.toString())).toEqual({ ok: true, sandbox: 'none' })
  })

  it('sync -> put blobs -> compile -> fetch outputs, then incrementally', async () => {
    const id = randomUUID()
    const files: Record<string, string> = {
      'main.tex': '\\documentclass{article}\\begin{document}\\input{chapters/intro}\\include{chapters/two}\\end{document}',
      'chapters/intro.tex': 'Intro text',
      'chapters/two.tex': 'Chapter two',
      'old.tex': 'to be deleted',
    }
    const manifest = manifestOf(files)
    const s1 = await postJson(t.base, `/projects/${id}/sync`, { manifest })
    expect(s1.status).toBe(200)
    expect([...s1.json.missing].sort()).toEqual([...new Set(Object.values(manifest))].sort())
    for (const [, c] of Object.entries(files)) expect(await putBlob(t.base, sha(c), c)).toBe(204)
    const s2 = await postJson(t.base, `/projects/${id}/sync`, { manifest })
    expect(s2.json).toEqual({ missing: [] })

    const r = await postJson(t.base, `/projects/${id}/compile`, { manifest, mainFile: 'main.tex', engine: 'pdflatex' })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('success')
    expect(r.json.outputs.sort()).toEqual(['output.log', 'output.pdf', 'output.synctex.gz'])
    expect(typeof r.json.durationMs).toBe('number')
    expect(r.json.log).toContain('(./chapters/intro.tex Intro text)')
    expect(r.json.log).toContain('openin_any=p openout_any=p shell_escape=f')
    expect(r.json.log).toContain('engine=-pdf')

    const pdf = await get(`/projects/${id}/output/output.pdf`)
    expect(pdf.status).toBe(200)
    expect(pdf.type).toBe('application/pdf')
    expect(pdf.body.toString()).toContain('%PDF-1.5')
    expect(pdf.body.toString()).toContain('\\include{chapters/two}')
    const log = await get(`/projects/${id}/output/output.log`)
    expect(log.body.toString()).toBe(r.json.log)
    expect((await get(`/projects/${id}/output/output.synctex.gz`)).body[0]).toBe(0x1f)

    // \include{chapters/two} wrote out/chapters/two.aux: the out/ subdirectory was mirrored.
    const proj = join(t.buildsDir, id)
    expect(existsSync(join(proj, 'out', 'chapters', 'two.aux'))).toBe(true)
    const introMtime = statSync(join(proj, 'src', 'chapters', 'intro.tex')).mtimeMs

    // Second build: one file edited, one removed. Only the edited content is uploaded and rewritten.
    await new Promise(res => setTimeout(res, 30))
    const files2: Record<string, string> = { ...files, 'chapters/two.tex': 'Chapter two, revised' }
    delete files2['old.tex']
    const r2 = await compile(t.base, id, files2)
    expect(r2.uploaded).toEqual([sha('Chapter two, revised')])
    expect(r2.json.status).toBe('success')
    expect(existsSync(join(proj, 'src', 'old.tex'))).toBe(false)
    expect(statSync(join(proj, 'src', 'chapters', 'intro.tex')).mtimeMs).toBe(introMtime)
    expect(readFileSync(join(proj, 'src', 'chapters', 'two.tex'), 'utf8')).toBe('Chapter two, revised')

    // The worker's output store is separate from the project dir.
    expect(existsSync(join(t.buildsDir, '.outputs', id, 'output.pdf'))).toBe(true)
  })

  it('xelatex / lualatex flags and a main file in a subfolder', async () => {
    const id = randomUUID()
    const files = { 'main.tex': 'x', 'sub/thesis.tex': 'thesis \\input{part}', 'sub/part.tex': 'p' }
    await syncFiles(t.base, id, files)
    // \input resolves relative to src/ (latexmk's cwd), so sub/part is not found from sub/thesis.tex.
    const r = await postJson(t.base, `/projects/${id}/compile`, { manifest: manifestOf(files), mainFile: 'sub/thesis.tex', engine: 'lualatex' })
    expect(r.json.log).toContain('engine=-pdflua')
    expect(r.json.status).toBe('failure')
    const r2 = await compile(t.base, id, { 'main.tex': 'x' }, { engine: 'xelatex' })
    expect(r2.json.status).toBe('success')
    expect(r2.json.log).toContain('engine=-pdfxe')
  })

  it('failure: no pdf, log returned, stale outputs from the previous build are withdrawn', async () => {
    const id = randomUUID()
    expect((await compile(t.base, id, { 'main.tex': 'ok' })).json.status).toBe('success')
    const r = await compile(t.base, id, { 'main.tex': 'broken\n%FAKE: fail' })
    expect(r.json.status).toBe('failure')
    expect(r.json.outputs).toEqual(['output.log'])
    expect(r.json.log).toContain('! Emergency stop.')
    expect((await get(`/projects/${id}/output/output.pdf`)).status).toBe(404)
  })

  it('failure with a partial pdf reports the fresh pdf', async () => {
    const id = randomUUID()
    const r = await compile(t.base, id, { 'main.tex': 'partial\n%FAKE: failpdf' })
    expect(r.json.status).toBe('failure')
    expect(r.json.outputs).toContain('output.pdf')
  })

  it('missing \\input file is a failure', async () => {
    const r = await compile(t.base, randomUUID(), { 'main.tex': '\\input{nothere}' })
    expect(r.json.status).toBe('failure')
    expect(r.json.log).toContain("File `nothere.tex' not found.")
  })

  it('timeout kills the run and reports status timeout', async () => {
    const id = randomUUID()
    const started = Date.now()
    const r = await compile(t.base, id, { 'main.tex': 'loop\n%FAKE: sleep' }, { timeoutMs: 1500 })
    expect(r.json.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(r.json.log).toContain('timed out after 1500 ms')
    expect(r.json.outputs).not.toContain('output.pdf')
    // No stray processes: the grandchild fake-latexmk started is gone too.
    const grandchild = Number(readFileSync(join(t.buildsDir, id, 'out', 'grandchild.pid'), 'utf8'))
    expect(grandchild).toBeGreaterThan(0)
    expect(await eventually(() => !alive(grandchild), 3000)).toBe(true)
    // The project is usable again right away.
    expect((await compile(t.base, id, { 'main.tex': 'fine now' })).json.status).toBe('success')
  })

  it('a log that is not valid UTF-8 stays within the cap and keeps the pdf', async () => {
    const id = randomUUID()
    const r = await compile(t.base, id, { 'main.tex': 'x\n%FAKE: latin1log 1500000' })
    expect(r.json.status).toBe('success')
    expect(r.json.outputs.sort()).toEqual(['output.log', 'output.pdf'])
    expect(Buffer.byteLength(r.json.log)).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(r.json.log).toContain('END-OF-LATIN1-LOG')
    expect(r.json.log).toContain('�')
    expect((await get(`/projects/${id}/output/output.log`)).body.toString()).toBe(r.json.log)
  })

  it('a main file whose name the shell would expand is refused with an explanation (200 failure)', async () => {
    const id = randomUUID()
    expect((await compile(t.base, id, { 'main.tex': 'ok' })).json.status).toBe('success')
    const files = { 'main.tex': 'ok', '$(touch pwned)`id`.tex': 'evil' }
    const { manifest } = await syncFiles(t.base, id, files)
    const r = await postJson(t.base, `/projects/${id}/compile`, { manifest, mainFile: '$(touch pwned)`id`.tex', engine: 'pdflatex' })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('failure')
    expect(r.json.outputs).toEqual([])
    expect(r.json.log).toMatch(/cannot be compiled because of its name/)
    // nothing ran: src/ still holds the previous build's sources only, and the old pdf is withdrawn
    expect(existsSync(join(t.buildsDir, id, 'src', '$(touch pwned)`id`.tex'))).toBe(false)
    expect((await get(`/projects/${id}/output/output.pdf`)).status).toBe(404)
  })

  it('a missing or non-.tex main file is a failure that says why, not a 400', async () => {
    const id = randomUUID()
    await syncFiles(t.base, id, { 'notes.md': 'x', 'paper.sty': 'y' })
    const manifest = manifestOf({ 'notes.md': 'x', 'paper.sty': 'y' })
    const missing = await postJson(t.base, `/projects/${id}/compile`, { manifest, mainFile: 'main.tex', engine: 'pdflatex' })
    expect(missing.status).toBe(200)
    expect(missing.json).toMatchObject({ status: 'failure', outputs: [] })
    expect(missing.json.log).toMatch(/"main.tex" does not exist in this project/)
    const sty = await postJson(t.base, `/projects/${id}/compile`, { manifest, mainFile: 'paper.sty', engine: 'pdflatex' })
    expect(sty.json.log).toMatch(/is not a \.tex file/)
  })

  it('the source hash cache skips unchanged files but still catches a source modified by a run', async () => {
    const id = randomUUID()
    const files = { 'main.tex': '\\input{a}', 'a.tex': 'original' }
    expect((await compile(t.base, id, files)).json.status).toBe('success')
    const cacheFile = join(t.buildsDir, id, '.src-hashes.json')
    expect(Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).files).sort()).toEqual(['a.tex', 'main.tex'])
    // Same size, different content: only (m|c)time and content differ.
    writeFileSync(join(t.buildsDir, id, 'src', 'a.tex'), 'ORIGINAL')
    const r = await compile(t.base, id, files)
    expect(r.json.log).toContain('(./a.tex original)')
    expect(readFileSync(join(t.buildsDir, id, 'src', 'a.tex'), 'utf8')).toBe('original')
    // A garbage cache file is ignored.
    writeFileSync(cacheFile, '{"files":{"a.tex":[1,2,3,4,"nothex"],"__proto__":[1,1,1,1,"' + 'a'.repeat(64) + '"]}}')
    expect((await compile(t.base, id, files)).json.status).toBe('success')
  })

  it('caps a huge log to the last 2 MB', async () => {
    const r = await compile(t.base, randomUUID(), { 'main.tex': 'x\n%FAKE: biglog 3500000' })
    expect(r.json.status).toBe('success')
    expect(Buffer.byteLength(r.json.log)).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(r.json.log.startsWith('[ligature: log truncated')).toBe(true)
    expect(r.json.log).toContain('END-OF-BIG-LOG')
  })

  it('clean: true wipes out/ first', async () => {
    const id = randomUUID()
    await compile(t.base, id, { 'main.tex': 'a' })
    const marker = join(t.buildsDir, id, 'out', 'marker.aux')
    writeFileSync(marker, 'x')
    await compile(t.base, id, { 'main.tex': 'a' })
    expect(existsSync(marker)).toBe(true)
    await compile(t.base, id, { 'main.tex': 'a' }, { clean: true })
    expect(existsSync(marker)).toBe(false)
  })

  it('concurrent compiles of one project are serialised and both succeed', async () => {
    const id = randomUUID()
    // Each run holds an exclusive lock file in out/ for 400 ms; overlapping runs would log OVERLAP and fail.
    const [a, b] = await Promise.all([
      compile(t.base, id, { 'main.tex': 'one\n%FAKE: hold 400' }),
      compile(t.base, id, { 'main.tex': 'two\n%FAKE: hold 400' }),
    ])
    expect(a.json.log).not.toContain('OVERLAP')
    expect(b.json.log).not.toContain('OVERLAP')
    expect(a.json.status).toBe('success')
    expect(b.json.status).toBe('success')
  })

  it('compiles of different projects run in parallel', async () => {
    const started = Date.now()
    const rs = await Promise.all([1, 2, 3].map(() => compile(t.base, randomUUID(), { 'main.tex': 'p\n%FAKE: hold 2000' })))
    for (const r of rs) expect(r.json.status).toBe('success')
    expect(Date.now() - started).toBeLessThan(5500) // serially it would be over 6 s
  })

  it('identical content at several paths', async () => {
    const r = await compile(t.base, randomUUID(), { 'main.tex': '\\input{a}\\input{b/c}', 'a.tex': 'same', 'b/c.tex': 'same' })
    expect(r.json.status).toBe('success')
    expect(r.uploaded.length).toBe(2)
  })
})

describe('invalid input', () => {
  const id = randomUUID()
  const H = sha('content')

  it('bad project ids', async () => {
    for (const bad of ['not-a-uuid', id.toUpperCase(), `${id}x`, `${id.slice(0, -1)}%30`]) {
      expect((await postJson(t.base, `/projects/${bad}/sync`, { manifest: {} })).status).toBe(400)
    }
    // Raw paths (fetch would normalise these): encoded dots are not decoded, so they fail validation.
    expect(await rawStatus('POST', '/projects/%2e%2e/sync')).toBe(400)
    expect(await rawStatus('GET', '/projects/../output/output.pdf')).toBe(400)
    expect(await rawStatus('GET', `/projects/${id}/output/..%2Foutput.pdf`)).toBe(404)
  })

  it('bad hashes, hash mismatch, too large', async () => {
    expect(await putBlob(t.base, 'abc', 'x')).toBe(400)
    expect(await putBlob(t.base, H.toUpperCase(), 'content')).toBe(400)
    expect(await putBlob(t.base, sha('other'), 'content')).toBe(400)
    const r = await fetch(`${t.base}/blobs/${sha('other')}`, { method: 'PUT', body: 'content' })
    expect(await r.json()).toMatchObject({ error: 'hash-mismatch' })
    // mismatch never lands in the cache
    expect((await postJson(t.base, `/projects/${id}/sync`, { manifest: { 'a.tex': sha('other') } })).json.missing).toEqual([sha('other')])
    // a correct upload of an existing blob is still verified
    expect(await putBlob(t.base, H, 'content')).toBe(204)
    expect(await putBlob(t.base, H, 'content')).toBe(204)
    expect(await putBlob(t.base, H, 'tampered')).toBe(400)
  })

  it('path traversal and other bad manifest paths', async () => {
    for (const p of ['../evil.tex', '/etc/passwd', 'a/../../b.tex', 'a\\..\\b.tex', 'C:/x.tex', 'nul\u0000.tex', '', 'a//b.tex']) {
      const r = await postJson(t.base, `/projects/${id}/sync`, { manifest: { [p]: H } })
      expect(r.status, p).toBe(400)
      const c = await postJson(t.base, `/projects/${id}/compile`, { manifest: { [p]: H, 'main.tex': H }, mainFile: 'main.tex', engine: 'pdflatex' })
      expect(c.status, p).toBe(400)
    }
  })

  it('bad compile requests', async () => {
    await putBlob(t.base, H, 'content')
    const ok = { manifest: { 'main.tex': H }, mainFile: 'main.tex', engine: 'pdflatex' }
    const cases: unknown[] = [
      { ...ok, mainFile: '../main.tex' },
      { ...ok, engine: 'luatex' },
      { ...ok, timeoutMs: 5 },
      { ...ok, extra: true },
      [ok],
    ]
    for (const body of cases) expect((await postJson(t.base, `/projects/${id}/compile`, body)).status).toBe(400)
    // An option-looking main file never reaches latexmk; it is answered as an unbuildable main file.
    const dash = await postJson(t.base, `/projects/${id}/compile`, { ...ok, manifest: { '-shell-escape.tex': H }, mainFile: '-shell-escape.tex' })
    expect(dash.status).toBe(200)
    expect(dash.json.status).toBe('failure')
    const missing = await postJson(t.base, `/projects/${id}/compile`, { ...ok, manifest: { 'main.tex': sha('never uploaded') } })
    expect(missing.status).toBe(409)
    expect(missing.json).toEqual({ error: 'missing-blobs', missing: [sha('never uploaded')] })
  })

  it('transport-level errors', async () => {
    const notJson = await fetch(`${t.base}/projects/${id}/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    expect(notJson.status).toBe(400)
    const wrongType = await fetch(`${t.base}/projects/${id}/sync`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    expect(wrongType.status).toBe(415)
    const tooBig = await fetch(`${t.base}/projects/${id}/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: {}, pad: 'x'.repeat(10 * 1024 * 1024) }),
    })
    expect(tooBig.status).toBe(413)
    expect((await fetch(`${t.base}/projects/${id}/sync`)).status).toBe(405)
    expect((await fetch(`${t.base}/healthz`, { method: 'POST' })).status).toBe(405)
    expect((await get('/nope')).status).toBe(404)
  })

  it('unknown output names', async () => {
    for (const name of ['main.tex', 'output.aux', '..%2F..%2Fetc%2Fpasswd', 'output.pdf.tmp']) {
      expect((await get(`/projects/${id}/output/${name}`)).status).toBe(404)
    }
    expect((await get(`/projects/${randomUUID()}/output/output.pdf`)).status).toBe(404)
    expect((await get(`/projects/bad/output/output.pdf`)).status).toBe(400)
  })
})

describe('disk limits and cache eviction', () => {
  it('a build that writes more than the project quota is stopped and its files deleted', async () => {
    const q = await startTestWorker({ env: { PROJECT_DISK_QUOTA_MB: '2' } })
    try {
      const id = randomUUID()
      const out = join(q.buildsDir, id, 'out')
      // Writes 4 MiB and then hangs: only the watch during the run can stop it before the 60 s timeout.
      const started = Date.now()
      const r = await compile(q.base, id, { 'main.tex': 'x\n%FAKE: fillhang 4' }, { timeoutMs: 60_000 })
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(r.json.status).toBe('failure')
      expect(r.json.outputs).not.toContain('output.pdf')
      expect(r.json.log).toMatch(/over the per-project disk quota; the build was stopped and its files were deleted/)
      expect(readdirSync(out).filter(f => f.startsWith('fill-'))).toEqual([])
      // Writing over the quota and exiting at once is caught by the check after the run.
      const r2 = await compile(q.base, id, { 'main.tex': 'x\n%FAKE: fill 3' })
      expect(r2.json.status).toBe('failure')
      expect(r2.json.log).toMatch(/disk quota/)
      expect(readdirSync(out).filter(f => f.startsWith('fill-'))).toEqual([])
      // Within the quota everything is normal.
      expect((await compile(q.base, id, { 'main.tex': 'x\n%FAKE: fill 1' })).json.status).toBe('success')
      // Sources do not count against the quota.
      const big = 'x'.repeat(3 * 1024 * 1024)
      expect((await compile(q.base, randomUUID(), { 'main.tex': 'ok', 'big.dat': big })).json.status).toBe('success')
    } finally {
      await q.w.close()
    }
  })

  it('too many files is over the quota too', async () => {
    const q = await startTestWorker({ env: { PROJECT_MAX_FILES: '30' } })
    try {
      const r = await compile(q.base, randomUUID(), { 'main.tex': 'x\n%FAKE: fill 40' })
      expect(r.json.status).toBe('failure')
      expect(r.json.log).toMatch(/created more than 30 files/)
    } finally {
      await q.w.close()
    }
  })

  it('idle build dirs, their outputs and unused blobs are evicted; the project then rebuilds from scratch', async () => {
    const g = await startTestWorker()
    try {
      const idle = randomUUID()
      const files = { 'main.tex': 'idle project' }
      expect((await compile(g.base, idle, files)).json.status).toBe('success')
      expect(existsSync(join(g.buildsDir, idle))).toBe(true)
      await g.w.service.gc() // the start-up sweep (shared if still running): nothing is old yet
      expect(existsSync(join(g.buildsDir, idle))).toBe(true)
      expect(await g.w.service.blobs.has(sha('idle project'))).toBe(true)

      const report = await g.w.service.gc(Date.now() + 8 * 24 * 3600_000)
      expect(report.buildDirsRemoved).toBe(1)
      expect(report.blobsRemoved).toBe(1)
      expect(existsSync(join(g.buildsDir, idle))).toBe(false)
      expect(existsSync(join(g.buildsDir, '.outputs', idle))).toBe(false)
      expect(await g.w.service.blobs.has(sha('idle project'))).toBe(false)

      const again = await compile(g.base, idle, files)
      expect(again.uploaded).toEqual([sha('idle project')])
      expect(again.json.status).toBe('success')
    } finally {
      await g.w.close()
    }
  })

  it('compiles answer error while the build volume is (nearly) full', async () => {
    const d = await startTestWorker({ env: { BUILDS_MIN_FREE_MB: String(2 ** 40) } })
    try {
      const r = await compile(d.base, randomUUID(), { 'main.tex': 'x' })
      expect(r.status).toBe(200)
      expect(r.json.status).toBe('error')
      expect(r.json.log).toMatch(/build volume has only \d+ MB free/)
    } finally {
      await d.w.close()
    }
  })
})
