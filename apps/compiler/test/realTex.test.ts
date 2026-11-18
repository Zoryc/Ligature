// Runs only where a real latexmk is installed (e.g. inside the compiler image); skipped otherwise.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compile, startTestWorker, type TestWorker } from './harness.ts'

const hasLatexmk = (process.platform === 'win32'
  ? spawnSync('latexmk -v', { stdio: 'ignore', shell: true })
  : spawnSync('latexmk', ['-v'], { stdio: 'ignore' })).status === 0

describe.skipIf(!hasLatexmk)('real latexmk', () => {
  let t: TestWorker
  beforeAll(async () => { t = await startTestWorker({ latexmk: ['latexmk'] }) })
  afterAll(async () => { await t?.w.close() })

  it('compiles a small document with \\include into a PDF', async () => {
    const r = await compile(t.base, randomUUID(), {
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello.\n\\include{chapters/one}\n\\end{document}\n',
      'chapters/one.tex': 'Chapter one.\n',
    }, { timeoutMs: 120_000 })
    expect(r.json.status).toBe('success')
    expect(r.json.outputs).toContain('output.pdf')
    expect(r.json.outputs).toContain('output.synctex.gz')
  }, 180_000)

  // The document itself reports whether \openin got the file, so a refusal is told apart from a
  // file that was read but failed to typeset (which `status !== 'success'` alone could not).
  it('reading /etc/passwd is refused by openin_any=p', async () => {
    const r = await compile(t.base, randomUUID(), {
      'main.tex': '\\documentclass{article}\n\\newread\\probe\n\\immediate\\openin\\probe=/etc/passwd\n' +
        '\\ifeof\\probe\\typeout{LIGATURE-PROBE: refused}\\else\\typeout{LIGATURE-PROBE: was read}\\fi\n' +
        '\\begin{document}\nx\n\\end{document}\n',
    }, { timeoutMs: 120_000 })
    expect(r.json.status).toBe('success')
    expect(r.json.log).toContain('LIGATURE-PROBE: refused')
    expect(r.json.log).not.toContain('LIGATURE-PROBE: was read')
  }, 180_000)

  // -outdir is absolute and openout_any=p refuses absolute paths outside TEXMFOUTPUT: bibtex and
  // makeindex must still be able to write into out/.
  it('runs bibtex into out/', async () => {
    const id = randomUUID()
    const r = await compile(t.base, id, {
      'main.tex': '\\documentclass{article}\n\\begin{document}\nSee \\cite{knuth}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n',
      'refs.bib': '@book{knuth, author = {Donald E. Knuth}, title = {The {\\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}\n',
    }, { timeoutMs: 120_000 })
    expect(r.json.status).toBe('success')
    expect(existsSync(join(t.buildsDir, id, 'out', 'output.bbl'))).toBe(true)
    expect(r.json.log).not.toMatch(/Citation `knuth' .*undefined/)
  }, 180_000)

  it('runs makeindex into out/', async () => {
    const id = randomUUID()
    const r = await compile(t.base, id, {
      'main.tex': '\\documentclass{article}\n\\usepackage{makeidx}\n\\makeindex\n\\begin{document}\nWord\\index{word}.\n\\printindex\n\\end{document}\n',
    }, { timeoutMs: 120_000 })
    expect(r.json.status).toBe('success')
    expect(existsSync(join(t.buildsDir, id, 'out', 'output.ind'))).toBe(true)
  }, 180_000)

  it('a log full of 8-bit characters stays within the cap', async () => {
    const r = await compile(t.base, randomUUID(), {
      'main.tex': '\\documentclass{article}\n\\begin{document}\n\\count255=0\n' +
        '\\loop\\ifnum\\count255<40000 \\message{^^e9^^e8^^e0^^e9^^e8^^e0^^e9^^e8^^e0^^e9^^e8^^e0}\\advance\\count255 by 1 \\repeat\n' +
        'x\n\\end{document}\n',
    }, { timeoutMs: 120_000 })
    expect(r.json.status).toBe('success')
    expect(r.json.outputs).toContain('output.pdf')
    expect(Buffer.byteLength(r.json.log)).toBeLessThanOrEqual(2 * 1024 * 1024 + 64 * 1024)
  }, 180_000)
})
