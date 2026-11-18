/**
 * Regenerates the oracle fixtures: compiles every fixture document with every engine (real TeX, via
 * latexmk with the compiler worker's flags), records the `synctex` CLI's answers for many sample points,
 * and writes `fixtures/<doc>-<engine>.synctex.gz` (machine paths rewritten to /build/src, ...) and
 * `fixtures/<doc>-<engine>.oracle.json`.
 *
 *   export PATH="<TeX Live bin>:$PATH"
 *   node packages/synctex/test/generate-fixtures.ts [case-name ...]
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseSynctex } from '../src/parse.ts'
import {
  CASES, cliEdit, cliView, compileCase, docFiles, editSamples, hasLatexmk, hasSynctexCli, lineCount, makeRewriter,
  oraclePath, pool, rewriteInputs, synctexGzPath, toFixturePath, type Oracle,
} from './oracle.ts'

if (!hasLatexmk() || !hasSynctexCli()) {
  console.error('latexmk and synctex must be on PATH')
  process.exit(1)
}

const only = process.argv.slice(2)
const cases = only.length > 0 ? CASES.filter((c) => only.includes(c.name)) : CASES
const cliVersion = (() => {
  const r = spawnSync('synctex', ['help'], { encoding: 'utf8' })
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\r?\n/).filter((l) => /version/.test(l)).map((l) => l.trim()).join(' / ')
})()

const user = homedir().split(/[\\/]/).pop() ?? ''

for (const c of cases) {
  const t0 = Date.now()
  const work = mkdtempSync(join(tmpdir(), 'ligature-synctex-'))
  try {
    const compiled = compileCase(c, work)
    const ix = parseSynctex(compiled.synctexText)
    const rewrite = makeRewriter(compiled.srcDir, compiled.outDir)
    const toFixture = (p: string) => toFixturePath(rewrite(p))

    const viewQueries = docFiles(c.doc).filter((f) => f.endsWith('.tex'))
      .flatMap((file) => Array.from({ length: lineCount(c.doc, file) }, (_, i) => ({ file, line: i + 1 })))
    const view = await pool(viewQueries, 8, async (q) => ({ ...q, boxes: await cliView(compiled.pdf, compiled.srcDir, q.file, q.line) }))

    const samples = editSamples(ix, c.name)
    const edit = await pool(samples, 8, async (s) => ({
      ...s, results: await cliEdit(compiled.pdf, compiled.srcDir, s.page, s.x, s.y, toFixture),
    }))

    const text = rewriteInputs(compiled.synctexText, rewrite)
    for (const bad of [compiled.srcDir, 'AppData', user ? `/${user}/` : '']) {
      if (bad && (text.includes(bad) || text.includes(bad.split('\\').join('/')))) throw new Error(`${c.name}: machine path left in fixture: ${bad}`)
    }
    writeFileSync(synctexGzPath(c), gzipSync(Buffer.from(text, 'utf8'), { level: 9 }))

    const oracle: Oracle = { case: c.name, doc: c.doc, engine: c.engine, cli: cliVersion, view, edit }
    writeFileSync(oraclePath(c), stringify(oracle))
    const misses = view.filter((v) => v.boxes.length === 0).length
    console.log(`${c.name}: ${ix.pageCount} pages, ${ix.count} records, ${view.length} view samples (${misses} empty), ` +
      `${edit.length} edit samples, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** JSON with one sample per line (readable diffs). */
function stringify(o: Oracle): string {
  const { view, edit, ...head } = o
  const lines = (a: unknown[]) => a.map((x) => '    ' + JSON.stringify(x)).join(',\n')
  const h = JSON.stringify(head).slice(0, -1)
  return `${h},\n  "view": [\n${lines(view)}\n  ],\n  "edit": [\n${lines(edit)}\n  ]\n}\n`
}
