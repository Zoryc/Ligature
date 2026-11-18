// Live comparison with the `synctex` command-line tool: compiles some fixture documents with real TeX
// (latexmk, the compiler worker's flags), asks the CLI, and compares with our answers on the fresh
// output. Runs where latexmk and synctex are on PATH; with CI=true their absence is a failure.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { edit, parseSynctex, view } from '../src/index.ts'
import { normalizePath } from '../src/paths.ts'
import {
  CASES, cliEdit, cliView, compileCase, docFiles, editSamples, forwardAgrees, hasLatexmk, hasSynctexCli, inverseAgrees,
  isWindows, lineCount, onText, pool,
} from './oracle.ts'

const IN_CI = process.env.CI === 'true' || process.env.CI === '1'
const AVAILABLE = hasLatexmk() && hasSynctexCli()
const LIVE_CASES = ['multifile-pdflatex', 'twocolumn-xelatex', 'longpar-lualatex']

describe.skipIf(!AVAILABLE && !IN_CI)('live agreement with the synctex CLI', () => {
  const work: string[] = []
  afterAll(() => {
    for (const w of work) rmSync(w, { recursive: true, force: true })
  })

  it('latexmk and synctex are installed', () => {
    expect(AVAILABLE, 'latexmk and synctex must be on PATH (TeX Live)').toBe(true)
  })

  it.skipIf(!AVAILABLE)(`agrees on fresh output (${LIVE_CASES.join(', ')})`, async () => {
    let fwd = 0
    let fwdN = 0
    let text = 0
    let textN = 0
    const lines: string[] = []
    for (const name of LIVE_CASES) {
      const c = CASES.find((x) => x.name === name)!
      const dir = mkdtempSync(join(tmpdir(), 'ligature-synctex-live-'))
      work.push(dir)
      const compiled = compileCase(c, dir)
      const ix = parseSynctex(compiled.synctexText)

      // project-relative path of an input as written by TeX or by the CLI
      const src = normalizePath(compiled.srcDir)
      const rel = (p: string) => {
        const n = normalizePath(p)
        const [a, b] = isWindows ? [n.toLowerCase(), src.toLowerCase()] : [n, src]
        return a.startsWith(b + '/') ? n.slice(src.length + 1) : n
      }

      const queries = docFiles(c.doc).filter((f) => f.endsWith('.tex'))
        .flatMap((file) => Array.from({ length: lineCount(c.doc, file) }, (_, i) => ({ file, line: i + 1 })))
      const views = await pool(queries, 8, async (q) => ({ q, cli: await cliView(compiled.pdf, compiled.srcDir, q.file, q.line) }))
      let caseFwd = 0
      for (const { q, cli } of views) if (forwardAgrees(view(ix, { path: q.file, line: q.line }), cli)) caseFwd++

      const samples = editSamples(ix, `live-${name}`, { grid: [5, 6], near: 25 }).filter((s) => onText(ix, s))
      const edits = await pool(samples, 8, async (s) => ({ s, cli: await cliEdit(compiled.pdf, compiled.srcDir, s.page, s.x, s.y, rel) }))
      let caseText = 0
      for (const { s, cli } of edits) {
        const ours = edit(ix, s)
        if (inverseAgrees(ours ? { file: rel(ours.path), line: ours.line } : null, cli)) caseText++
      }
      fwd += caseFwd
      fwdN += views.length
      text += caseText
      textN += edits.length
      lines.push(`${name.padEnd(20)} forward ${caseFwd}/${views.length}   inverse on text ${caseText}/${edits.length}`)
    }
    lines.push(`live TOTAL           forward ${(100 * fwd / fwdN).toFixed(1)}%   inverse on text ${(100 * text / textN).toFixed(1)}%`)
    console.log(lines.join('\n'))
    expect(fwd / fwdN).toBeGreaterThanOrEqual(0.95)
    expect(text / textN).toBeGreaterThanOrEqual(0.95)
  }, 300_000)
})
