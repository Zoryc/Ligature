import { describe, expect, it } from 'vitest'
import { edit, parseSynctex } from '../src/index.ts'
import { SYNTHETIC } from './synthetic.ts'

const ix = parseSynctex(SYNTHETIC)
const MAIN = '/build/src/main.tex'
const INTRO = '/build/src/chapters/intro.tex'
const at = (page: number, x: number, y: number) => edit(ix, { page, x, y })

describe('edit (inverse search)', () => {
  it('returns the record of the line of text nearest to the point', () => {
    expect(at(1, 130, 98)).toEqual({ path: MAIN, line: 3, column: -1 })
    expect(at(1, 220, 98)).toEqual({ path: MAIN, line: 4, column: -1 })
    expect(at(1, 300, 110)).toEqual({ path: INTRO, line: 2, column: -1 })
  })

  it('between records of two source lines, prefers the smaller line (where the clicked text starts)', () => {
    // x150 (line 3) is 49 to the left, g200 (line 4) 1 to the right
    expect(at(1, 199, 98)?.line).toBe(3)
    // past the last record of line 3: both neighbours are line 4
    expect(at(1, 260, 98)?.line).toBe(4)
  })

  it('in a kern, counts the kern on the side of its nearer edge', () => {
    // kern [110,120] of line 3; nearest records either side are line 3 anyway
    expect(at(1, 112, 98)?.line).toBe(3)
    // trailing kern [500,540] (line 4 after correction)
    expect(at(1, 530, 98)?.line).toBe(4)
  })

  it('enters boxes nested in a line and reports columns', () => {
    expect(at(1, 320, 138)).toEqual({ path: MAIN, line: 7, column: -1 })
    // x260 (line 8) is nearer, but the nested box to the right holds line 7: the smaller line wins
    expect(at(1, 262, 138)?.line).toBe(7)
    const t = 'SyncTeX Version:1\nInput:1:/src/a.tex\nUnit:65781.76\nContent:\n{1\n(1,2:0,100:100,8,2\nx1,5,3:10,100\nx1,5,3:50,100\n)\n}1\n'
    expect(edit(parseSynctex(t), { page: 1, x: 30, y: 98 })).toEqual({ path: '/src/a.tex', line: 5, column: 3 })
  })

  it('outside every line of text, uses the nearest line', () => {
    expect(at(1, 300, 102.5)?.line).toBe(4) // just below line A
    expect(at(1, 300, 300)?.line).toBe(7) // far below line C, under the nested box
    expect(at(1, 10, 98)?.line).toBe(3) // left margin of line A
    expect(at(2, 600, 50)).toEqual({ path: MAIN, line: 12, column: -1 })
  })

  it('with accept, skips rejected inputs and falls back to the nearest accepted record', () => {
    const onlyMain = { accept: (p: string) => p === MAIN }
    const r = edit(ix, { page: 1, x: 300, y: 110 }, onlyMain) // on line B, which is intro.tex
    expect(r?.path).toBe(MAIN)
    // TeX Live files are never returned when rejected
    const noTexLive = { accept: (p: string) => !p.startsWith('/usr/local/texlive/') }
    expect(edit(ix, { page: 1, x: 321, y: 110 }, noTexLive)).toEqual({ path: INTRO, line: 2, column: -1 })
    expect(edit(ix, { page: 1, x: 321, y: 110 })?.path).toBe('/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls')
    expect(edit(ix, { page: 1, x: 300, y: 110 }, { accept: () => false })).toBeNull()
  })

  it('returns null for pages without records and for bad coordinates', () => {
    expect(at(3, 100, 100)).toBeNull()
    expect(at(0, 100, 100)).toBeNull()
    expect(at(-1, 100, 100)).toBeNull()
    expect(at(Number.NaN, 100, 100)).toBeNull()
    expect(at(1, Number.POSITIVE_INFINITY, 100)).toBeNull()
    expect(at(1, 100, Number.NaN)).toBeNull()
  })

  it('LuaTeX math box whose math/position records carry the shipout line: returns the box line', () => {
    // As LuaLaTeX writes an align cell: the boxes say main.tex:13, the `$`/`x` records inside the innermost
    // box say part (a).tex:6 (the \clearpage that shipped the page).
    const math = (tag: number, line: number) => `SyncTeX Version:1
Input:1:/src/main.tex
Input:2:/src/sub dir/part (a).tex
Unit:65781.76
Content:
{1
[2,6:72,720:468,648,0
(1,13:72,303:468,8,4
(1,13:240,303:6,8,4
(1,13:240,303:5,4,0
$${tag},${line}:240,303
x${tag},${line}:245,303
$${tag},${line}:245,303
)
)
)
]
}1
`
    const q = { page: 1, x: 242, y: 301 }
    expect(edit(parseSynctex(math(2, 6)), q)).toEqual({ path: '/src/main.tex', line: 13, column: -1 })
    // with accept rejecting main.tex, the markers are the only accepted records
    expect(edit(parseSynctex(math(2, 6)), q, { accept: (p) => p !== '/src/main.tex' })?.line).toBe(6)
    // pdfTeX/XeTeX: the markers carry the box's line anyway
    expect(edit(parseSynctex(math(1, 13)), q)).toEqual({ path: '/src/main.tex', line: 13, column: -1 })
    // a math record from another line of the same file is treated the same way
    expect(edit(parseSynctex(math(1, 56)), q)).toEqual({ path: '/src/main.tex', line: 13, column: -1 })
  })

  it('accepts a fractional page number (rounded down)', () => {
    expect(at(1.7, 130, 98)?.line).toBe(3)
  })
})
