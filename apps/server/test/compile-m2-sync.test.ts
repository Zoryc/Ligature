import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BuildResult, Diagnostic, ProjectDetail, SynctexEditResponse, SynctexViewResponse, TreeEntry } from '@ligature/shared'
import { HAS_LATEXMK, startCompiler } from './harness.ts'
import { addMember, newProject, openInstance, signup, type Client, type TestServer } from './inproc.ts'

/*
 * docs/M2.md §2–§3 against a real compile (real compiler worker + TeX on PATH): diagnostics mapped to the
 * right file and line in a subfolder, forward search to the right page, inverse search back to the line.
 */

const MAIN = [
  '\\documentclass{article}', //    1
  '\\begin{document}', //           2
  '\\section{Start}', //            3
  'First page text, in the main file.', // 4
  '\\newpage', //                   5
  '\\input{chapters/body}', //      6
  '\\end{document}', //             7
].join('\n') + '\n'

const BODY = [
  '\\section{Body}', //                                                          1
  'This is the first paragraph of the body, which is set on page two.', //      2
  '', //                                                                         3
  'Second paragraph of the body: this is the forward search target line.', //  4
  'It continues on this source line with some more words.', //                  5
  '', //                                                                         6
  'Third paragraph.', //                                                         7
  '', //                                                                         8
  '\\input{chapters/sections/bad}', //                                           9
].join('\n') + '\n'

const BAD = [
  'A line in a nested file.', //               1
  '', //                                        2
  'Here is \\undefinedmacro{} a problem.', //   3
  'See \\ref{nowhere}.', //                     4
].join('\n') + '\n'

const FIXED = 'A line in a nested file.\n\nNo problem here any more.\n'

const mk = async (c: Client, p: ProjectDetail, parentId: string, name: string, kind: 'folder' | 'text', content?: string) => {
  const r = await c.post<TreeEntry>(`/api/projects/${p.id}/files`, { parentId, name, kind, ...(content !== undefined ? { content } : {}) })
  if (r.status !== 200) throw new Error(`create ${name}: ${r.status}`)
  return r.body
}

describe.skipIf(!HAS_LATEXMK)('diagnostics and SyncTeX against a real build', () => {
  let compiler: ChildProcess
  let ts: TestServer
  beforeAll(async () => {
    compiler = await startCompiler(39212)
    ;({ ts } = await openInstance(39213, { compilerUrl: 'http://127.0.0.1:39212' }))
  }, 30_000)
  afterAll(async () => {
    await ts?.stop()
    if (compiler && compiler.exitCode === null && compiler.signalCode === null) compiler.kill('SIGKILL')
  })

  async function setupProject(owner: Client, name: string) {
    const p = await newProject(owner, name)
    const main = p.tree.find(f => f.name === 'main.tex')!
    const up = await owner.upload(p.id, p.rootId, 'main.tex', MAIN)
    expect(up.status).toBe(200)
    const chapters = await mk(owner, p, p.rootId, 'chapters', 'folder')
    const sections = await mk(owner, p, chapters.id, 'sections', 'folder')
    const body = await mk(owner, p, chapters.id, 'body.tex', 'text', BODY)
    const bad = await mk(owner, p, sections.id, 'bad.tex', 'text', BAD)
    return { p, main, body, bad, sections }
  }

  const compile = async (c: Client, p: ProjectDetail) => {
    const r = await c.post<BuildResult>(`/api/projects/${p.id}/compile`)
    expect(r.status).toBe(200)
    return r.body
  }

  /** Forward search, then inverse search at the centre of the first box. */
  async function roundTrip(c: Client, p: ProjectDetail, buildId: string, fileId: string, line: number, page: number) {
    const base = `/api/projects/${p.id}/builds/${buildId}/synctex`
    const v = await c.get<SynctexViewResponse>(`${base}/view?fileId=${fileId}&line=${line}`)
    expect(v.status).toBe(200)
    expect(v.body.boxes.length).toBeGreaterThan(0)
    for (const b of v.body.boxes) {
      expect(b.page).toBe(page)
      expect(b.width).toBeGreaterThan(0)
      expect(b.height).toBeGreaterThan(0)
      // inside an A4/letter page
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(615)
      expect(b.y + b.height).toBeLessThanOrEqual(845)
    }
    // A box is the whole line of text (as with the synctex CLI); click on its first word, past the paragraph
    // indent: the blank right part of a paragraph's last line belongs to the \parfillskip glue, which TeX tags
    // with the place where the paragraph ended (possibly another file).
    const box = v.body.boxes[0]!
    const x = box.x + Math.min(25, box.width / 2)
    const e = await c.get<SynctexEditResponse>(`${base}/edit?page=${box.page}&x=${x.toFixed(2)}&y=${(box.y + box.height / 2).toFixed(2)}`)
    expect(e.status).toBe(200)
    expect(e.body.fileId, JSON.stringify({ boxes: v.body.boxes, edit: e.body })).toBe(fileId)
    expect(Math.abs(e.body.line - line)).toBeLessThanOrEqual(1)
    expect(e.body.column).toBeGreaterThanOrEqual(-1)
    return { boxes: v.body.boxes, edit: e.body }
  }

  it('pdflatex: an error in a subfolder file maps to its file id and line; SyncTeX round-trips', async () => {
    const owner = await signup(ts.base, 'alice')
    const viewer = await signup(ts.base, 'victor')
    const { p, main, body, bad } = await setupProject(owner, 'Real pdflatex')
    await addMember(owner, viewer, p.id, 'viewer')

    // Build 1: the error in chapters/sections/bad.tex
    const b1 = await compile(owner, p)
    expect(b1.status, b1.log.slice(-3000)).not.toBe('success')
    const errors = b1.diagnostics.filter(d => d.severity === 'error')
    expect(errors[0], JSON.stringify(b1.diagnostics, null, 1)).toMatchObject({
      severity: 'error', kind: 'tex', fileId: bad.id, path: 'chapters/sections/bad.tex', line: 3,
    } satisfies Partial<Diagnostic>)
    expect(errors[0]!.message).toContain('Undefined control sequence')
    expect(b1.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', kind: 'undefined-reference', fileId: bad.id, line: 4,
    }))
    // nothing points outside the project, and every path with a file id is the file's path
    const pathsById = new Map([[main.id, 'main.tex'], [body.id, 'chapters/body.tex'], [bad.id, 'chapters/sections/bad.tex']])
    for (const d of b1.diagnostics) {
      if (d.path !== undefined) expect(d.path.startsWith('/') || /^[a-z]:/i.test(d.path)).toBe(false)
      if (d.fileId !== undefined) expect(pathsById.get(d.fileId)).toBe(d.path)
    }
    // stored with the build
    expect((await viewer.get<BuildResult>(`/api/projects/${p.id}/builds/latest`)).body.diagnostics).toEqual(b1.diagnostics)

    // Build 2: fixed
    expect((await owner.upload(p.id, (await sectionsOf(owner, p)), 'bad.tex', FIXED)).status).toBe(200)
    const b2 = await compile(owner, p)
    expect(b2.status, b2.log.slice(-3000)).toBe('success')
    expect(b2.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    expect(b2.hasPdf).toBe(true)

    // Forward search: body.tex line 4 is on page 2; main.tex line 4 is on page 1 (a viewer may ask).
    const r = await roundTrip(viewer, p, b2.buildId, body.id, 4, 2)
    expect(r.edit.path).toBe('chapters/body.tex')
    await roundTrip(viewer, p, b2.buildId, main.id, 4, 1)
    await roundTrip(viewer, p, b2.buildId, bad.id, 3, 2)

    // Clicking the section heading's number on page 1 lands in main.tex, never in a TeX Live file.
    const e = await viewer.get<SynctexEditResponse>(`/api/projects/${p.id}/builds/${b2.buildId}/synctex/edit?page=1&x=80&y=80`)
    expect(e.status).toBe(200)
    expect(e.body.fileId).toBe(main.id)
    // Clicks in the margins still land in a project file.
    for (const [x, y] of [[5, 5], [600, 830], [300, 400]]) {
      const m = await viewer.get<SynctexEditResponse>(`/api/projects/${p.id}/builds/${b2.buildId}/synctex/edit?page=2&x=${x}&y=${y}`)
      expect(m.status).toBe(200)
      expect([main.id, body.id, bad.id]).toContain(m.body.fileId)
    }
    // A page past the end has nothing.
    expect((await viewer.get(`/api/projects/${p.id}/builds/${b2.buildId}/synctex/edit?page=3&x=100&y=100`)).status).toBe(404)
    // The first build is still queryable (and cached separately).
    expect((await viewer.get(`/api/projects/${p.id}/builds/${b1.buildId}/synctex/view?fileId=${body.id}&line=4`)).status).toBe(200)
    expect(ts.lig.orchestrator.synctex.cached).toContain(`${p.id}/${b2.buildId}`)
  }, 180_000)

  it.each(['xelatex', 'lualatex'] as const)('%s: SyncTeX round-trips as well', async engine => {
    const owner = await signup(ts.base, `user-${engine}`)
    const { p, main, body } = await setupProject(owner, `Real ${engine}`)
    expect((await owner.patch(`/api/projects/${p.id}`, { engine })).status).toBe(200)
    expect((await owner.upload(p.id, await sectionsOf(owner, p), 'bad.tex', FIXED)).status).toBe(200)
    const b = await compile(owner, p)
    expect(b.status, b.log.slice(-3000)).toBe('success')
    await roundTrip(owner, p, b.buildId, body.id, 4, 2)
    await roundTrip(owner, p, b.buildId, main.id, 4, 1)
  }, 180_000)
})

async function sectionsOf(c: Client, p: ProjectDetail): Promise<string> {
  const d = (await c.get<ProjectDetail>(`/api/projects/${p.id}`)).body
  const s = d.tree.find(f => f.name === 'sections' && f.kind === 'folder')
  if (!s) throw new Error('no sections folder')
  return s.id
}
