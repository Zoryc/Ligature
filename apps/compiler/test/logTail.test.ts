import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capTail, CONSOLE_TAIL_END, CONSOLE_TAIL_START, fitUtf8Tail, readTail, reportedLog, TailBuffer } from '../src/logTail.ts'

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i).padStart(6, '0')}\n`).join('')

describe('log tail cap', () => {
  it('leaves small logs alone', () => {
    expect(capTail(Buffer.from('hello\n'), 100)).toBe('hello\n')
  })

  it('keeps the end, starts on a whole line, stays within the cap', () => {
    const text = lines(100_000) // 1.3 MB
    const max = 64 * 1024
    const out = capTail(Buffer.from(text), max)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(max)
    expect(out.startsWith('[ligature: log truncated')).toBe(true)
    expect(out.endsWith('line 099999\n')).toBe(true)
    expect(out.split('\n')[1]).toMatch(/^line \d{6}$/)
  })

  it('readTail reads only the tail of a big file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ligature-tail-'))
    const p = join(dir, 'output.log')
    writeFileSync(p, lines(300_000)) // ~3.9 MB
    const out = (await readTail(p, 2 * 1024 * 1024))!
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(out.endsWith('line 299999\n')).toBe(true)
    expect(out).toMatch(/^\[ligature: log truncated, showing the last \d+ of \d+ bytes\]\nline \d{6}\n/)
    expect(await readTail(join(dir, 'nope.log'), 100)).toBeNull()
    writeFileSync(p, 'short\n')
    expect(await readTail(p, 100)).toBe('short\n')
  })

  it('a log that is not valid UTF-8 still fits the cap after decoding (U+FFFD is 3 bytes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ligature-tail-'))
    const p = join(dir, 'output.log')
    const max = 2 * 1024 * 1024
    // 1.5 MB of latin-1 text: under the cap as bytes, about 3.3 MB once decoded
    const line = Buffer.from('caf\xe9 \xe0 la cr\xe8me ' + '\xe9'.repeat(60) + '\n', 'latin1')
    writeFileSync(p, Buffer.concat([...Array.from({ length: Math.ceil(1.5 * 1024 * 1024 / line.length) }, () => line), Buffer.from('THE END\n')]))
    const out = (await readTail(p, max))!
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(max)
    expect(out.startsWith('[ligature: log truncated')).toBe(true)
    expect(out.endsWith('THE END\n')).toBe(true)
    // and the bigger-than-the-cap path
    writeFileSync(p, Buffer.concat([...Array.from({ length: Math.ceil(5 * 1024 * 1024 / line.length) }, () => line), Buffer.from('THE END\n')]))
    const out2 = (await readTail(p, max))!
    expect(Buffer.byteLength(out2)).toBeLessThanOrEqual(max)
    expect(out2.endsWith('THE END\n')).toBe(true)
    // capTail and TailBuffer take the same care
    expect(Buffer.byteLength(capTail(Buffer.alloc(1000, 0xe9), 1000))).toBeLessThanOrEqual(1000)
    const t = new TailBuffer(1000)
    t.push(Buffer.alloc(900, 0xff))
    expect(Buffer.byteLength(t.text())).toBeLessThanOrEqual(1000)
  })

  it('fitUtf8Tail cuts on a character boundary', () => {
    expect(fitUtf8Tail('abc', 10)).toBe('abc')
    expect(fitUtf8Tail('aé€😀', 4)).toBe('😀')
    expect(fitUtf8Tail('aé€😀', 7)).toBe('€😀')
    expect(fitUtf8Tail('aé€😀', 6)).toBe('😀')
    expect(fitUtf8Tail('x', 0)).toBe('')
  })

  it('TailBuffer keeps a bounded tail of streamed chunks', () => {
    const t = new TailBuffer(1000)
    for (let i = 0; i < 500; i++) t.push(Buffer.from(`chunk ${i}\n`))
    const out = t.text()
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1000)
    expect(out.endsWith('chunk 499\n')).toBe(true)
    const small = new TailBuffer(1000)
    small.push(Buffer.from('a'))
    small.push(Buffer.from('b'))
    expect(small.text()).toBe('ab')
  })
})

describe('reported log', () => {
  const TEX_LOG = '(./main.tex\nLaTeX Warning: There were undefined references.\n)\n'
  const CONSOLE = 'Latexmk: applying rule biber\nERROR - BibTeX subsystem: refs.bib_1.utf8, line 3, syntax error\n'

  it('without out/output.log the console is the log', () => {
    expect(reportedLog(null, CONSOLE, true, 1000)).toBe(CONSOLE)
  })

  it('a successful build, or a failed one whose TeX log shows an error, reports the TeX log alone', () => {
    expect(reportedLog(TEX_LOG, CONSOLE, false, 1000)).toBe(TEX_LOG)
    for (const err of ['! Undefined control sequence.', './main.tex:4: Undefined control sequence.',
      'chapters/a b.tex:12: LaTeX Error: x', '[\\directlua]:1: boom\nstack traceback:']) {
      const log = `${TEX_LOG}${err}\n`
      expect(reportedLog(log, CONSOLE, true, 1000)).toBe(log)
    }
  })

  it('a failed build whose TeX log shows no error gets the console between marker lines', () => {
    const out = reportedLog(TEX_LOG.trimEnd(), CONSOLE, true, 1000)
    expect(out).toBe(`${TEX_LOG}${CONSOLE_TAIL_START}\n${CONSOLE}${CONSOLE_TAIL_END}\n`)
    // an indented "x.tex:1: " or a word with a colon is not an error line
    expect(reportedLog(`${TEX_LOG}  ./a.tex:1: x\nNote: 1: y\n`, CONSOLE, true, 1000)).toContain(CONSOLE_TAIL_START)
    expect(reportedLog(TEX_LOG, '  \n', true, 1000)).toBe(TEX_LOG) // nothing to add
  })

  it('only the tail of a long console, from a whole line, within the cap', () => {
    const console = lines(10_000)
    const out = reportedLog(TEX_LOG, console, true, 4096)
    const tail = out.slice(out.indexOf(CONSOLE_TAIL_START) + CONSOLE_TAIL_START.length + 1, out.indexOf(CONSOLE_TAIL_END))
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096)
    expect(tail.split('\n')[0]).toMatch(/^line \d{6}$/)
    expect(tail.endsWith('line 009999\n')).toBe(true)
  })
})
