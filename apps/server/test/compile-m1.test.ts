import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileDocName } from '@ligature/shared'
import { connect, HAS_LATEXMK, startCompiler, waitFor } from './harness.ts'
import { addMember, newProject, openInstance, signup, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'

const MAIN = String.raw`\documentclass{article}
\usepackage{graphicx}
\title{M1 paper}
\begin{document}
\maketitle
\section{Results}
As shown by \cite{knuth84}, figure~\ref{fig:plot} is red.
\begin{figure}[h]
  \centering
  \includegraphics[width=2cm]{figures/plot}
  \caption{A plot.}\label{fig:plot}
\end{figure}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`

const BIB = String.raw`@article{knuth84,
  author  = {Donald E. Knuth},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  volume  = {27},
  number  = {2},
  pages   = {97--111},
  year    = {1984}
}
`

/**
 * M1 "done when": two users on a server co-write and compile a paper with images and a .bib;
 * a viewer cannot edit or compile. Real compiler worker + real TeX (TinyTeX/TeX Live on PATH).
 */
describe.skipIf(!HAS_LATEXMK)('M1 done-criterion: co-write + compile a paper with an uploaded PNG and a .bib (real TeX)', () => {
  let compiler: ChildProcess
  let ts: TestServer
  beforeAll(async () => {
    compiler = await startCompiler(39200)
    ;({ ts } = await openInstance(39201, { compilerUrl: 'http://127.0.0.1:39200' }))
  }, 30_000)
  afterAll(async () => {
    await ts?.stop()
    if (compiler && compiler.exitCode === null && compiler.signalCode === null) compiler.kill('SIGKILL')
  })

  it('compiles with the image and the bibliography resolved', async () => {
    const alice = await signup(ts.base, 'alice')
    const bob = await signup(ts.base, 'bob')
    const carol = await signup(ts.base, 'carol')
    const p = await newProject(alice, 'M1 paper')
    await addMember(alice, bob, p.id, 'editor')
    await addMember(alice, carol, p.id, 'viewer')

    const figures = (await alice.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'figures', kind: 'folder' })).body
    const png = await bob.upload(p.id, figures.id, 'plot.png', makePng(16, 16))
    expect(png.body.kind).toBe('binary')
    expect((await bob.upload(p.id, p.rootId, 'refs.bib', BIB)).body.kind).toBe('text')
    // main.tex replaced by upload (text -> text minimal diff), while alice has it open
    const main = p.tree.find(f => f.name === 'main.tex')!
    const a = connect(ts.base, alice.cookie, fileDocName(p.id, main.id, main.epoch!))
    const b = connect(ts.base, bob.cookie, fileDocName(p.id, main.id, main.epoch!))
    try {
      await waitFor(() => a.provider.isSynced && b.provider.isSynced, 10_000, 'sync')
      expect((await alice.upload(p.id, p.rootId, 'main.tex', MAIN)).status).toBe(200)
      await waitFor(() => a.text().toString() === MAIN && b.text().toString() === MAIN, 5_000, 'both see the upload')
      // co-writing: both add a sentence live (not yet compacted anywhere)
      const t = b.text()
      t.insert(t.toString().indexOf('\\begin{figure}'), 'Bob wrote this live.\n')
      a.text().insert(a.text().toString().indexOf('\\section'), 'Alice wrote this live.\n')
      await waitFor(() => a.text().toString() === b.text().toString() && !a.provider.hasUnsyncedChanges && !b.provider.hasUnsyncedChanges,
        5_000, 'convergence')

      const r = await bob.post(`/api/projects/${p.id}/compile`)
      expect(r.status).toBe(200)
      const build = r.body as { buildId: string; status: string; hasPdf: boolean; log: string }
      expect(build.status, build.log.slice(-3000)).toBe('success')
      expect(build.hasPdf).toBe(true)
      expect(build.log).toMatch(/figures[\\/]plot\.png/)
      expect(build.log).toMatch(/refs\.bbl|main\.bbl|output\.bbl/)
      expect(build.log).not.toMatch(/Citation `knuth84' on page \d+ undefined/)
      expect(build.log).not.toMatch(/There were undefined references/)

      const pdf = await alice.req('GET', `/api/projects/${p.id}/builds/${build.buildId}/output.pdf`)
      expect(pdf.status).toBe(200)
      expect(Buffer.from(await pdf.raw.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')

      // the viewer can read the PDF but cannot compile or edit
      expect((await carol.req('GET', `/api/projects/${p.id}/builds/${build.buildId}/output.pdf`)).status).toBe(200)
      expect((await carol.post(`/api/projects/${p.id}/compile`)).status).toBe(403)
      expect((await carol.upload(p.id, p.rootId, 'main.tex', 'pwned')).status).toBe(403)
    } finally { a.destroy(); b.destroy() }
  }, 180_000)
})
