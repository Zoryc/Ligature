import { describe, expect, it } from 'vitest'
import { parseSynctex, view } from '../src/index.ts'
import { mergeLines } from '../src/view.ts'
import { SYNTHETIC } from './synthetic.ts'

const ix = parseSynctex(SYNTHETIC)
const LINE_A = { page: 1, x: 72, y: 92, width: 468, height: 10 }
const LINE_B = { page: 1, x: 72, y: 104, width: 468, height: 10 }
const LINE_C = { page: 1, x: 72, y: 132, width: 468, height: 10 }
const PAGE2 = { page: 2, x: 72, y: 92, width: 468, height: 10 }

describe('view (forward search)', () => {
  it('returns the line of text holding the records of the line', () => {
    expect(view(ix, { path: 'main.tex', line: 3 })).toEqual([LINE_A])
    expect(view(ix, { path: 'main.tex', line: 4 })).toEqual([LINE_A])
    expect(view(ix, { path: 'chapters/intro.tex', line: 2 })).toEqual([LINE_B])
  })

  it('uses the nearest line with records when the line has none (the later one on a tie)', () => {
    expect(view(ix, { path: 'main.tex', line: 5 })).toEqual([LINE_A]) // 4 is nearer than 7
    expect(view(ix, { path: 'main.tex', line: 6 })).toEqual([LINE_C]) // 7 is nearer than 4
    expect(view(ix, { path: 'main.tex', line: 10 })).toEqual([PAGE2]) // 8 and 12 tie: 12
    expect(view(ix, { path: 'main.tex', line: 1 })).toEqual([LINE_A])
    expect(view(ix, { path: 'main.tex', line: 1000 })).toEqual([PAGE2])
    expect(view(ix, { path: 'chapters/intro.tex', line: 1 })).toEqual([LINE_B])
  })

  it('ignores the line TeX wrote on boxes and on leading/trailing records of a line of text', () => {
    // line A's hbox, leading x and trailing kern/glue were written with line 5: line 5 has no own records
    expect(view(ix, { path: 'main.tex', line: 5 })).toEqual([LINE_A])
    // the parindent box of line C carries line 6, but it is a box: line 6 resolves to line 7
    expect(view(ix, { path: 'main.tex', line: 6 })).toEqual([LINE_C])
  })

  it('merges a box nested in a line of text into the line', () => {
    expect(view(ix, { path: 'main.tex', line: 7 })).toEqual([LINE_C])
  })

  it('matches paths written in any form, and TeX Live files too', () => {
    expect(view(ix, { path: '/build/src/main.tex', line: 3 })).toEqual([LINE_A])
    expect(view(ix, { path: './main.tex', line: 3, column: 7 })).toEqual([LINE_A])
    expect(view(ix, { path: 'article.cls', line: 40 })).toEqual([LINE_B])
  })

  it('returns [] for unknown files, files without records and bad lines', () => {
    expect(view(ix, { path: 'missing.tex', line: 1 })).toEqual([])
    expect(view(ix, { path: 'late.tex', line: 1 })).toEqual([])
    expect(view(ix, { path: 'main.tex', line: Number.NaN })).toEqual([])
    expect(view(ix, { path: '', line: 1 })).toEqual([])
  })

  it('falls back to boxes when a file has no other records', () => {
    const t = `SyncTeX Version:1\nInput:1:/src/main.tex\nInput:2:/src/boxes.tex\nUnit:65781.76\nContent:\n{1\n` +
      `[2,3:72,300:200,200,0\n(2,4:80,150:100,10,2\n)\n]\n}1\n`
    const b = parseSynctex(t)
    expect(view(b, { path: 'boxes.tex', line: 4 })).toEqual([{ page: 1, x: 80, y: 140, width: 100, height: 12 }])
    // a line whose only record is a vbox (a float, a page body) gets the vbox
    expect(view(b, { path: 'boxes.tex', line: 2 })).toEqual([{ page: 1, x: 72, y: 100, width: 200, height: 200 }])
  })

  it('returns every line of output of a long source line, on the first page only', () => {
    const lines = ['SyncTeX Version:1', 'Input:1:/src/main.tex', 'Unit:65781.76', 'Content:']
    for (const page of [1, 2]) {
      lines.push(`{${page}`, '[1,9:72,720:400,648,0')
      for (let k = 0; k < 3; k++) lines.push(`(1,9:72,${100 + 12 * k}:400,8,2`, `x1,2:80,${100 + 12 * k}`, `g1,2:90,${100 + 12 * k}`, ')')
      lines.push(']', `}${page}`)
    }
    const long = parseSynctex(lines.join('\n'))
    expect(view(long, { path: 'main.tex', line: 2 })).toEqual([
      { page: 1, x: 72, y: 92, width: 400, height: 10 },
      { page: 1, x: 72, y: 104, width: 400, height: 10 },
      { page: 1, x: 72, y: 116, width: 400, height: 10 },
    ])
  })
})

describe('mergeLines', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })
  it('drops boxes inside others and joins touching boxes on the same line', () => {
    expect(mergeLines([box(0, 0, 100, 10), box(10, 2, 20, 8)])).toEqual([box(0, 0, 100, 10)])
    expect(mergeLines([box(50, 0, 100, 10), box(0, 1, 50.5, 10)])).toEqual([box(0, 0, 100, 10)])
  })
  it('keeps columns and different lines apart, sorted top to bottom', () => {
    expect(mergeLines([box(300, 0, 500, 10), box(0, 0, 228, 10)])).toEqual([box(0, 0, 228, 10), box(300, 0, 500, 10)])
    expect(mergeLines([box(0, 20, 100, 30), box(0, 0, 100, 10)])).toEqual([box(0, 0, 100, 10), box(0, 20, 100, 30)])
  })
  it('bounds its work on hostile input', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => box(i, i % 7, i + 0.5, (i % 7) + 1))
    const t0 = performance.now()
    const out = mergeLines(many)
    expect(out.length).toBeLessThanOrEqual(1000)
    expect(performance.now() - t0).toBeLessThan(5_000)
  })
})
