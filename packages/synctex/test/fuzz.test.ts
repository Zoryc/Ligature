// Mutated, truncated and hostile inputs: parseSynctex may only throw SynctexError, view/edit never
// throw, and nothing takes long (no quadratic blow-ups, no deep recursion).
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { edit, parseSynctex, SynctexError, view, type SynctexIndex } from '../src/index.ts'
import { CASES, prng, synctexGzPath } from './oracle.ts'
import { SYNTHETIC } from './synthetic.ts'

const texts = [SYNTHETIC, ...CASES.map((c) => gunzipSync(readFileSync(synctexGzPath(c))).toString('utf8'))]
const ALPHABET = '[]()<>{}!:,-+0123456789xkgvhr$fIPMUXY \n\r\t.\u0000é'

function mutate(text: string, rnd: () => number): string {
  const pick = (n: number) => Math.floor(rnd() * n)
  let s = text
  const ops = 1 + pick(8)
  for (let k = 0; k < ops; k++) {
    const at = pick(s.length + 1)
    switch (pick(9)) {
      case 0: // flip characters
        for (let j = 0; j < 1 + pick(20); j++) {
          const p = pick(s.length)
          s = s.slice(0, p) + ALPHABET[pick(ALPHABET.length)] + s.slice(p + 1)
        }
        break
      case 1: // truncate
        s = s.slice(0, at)
        break
      case 2: // delete a range
        s = s.slice(0, at) + s.slice(at + pick(2000))
        break
      case 3: // duplicate a range
        s = s.slice(0, at) + s.slice(at, at + pick(3000)) + s.slice(at)
        break
      case 4: { // swap two lines
        const lines = s.split('\n')
        const a = pick(lines.length)
        const b = pick(lines.length)
        ;[lines[a], lines[b]] = [lines[b]!, lines[a]!]
        s = lines.join('\n')
        break
      }
      case 5: // huge / negative numbers
        s = s.slice(0, at) + ['99999999999999999999', '-2147483649', '2147483647', '-0', '1e9', 'NaN'][pick(6)] + s.slice(at)
        break
      case 6: // unbalanced boxes
        s = s.slice(0, at) + '\n' + ['[', ']', '(', ')', '{1', '}1', '<', '>', '{-5', '{99999999'][pick(10)] + '\n' + s.slice(at)
        break
      case 7: // garbage line
        s = s.slice(0, at) + '\n' + Array.from({ length: pick(80) }, () => ALPHABET[pick(ALPHABET.length)]).join('') + '\n' + s.slice(at)
        break
      default: // drop every n-th line
        s = s.split('\n').filter((_, i) => i % (2 + pick(5)) !== 0).join('\n')
    }
  }
  return s
}

/** Runs a handful of queries; returns how many produced a result (the value is irrelevant). */
function exercise(ix: SynctexIndex, rnd: () => number): number {
  let n = 0
  const paths = [...ix.inputs.values(), 'main.tex', 'chapters/intro.tex', '', '../../etc/passwd']
  for (let k = 0; k < 6; k++) {
    const path = paths[Math.floor(rnd() * paths.length)]!
    const line = [1, 2, 7, 13, 1000, -5, 0, 2.5, Number.NaN][Math.floor(rnd() * 9)]!
    if (view(ix, { path, line }).length > 0) n++
    const page = Math.floor(rnd() * (ix.pageCount + 2))
    const x = rnd() * 700 - 50
    const y = rnd() * 900 - 50
    if (edit(ix, { page, x, y }, { accept: (p) => p.length % 2 === 0 })) n++
    if (edit(ix, { page, x, y })) n++
  }
  return n
}

describe('fuzz', () => {
  it('mutated SyncTeX files never throw anything but SynctexError, and queries never throw', () => {
    const rnd = prng('fuzz')
    let parsed = 0
    let rejected = 0
    const t0 = performance.now()
    for (let iter = 0; iter < 3000; iter++) {
      const text = mutate(texts[iter % texts.length]!, rnd)
      let ix: SynctexIndex
      try {
        ix = parseSynctex(text, { maxRecords: 50_000 })
      } catch (e) {
        expect(e).toBeInstanceOf(SynctexError)
        rejected++
        continue
      }
      parsed++
      exercise(ix, rnd)
    }
    expect(parsed).toBeGreaterThan(1500) // most mutations keep the header
    expect(rejected).toBeGreaterThan(0)
    expect(performance.now() - t0).toBeLessThan(60_000)
  }, 120_000)

  it('survives very deep nesting without recursion limits or quadratic time', () => {
    const depth = 200_000
    const lines = ['SyncTeX Version:1', 'Input:1:/src/main.tex', 'Unit:1', 'Content:', '{1']
    for (let i = 0; i < depth; i++) lines.push(i % 2 ? `[1,${i}:0,1000000:1000000,1000000,0` : `(1,${i}:0,1000000:1000000,1000000,0`)
    lines.push('x1,5:10,999999', 'g1,6:20,999999')
    for (let i = 0; i < depth; i++) lines.push(i % 2 ? ']' : ')')
    lines.push('}1')
    const t0 = performance.now()
    const ix = parseSynctex(lines.join('\n'))
    expect(ix.depth[ix.count - 1]).toBe(depth)
    expect(edit(ix, { page: 1, x: 0.2, y: 15 })).not.toBeNull()
    expect(edit(ix, { page: 1, x: 5000, y: 5000 })).not.toBeNull()
    expect(view(ix, { path: 'main.tex', line: 5 }).length).toBeGreaterThan(0)
    expect(performance.now() - t0).toBeLessThan(20_000)
  }, 60_000)

  it('handles one page with very many lines and one source line with very many records', () => {
    const lines = ['SyncTeX Version:1', 'Input:1:/src/main.tex', 'Unit:65781.76', 'Content:', '{1', '[1,1:0,10000:600,10000,0']
    for (let i = 0; i < 60_000; i++) lines.push(`(1,1:0,${i}:600,1,0`, `x1,2:${i % 600},${i}`, `k1,2:${(i % 600) + 1},${i}:1`, ')')
    lines.push(']', '}1')
    const ix = parseSynctex(lines.join('\n'))
    const t0 = performance.now()
    expect(view(ix, { path: 'main.tex', line: 2 }).length).toBeGreaterThan(0)
    expect(edit(ix, { page: 1, x: 300, y: 3000.5 })?.line).toBe(2)
    expect(edit(ix, { page: 1, x: -100, y: -100 })?.line).toBe(2)
    expect(performance.now() - t0).toBeLessThan(10_000)
  }, 60_000)

  it('rejects binary garbage and gzip bytes with SynctexError', () => {
    const gz = readFileSync(synctexGzPath(CASES[0]!)).toString('latin1')
    for (const t of [gz, '\u0000'.repeat(1000), 'SyncTeX Versio']) {
      expect(() => parseSynctex(t)).toThrow(SynctexError)
    }
    // a header and nothing else is a valid, empty index
    const empty = parseSynctex('SyncTeX Version:1')
    expect(empty.count).toBe(0)
    expect(view(empty, { path: 'x.tex', line: 1 })).toEqual([])
    expect(edit(empty, { page: 1, x: 1, y: 1 })).toBeNull()
  })
})
