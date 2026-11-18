import { describe, expect, it } from 'vitest'
import { Kind, parseSynctex, SynctexError, type SynctexIndex } from '../src/index.ts'
import { SYNTHETIC } from './synthetic.ts'

const header = (extra = '') => `SyncTeX Version:1\nInput:1:/src/main.tex\nOutput:pdf\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\n${extra}Content:\n`
const find = (ix: SynctexIndex, kind: Kind, line: number) => {
  for (let i = 0; i < ix.count; i++) if (ix.kind[i] === kind && ix.line[i] === line) return i
  return -1
}
const thrown = (f: () => unknown): unknown => {
  try {
    f()
  } catch (e) {
    return e
  }
  return undefined
}

describe('parseSynctex', () => {
  it('reads inputs (normalised, also after Content:), pages and records', () => {
    const ix = parseSynctex(SYNTHETIC)
    expect([...ix.inputs]).toEqual([
      [1, '/build/src/main.tex'],
      [2, '/build/src/chapters/intro.tex'],
      [3, '/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls'],
      [4, '/build/src/late.tex'],
    ])
    expect(ix.pageCount).toBe(2)
    expect(ix.truncated).toBe(false)
    expect(ix.count).toBe(26)
    expect(ix.scale).toBeCloseTo(1, 12)
  })

  it('records parents, depth and pages', () => {
    const ix = parseSynctex(SYNTHETIC)
    expect(ix.kind[0]).toBe(Kind.VBox)
    expect(ix.parent[0]).toBe(-1)
    expect(ix.kind[1]).toBe(Kind.HBox)
    expect(ix.parent[1]).toBe(0)
    expect(ix.depth[1]).toBe(1)
    expect(ix.parent[2]).toBe(1)
    expect(ix.depth[2]).toBe(2)
    const nested = find(ix, Kind.Boundary, 7) // x1,7:100,140 -- its parent is line C
    expect(ix.kind[ix.parent[nested]!]).toBe(Kind.HBox)
    expect(ix.page[ix.count - 1]).toBe(2) // g1,12
    expect(ix.page[0]).toBe(1)
    // the nested hbox in line C and its child
    let inner = -1
    for (let i = 0; i < ix.count; i++) if (ix.kind[i] === Kind.HBox && ix.h[i] === 300) inner = i
    expect(ix.depth[inner]).toBe(2)
    expect(ix.parent[inner + 1]).toBe(inner)
  })

  it('stores W/H/D, kern widths and columns', () => {
    const ix = parseSynctex(SYNTHETIC)
    expect([ix.h[1], ix.v[1], ix.width[1], ix.height[1], ix.depthBelow[1]]).toEqual([72, 100, 468, 8, 2])
    const kern = find(ix, Kind.Kern, 3)
    expect([ix.h[kern], ix.width[kern]]).toEqual([120, 10])
    const col = find(ix, Kind.Boundary, 8)
    expect(ix.column[col]).toBe(4)
    expect(ix.column[1]).toBe(-1)
  })

  it('gives leading boundaries the line of the next record and trailing kern+glue the line before', () => {
    const ix = parseSynctex(SYNTHETIC)
    // line A: x1,5 -> line 3 (from k1,3); k1,5 and g1,5 -> line 4 (from x1,4)
    expect([ix.line[2], ix.line[7], ix.line[8]]).toEqual([3, 4, 4])
    expect([ix.kind[7], ix.kind[8]]).toEqual([Kind.Kern, Kind.Glue])
    // line B: x2,1 -> line 2 of the same tag
    expect([ix.tag[10], ix.line[10]]).toEqual([2, 2])
    // the hboxes keep their own line
    expect(ix.line[1]).toBe(5)
  })

  it('converts units: Unit, Magnification, offsets, and the post scriptum overrides', () => {
    const sp = 65781.76
    expect(parseSynctex(header()).scale).toBeCloseTo(1 / sp, 15)
    expect(parseSynctex(header().replace('Unit:1', 'Unit:8192')).scale).toBeCloseTo(8192 / sp, 12)
    expect(parseSynctex(header().replace('Magnification:1000', 'Magnification:2000')).scale).toBeCloseTo(2 / sp, 15)
    const pre = parseSynctex(header().replace('X Offset:0', 'X Offset:65781760'))
    expect(pre.xOffset).toBeCloseTo(1000, 6)
    const post = parseSynctex(header() + '{1\n}1\nPostamble:\nCount:0\nPost scriptum:\nMagnification:2\nX Offset:1in\nY Offset:-72.27pt\n')
    expect(post.scale).toBeCloseTo(2 / sp, 15)
    expect(post.xOffset).toBeCloseTo(72, 9)
    expect(post.yOffset).toBeCloseTo(-72, 9)
    // unreadable values keep the defaults
    const bad = parseSynctex(header().replace('Unit:1', 'Unit:zero').replace('Magnification:1000', 'Magnification:-5'))
    expect(bad.scale).toBeCloseTo(8192 / sp, 12)
  })

  it('accepts CRLF line endings', () => {
    const a = parseSynctex(SYNTHETIC)
    const b = parseSynctex(SYNTHETIC.replace(/\n/g, '\r\n'))
    expect(b.count).toBe(a.count)
    expect([...b.inputs]).toEqual([...a.inputs])
    expect(Array.from(b.line)).toEqual(Array.from(a.line))
  })

  it('skips damaged records and tolerates unbalanced boxes', () => {
    const text = header() + [
      '{1', ')', ']', '[1,1:0,100:50,100,0', '(garbage', 'x1,2:10,50', ')', 'x1,abc:1,2', 'k1,2:', 'g1,3:99999999999,1',
      'x1,4:20,60', 'g-1,5:1,1', '$1,6:30,70', 'v1,7:1,2:3,4,5', 'q1,1:1,1', ']', ']', ')', '}1', 'x1,9:1,1', '{1',
    ].join('\n')
    const ix = parseSynctex(text)
    // kept: the vbox, x1,2, x1,4, $1,6, v1,7 (and x1,9 outside any page)
    expect(ix.count).toBe(6)
    const x2 = find(ix, Kind.Boundary, 2)
    expect(ix.parent[x2]).toBe(0) // the damaged hbox line still opened a level, children go to the vbox
    expect(ix.parent[find(ix, Kind.Boundary, 4)]).toBe(0)
    expect(ix.page[find(ix, Kind.Boundary, 9)]).toBe(0)
    expect(ix.kind[find(ix, Kind.VoidVBox, 7)]).toBe(Kind.VoidVBox)
  })

  it('keeps form (XObject) content off the pages', () => {
    const ix = parseSynctex(header() + '<1\n(1,1:0,10:5,5,0\nx1,1:1,10\n)\n>\n{1\nx1,2:1,10\n}1\n')
    expect(Array.from(ix.page)).toEqual([0, 0, 1])
    expect(ix.parent[2]).toBe(-1)
  })

  it('moves LuaTeX-style vboxes (origin at the top) to their baseline', () => {
    // in points (Unit:1 = sp): vbox at v=100 with H=50; its child hboxes sit at 110..140, below v
    const pt = (n: number) => n * 65536
    const lua = parseSynctex(header() + [
      '{1', `[1,1:0,${pt(100)}:${pt(200)},${pt(50)},0`, `(1,2:0,${pt(120)}:${pt(200)},${pt(10)},${pt(2)}`, ')',
      `(1,3:0,${pt(140)}:${pt(200)},${pt(10)},0`, ')', ']', '}1',
    ].join('\n'))
    expect(lua.v[0]).toBe(pt(150))
    // pdfTeX-style vbox (origin at the bottom) is left alone
    const pdf = parseSynctex(header() + [
      '{1', `[1,1:0,${pt(150)}:${pt(200)},${pt(50)},0`, `(1,2:0,${pt(120)}:${pt(200)},${pt(10)},${pt(2)}`, ')', ']', '}1',
    ].join('\n'))
    expect(pdf.v[0]).toBe(pt(150))
  })

  it('rejects texts that are not SyncTeX, and non-strings, with SynctexError(Invalid)', () => {
    for (const bad of ['', 'hello', '%PDF-1.5', '\nSyncTeX Version:1']) {
      const e = thrown(() => parseSynctex(bad))
      expect(e).toBeInstanceOf(SynctexError)
      expect((e as SynctexError).code).toBe('Invalid')
    }
    const e = thrown(() => parseSynctex(42 as unknown as string))
    expect((e as SynctexError).code).toBe('Invalid')
  })

  it('rejects texts above maxChars (default 50 MiB) with SynctexError(TooLarge)', () => {
    const e = thrown(() => parseSynctex(SYNTHETIC, { maxChars: 100 }))
    expect(e).toBeInstanceOf(SynctexError)
    expect((e as SynctexError).code).toBe('TooLarge')
    expect(parseSynctex(SYNTHETIC, { maxChars: SYNTHETIC.length }).count).toBe(26)
    const big = 'SyncTeX Version:1\n' + ' '.repeat(50 * 1024 * 1024)
    expect((thrown(() => parseSynctex(big)) as SynctexError).code).toBe('TooLarge')
  })

  it('stops at maxRecords and says so', () => {
    const ix = parseSynctex(SYNTHETIC, { maxRecords: 5 })
    expect(ix.count).toBe(5)
    expect(ix.truncated).toBe(true)
    expect(parseSynctex(SYNTHETIC, { maxRecords: 0 }).count).toBe(0)
  })

  it('parses a large file in linear time', () => {
    const lines = ['{1', '[1,1:0,0:1000,1000,0']
    for (let i = 0; i < 100_000; i++) lines.push(`(1,${i + 1}:0,${i}:1000,8,2`, `x1,${i + 1}:10,${i}`, `k1,${i + 1}:20,${i}:5`, `g1,${i + 1}:30,${i}`, ')')
    lines.push(']', '}1')
    const text = header() + lines.join('\n')
    const t0 = performance.now()
    const ix = parseSynctex(text)
    const ms = performance.now() - t0
    expect(ix.count).toBe(400_001)
    expect(ms).toBeLessThan(5_000)
  })
})
