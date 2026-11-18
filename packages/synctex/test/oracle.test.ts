// Compares our forward and inverse search with the answers the `synctex` CLI gave on the committed
// fixtures (recorded by generate-fixtures.ts), so it runs without TeX. Prints the agreement rates;
// SYNCTEX_DEBUG=1 also prints every disagreement.
//
// Inverse samples are split in two: points on a line of text (what users double-click) and points in
// margins / between lines, where the CLI's choice is an artefact of its search order (it skips the
// nearest line in favour of one further away, e.g. the line below a heading) and we take the nearest line.
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { edit, parseSynctex, view } from '../src/index.ts'
import { CASES, editToFixture, forwardAgrees, inverseAgrees, onText, oraclePath, synctexGzPath, type Oracle } from './oracle.ts'

/** Required agreement with the CLI (docs/M2.md §3): forward on all samples, inverse on text. */
const TARGET = 0.95
/**
 * LuaTeX tags many glyph records with the line where the page was shipped out (`\end{document}` in
 * small documents); the CLI often answers with that line, we prefer the real one. On the two-column
 * LuaLaTeX fixture the CLI answers `\end{document}` for almost every click, so it is left out here.
 */
const LUA_TEXT_FLOOR = 0.9
const LUA_EXCLUDED = 'twocolumn-lualatex'
/** Regression floors for the rest (see the header comment and the per-case table). */
const INVERSE_ALL_FLOOR = 0.78
const PER_CASE_FORWARD_FLOOR = 0.9

const DEBUG = !!process.env.SYNCTEX_DEBUG

interface Score {
  case: string
  engine: string
  fwd: number
  fwdN: number
  text: number
  textN: number
  all: number
  allN: number
}

function score(name: string): Score {
  const c = CASES.find((x) => x.name === name)!
  const ix = parseSynctex(gunzipSync(readFileSync(synctexGzPath(c))).toString('utf8'))
  const oracle = JSON.parse(readFileSync(oraclePath(c), 'utf8')) as Oracle
  const s: Score = { case: name, engine: c.engine, fwd: 0, fwdN: 0, text: 0, textN: 0, all: 0, allN: 0 }
  for (const v of oracle.view) {
    const ours = view(ix, { path: v.file, line: v.line })
    s.fwdN++
    if (forwardAgrees(ours, v.boxes)) s.fwd++
    else if (DEBUG) console.log(`${name} view ${v.file}:${v.line}\n  cli  ${JSON.stringify(v.boxes)}\n  ours ${JSON.stringify(ours)}`)
  }
  for (const e of oracle.edit) {
    const ours = editToFixture(edit(ix, e))
    const agrees = inverseAgrees(ours, e.results)
    const text = onText(ix, e)
    s.allN++
    if (agrees) s.all++
    if (text) {
      s.textN++
      if (agrees) s.text++
    }
    if (!agrees && DEBUG) {
      console.log(`${name} edit ${text ? 'TEXT' : 'GAP'} p${e.page} ${e.x},${e.y}\n  cli  ${JSON.stringify(e.results)}\n  ours ${JSON.stringify(ours)}`)
    }
  }
  return s
}

const pct = (a: number, n: number) => (n === 0 ? '   -  ' : `${((100 * a) / n).toFixed(1)}%`.padStart(6))
const row = (label: string, s: Omit<Score, 'case' | 'engine'>) =>
  `${label.padEnd(20)} forward ${pct(s.fwd, s.fwdN)} (${s.fwd}/${s.fwdN})`.padEnd(48) +
  `inverse on text ${pct(s.text, s.textN)} (${s.text}/${s.textN})`.padEnd(38) +
  `inverse all ${pct(s.all, s.allN)} (${s.all}/${s.allN})`
const sum = (list: Score[]) => {
  const t = { fwd: 0, fwdN: 0, text: 0, textN: 0, all: 0, allN: 0 }
  for (const s of list) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += s[k]
  return t
}

describe('agreement with the synctex CLI (recorded oracle)', () => {
  const scores = CASES.map((c) => score(c.name))
  const total = sum(scores)
  const noLua = sum(scores.filter((s) => s.engine !== 'lualatex'))

  it('reports the agreement rates', () => {
    const lines = scores.map((s) => row(s.case, s))
    lines.push(row('TOTAL', total), row('TOTAL w/o lualatex', noLua))
    console.log(lines.join('\n'))
  })

  it(`forward search agrees on >= ${TARGET * 100}% of all samples`, () => {
    expect(total.fwd / total.fwdN).toBeGreaterThanOrEqual(TARGET)
  })

  it(`inverse search agrees on >= ${TARGET * 100}% of the samples on text (pdfLaTeX, XeLaTeX)`, () => {
    expect(noLua.text / noLua.textN).toBeGreaterThanOrEqual(TARGET)
  })

  it(`inverse search agrees on >= ${LUA_TEXT_FLOOR * 100}% of the samples on text (LuaLaTeX, without ${LUA_EXCLUDED})`, () => {
    const lua = sum(scores.filter((s) => s.engine === 'lualatex' && s.case !== LUA_EXCLUDED))
    expect(lua.text / lua.textN).toBeGreaterThanOrEqual(LUA_TEXT_FLOOR)
  })

  it(`inverse search agrees on >= ${INVERSE_ALL_FLOOR * 100}% of all samples (margins and gaps included)`, () => {
    expect(total.all / total.allN).toBeGreaterThanOrEqual(INVERSE_ALL_FLOOR)
  })

  for (const s of scores) {
    it(`${s.case}: forward agrees on >= ${PER_CASE_FORWARD_FLOOR * 100}%`, () => {
      expect(s.fwd / s.fwdN).toBeGreaterThanOrEqual(PER_CASE_FORWARD_FLOOR)
    })
  }
})
