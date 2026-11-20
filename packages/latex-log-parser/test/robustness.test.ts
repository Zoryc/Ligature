/** Garbage, hostile and huge inputs: the parser must never throw, and must stay fast. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAX_DIAGNOSTICS, parseLatexLog, type ParsedDiagnostic } from '../src/index.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const TWO_MB = 2 * 1024 * 1024
/**
 * These budgets catch super-linear behaviour (a regex that backtracks, a quadratic file stack), not slow
 * machines: shared CI runners are ~2-3x slower than a desktop, so the budgets scale there.
 */
const SLOWDOWN = process.env.CI ? 3 : 1
const BUDGET_MS = 200 * SLOWDOWN
const LINEAR_BUDGET_MS = 1000 * SLOWDOWN

const realLogs: string[] = readdirSync(FIXTURES)
  .filter(n => statSync(join(FIXTURES, n)).isDirectory())
  .flatMap(c => readdirSync(join(FIXTURES, c)).filter(f => f.endsWith('.log')).map(f => readFileSync(join(FIXTURES, c, f), 'utf8')))

/** Deterministic PRNG (mulberry32), so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function checkShape(out: ParsedDiagnostic[]): void {
  expect(out.length).toBeLessThanOrEqual(MAX_DIAGNOSTICS)
  let lastRank = 0
  const rank = { error: 0, warning: 1, info: 2 }
  for (const d of out) {
    expect(['error', 'warning', 'info']).toContain(d.severity)
    expect(rank[d.severity]).toBeGreaterThanOrEqual(lastRank)
    lastRank = rank[d.severity]
    expect(typeof d.kind).toBe('string')
    expect(typeof d.message).toBe('string')
    if (d.path !== undefined) {
      expect(d.path).not.toMatch(/^(?:\/|[A-Za-z]:\/|\.\.?\/)/)
      expect(d.path).not.toBe('')
    }
    if (d.line !== undefined) expect(Number.isSafeInteger(d.line) && d.line > 0).toBe(true)
    if (d.endLine !== undefined) expect(d.line !== undefined && d.endLine >= d.line).toBe(true)
    if (d.raw !== undefined) expect(d.raw.length).toBeLessThanOrEqual(1000)
  }
}

/** Best of a few runs (after a warm-up), so a busy CI machine does not make the timing flaky. */
function timed(log: string): { ms: number; out: ParsedDiagnostic[] } {
  parseLatexLog(log, { rootDir: '/srv/ligature builds/b1/src' })
  let best = Infinity
  let out: ParsedDiagnostic[] = []
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now()
    out = parseLatexLog(log, { rootDir: '/srv/ligature builds/b1/src' })
    best = Math.min(best, performance.now() - t0)
  }
  return { ms: best, out }
}

function repeatTo(chunk: string, bytes: number): string {
  return chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes)
}

describe('random garbage never crashes', () => {
  const ALPHABET = ['(', ')', '(', ')', '"', '.', '/', '\\', ':', '!', ' ', '\n', '\n', 'l.', '1', '23', 'tex', 'a', 'Z', '-', '[', ']',
    '{', '}', '<', '>', '*', '\t', '\r', 'é', '\u0000', '�', './main.tex', '/usr/x.sty', ':12: ', '! ', 'LaTeX Warning: ',
    'Package p Warning: ', '(p) ', 'Overfull \\hbox (', ' in paragraph at lines ', '--', 'Warning--', '---line ', ' of file ',
    'This is BibTeX', 'WARN - ', 'on input line ', '<*>', '*** (', '[ligature: ']
  it('2000 random logs', () => {
    const r = rng(1)
    for (let n = 0; n < 2000; n++) {
      const len = Math.floor(r() * 400)
      let s = ''
      for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(r() * ALPHABET.length)]!
      checkShape(parseLatexLog(s, r() < 0.5 ? {} : { rootDir: r() < 0.5 ? '/' : '/srv/ligature builds/b1/src' }))
    }
  })

  it('random bytes', () => {
    const r = rng(2)
    for (let n = 0; n < 300; n++) {
      const len = Math.floor(r() * 3000)
      let s = ''
      for (let k = 0; k < len; k++) s += String.fromCharCode(Math.floor(r() * 0x2000))
      checkShape(parseLatexLog(s))
    }
  })

  it('mutated real logs (lines dropped, duplicated, parentheses inserted and removed)', () => {
    const r = rng(3)
    for (let n = 0; n < 300; n++) {
      const lines = realLogs[n % realLogs.length]!.split('\n')
      for (let k = 0; k < 20; k++) {
        const at = Math.floor(r() * lines.length)
        const op = Math.floor(r() * 5)
        if (op === 0) lines.splice(at, 1)
        else if (op === 1) lines.splice(at, 0, lines[Math.floor(r() * lines.length)] ?? '')
        else if (op === 2) lines[at] = (lines[at] ?? '') + ')'.repeat(1 + Math.floor(r() * 3))
        else if (op === 3) lines[at] = '(' + (lines[at] ?? '')
        else lines[at] = (lines[at] ?? '').replace(/[()]/g, '')
      }
      checkShape(parseLatexLog(lines.join('\n'), { rootDir: '/srv/ligature builds/b1/src' }))
    }
  })
})

describe('unbalanced parentheses', () => {
  it('many more ( than ): no crash, attribution falls back to project files', () => {
    const log = `(./main.tex\n${'('.repeat(100_000)}\n\nLaTeX Warning: Deep on input line 3.\n\n`
    const out = parseLatexLog(log)
    checkShape(out)
    expect(out).toEqual([expect.objectContaining({ message: 'Deep.', path: 'main.tex' })])
  })

  it('many more ) than (: no crash, later files are still tracked', () => {
    const log = `(./main.tex\n${')'.repeat(100_000)}\n(./b.tex\n\nLaTeX Warning: In b on input line 2.\n\n)`
    expect(parseLatexLog(log)).toEqual([expect.objectContaining({ message: 'In b.', path: 'b.tex', line: 2 })])
  })

  it('interleaved and nested garbage around real messages', () => {
    const log = ['(./main.tex ((( (Font) ) ((', ')) ) ) ) ) ) ) (./a.tex (x', '', 'LaTeX Warning: Here on input line 5.', ''].join('\n')
    const out = parseLatexLog(log)
    checkShape(out)
    expect(out).toHaveLength(1)
  })
})

describe('huge logs parse quickly', () => {
  it(`a 2 MB log made of real logs in < ${BUDGET_MS} ms`, () => {
    const log = repeatTo(realLogs.join('\n'), TWO_MB)
    const { ms, out } = timed(log)
    checkShape(out)
    expect(out.length).toBeGreaterThan(10)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it.each([
    ['one 2 MB line of (', '('],
    ['one 2 MB line of )', ')'],
    ['one 2 MB line of (./a', '(./a'],
    ['(./ followed by dots and spaces', '(./' + 'a.b '.repeat(300)],
    ['quoted names without closing quote', '("./x'],
    ['names with parentheses lookalikes', '(./a (b) '],
    ['names with unclosed inner parentheses', '(./a ('],
    ['dots only after (', '(' + '.'.repeat(1500)],
    ['a long name with many extensions', '(/' + 'x.tex '.repeat(250)],
    ['colons and digits (file:line lookalikes)', 'a:1:b:2:'],
    // every `! ` error scans ahead for its context, testing each following line for an error start
    ['errors among file:line lookalikes', '! x\n' + 'y:1: z\n'.repeat(59)],
    ['errors among dotted file:line lookalikes', '! x\n' + 'a.b:1x a.b:2x c:4: d:5: e\n'.repeat(59)],
    ['identical errors (dense)', '! Undefined control sequence.\nl.1 \\x\n    \n\n'],
    ['identical warnings (dense)', 'LaTeX Warning: Reference `x\' on page 1 undefined on input line 3.\n\n'],
    ['identical bad boxes (dense)', 'Overfull \\hbox (1.0pt too wide) in paragraph at lines 1--2\n[]\\OT1/cmr/m/n/10 x\n []\n\n'],
    ['warnings with endless continuation lines', 'Package p Warning: x\n(p) y\n'],
    ['bad boxes with endless contents', 'Overfull \\hbox (1pt too wide) in paragraph at lines 1--2\n[]\\x (\n'],
    ['bibtex lines', 'This is BibTeX\nx\n---line 1 of file a.bib\n'],
    ['context lookalikes', '! E.\n<argument> (\nl.1 (\n'],
    // a Lua error scans ahead for its context like a TeX error
    ['Lua errors without context', '))[string "(":1: x\nstack traceback:\n'],
    ['Lua errors with context', 'a.lua:1: x\nstack traceback:\n\t[C]: in ?\nl.1 \\x\n\n'],
    ['empty lines', '\n'],
    ['CR only', 'a\r'],
  ])(`%s: < ${BUDGET_MS} ms`, (_name, chunk) => {
    const { ms, out } = timed(repeatTo(chunk, TWO_MB))
    checkShape(out)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it.each([
    ['[string " openers', '[string "a'],
    ['bare chunk names without a line number', ' a:b'],
    [')-separated chunk name lookalikes', ')x.lua:'],
  ])(`one 2 MB Lua error line of %s: < ${BUDGET_MS} ms`, (_name, chunk) => {
    const { ms, out } = timed(`${repeatTo(chunk, TWO_MB)}\nstack traceback:\n`)
    checkShape(out)
    expect(out).toHaveLength(1)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it(`2 MB of distinct errors (all different lines): < ${BUDGET_MS} ms, capped, errors only`, () => {
    let log = ''
    for (let k = 1; log.length < TWO_MB; k++) log += `./main.tex:${k}: Undefined control sequence.\nl.${k} \\nope\n    \n\n`
    const { ms, out } = timed(log)
    checkShape(out)
    expect(out).toHaveLength(MAX_DIAGNOSTICS)
    expect(out[0]).toEqual(expect.objectContaining({ message: 'Undefined control sequence \\nope', path: 'main.tex', line: 1 }))
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  // Not a log TeX can write (it stops after 100 errors in one paragraph, and every error has context lines),
  // so it gets a looser budget: the point is that it stays linear.
  it(`the densest possible error flood (half a million one-line errors) stays linear: < ${LINEAR_BUDGET_MS} ms`, () => {
    const { ms, out } = timed(repeatTo('! x\n', TWO_MB))
    checkShape(out)
    expect(ms).toBeLessThan(LINEAR_BUDGET_MS)
  })

  it(`a file:line error on every line (no context, not a log TeX can write) stays linear: < ${LINEAR_BUDGET_MS} ms`, () => {
    const { ms, out } = timed(repeatTo('./a.tex:1: z\n', TWO_MB))
    checkShape(out)
    expect(out).toEqual([expect.objectContaining({ kind: 'tex', message: 'z', path: 'a.tex', line: 1 })])
    expect(ms).toBeLessThan(LINEAR_BUDGET_MS)
  })
})
