#!/usr/bin/env node
// Stand-in for latexmk in tests (no TeX needed). Invoked exactly like latexmk:
//   fake-latexmk.mjs -norc -pdf -interaction=nonstopmode ... -jobname=output -outdir=<dir> <main.tex>
// Behaviour is driven by "%FAKE:" directives in the main file:
//   %FAKE: sleep      never finish (tests the timeout; also starts a grandchild that sleeps)
//   %FAKE: fail       write a log and exit 12 without a pdf
//   %FAKE: failpdf    write a pdf AND exit 12 (a partial build)
//   %FAKE: biglog N   write N bytes of log lines
//   %FAKE: latin1log N  write N bytes of log lines in latin-1 (not valid UTF-8), and a pdf
//   %FAKE: fill N     write N files of 1 MiB into the out dir, then succeed
//   %FAKE: fillhang N write N files of 1 MiB into the out dir, then never finish
//   %FAKE: hold N     hold out/hold.lock for N ms (exclusive create; a second concurrent run logs OVERLAP)
// The sleep directive writes the grandchild's pid to <outdir>/grandchild.pid.
// \input{x} and \include{x} must resolve to existing files (relative to cwd); \include writes <outdir>/x.aux.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const args = process.argv.slice(2)
const log = []
const fail = (msg, code = 12) => { process.stderr.write(msg + '\n'); process.exit(code) }

if (args[0] !== '-norc') fail('fake-latexmk: -norc must be the first option', 2)
const engine = args[1]
if (!['-pdf', '-pdfxe', '-pdflua'].includes(engine)) fail(`fake-latexmk: bad engine flag ${engine}`, 2)
const outArg = args.find(a => a.startsWith('-outdir='))
const jobArg = args.find(a => a.startsWith('-jobname='))
if (!outArg || jobArg !== '-jobname=output') fail('fake-latexmk: missing -outdir / -jobname=output', 2)
const outdir = outArg.slice('-outdir='.length)
const main = args[args.length - 1]
if (!existsSync(main)) fail(`fake-latexmk: main file ${main} not found`, 11)
const src = readFileSync(main, 'utf8')

log.push('This is FakeTeX, Version 3.141592653 (fake latexmk for tests)')
log.push(`engine=${engine} main=${main}`)
log.push(`env openin_any=${process.env.openin_any} openout_any=${process.env.openout_any} shell_escape=${process.env.shell_escape}`)
log.push(`env HOME=${process.env.HOME} TMPDIR=${process.env.TMPDIR} TEXMFVAR=${process.env.TEXMFVAR}`)

let exit = 0
for (const m of src.matchAll(/\\(input|include)\{([^}]+)\}/g)) {
  const name = m[2].endsWith('.tex') ? m[2] : `${m[2]}.tex`
  if (!existsSync(name)) {
    log.push(`./${main}:1: LaTeX Error: File \`${name}' not found.`)
    exit = 12
    continue
  }
  log.push(`(./${name} ${readFileSync(name, 'utf8').trim()})`)
  if (m[1] === 'include') writeFileSync(join(outdir, `${m[2]}.aux`), '\\relax\n')
}

const directive = (name) => new RegExp(`^%FAKE: ${name}(?: (\\d+))?$`, 'm').exec(src)

const fill = directive('fill') ?? directive('fillhang')
if (fill) {
  const mb = Buffer.alloc(1024 * 1024, 0x61)
  for (let i = 0; i < Number(fill[1]); i++) writeFileSync(join(outdir, `fill-${i}.dat`), mb)
}
const hold = directive('hold')
if (hold) {
  const lock = join(outdir, 'hold.lock')
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
    await new Promise(r => setTimeout(r, Number(hold[1])))
    rmSync(lock)
  } catch {
    log.push('OVERLAP: another run holds the lock')
    exit = 12
  }
}

if (directive('sleep') || directive('fillhang')) {
  writeFileSync(join(outdir, 'output.log'), log.join('\n') + '\nsleeping forever\n')
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(join(outdir, 'grandchild.pid'), String(g.pid))
  setInterval(() => {}, 1000)
} else if (directive('latin1log')) {
  const n = Number(directive('latin1log')[1])
  const line = Buffer.from('Overfull \\hbox in caf\xe9 \xe0 la cr\xe8me ' + '\xe9'.repeat(40) + '\n', 'latin1')
  const body = Buffer.concat(Array.from({ length: Math.ceil(n / line.length) }, () => line)).subarray(0, n)
  writeFileSync(join(outdir, 'output.log'), Buffer.concat([Buffer.from(log.join('\n') + '\n'), body, Buffer.from('\nEND-OF-LATIN1-LOG\n')]))
  writeFileSync(join(outdir, 'output.pdf'), `%PDF-1.5\n% fake\n%%EOF\n`)
  process.exit(0)
} else {
  const big = directive('biglog')
  if (big) {
    const n = Number(big[1])
    const line = 'Overfull \\hbox (badness 10000) in paragraph at lines 1--2 ................................\n'
    log.push(line.repeat(Math.ceil(n / line.length)).slice(0, n))
    log.push('END-OF-BIG-LOG')
  }
  if (directive('fail')) exit = 12
  log.push(exit === 0 ? 'Output written on output.pdf (1 page).' : '! Emergency stop.')
  writeFileSync(join(outdir, 'output.log'), log.join('\n') + '\n')
  if (exit === 0 || directive('failpdf')) {
    writeFileSync(join(outdir, 'output.pdf'), `%PDF-1.5\n% fake\n${src}\n%%EOF\n`)
    writeFileSync(join(outdir, 'output.synctex.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]))
  }
  if (directive('failpdf')) exit = 12
  process.exit(exit)
}
