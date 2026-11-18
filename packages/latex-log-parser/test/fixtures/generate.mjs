#!/usr/bin/env node
/**
 * Regenerates the fixture logs with real TeX (latexmk + pdfTeX/XeTeX/LuaTeX on PATH).
 *
 *   node test/fixtures/generate.mjs [case ...]
 *
 * Every sub-folder of test/fixtures holding a main.tex is one case. For each engine the case's sources are copied
 * into a fresh build dir laid out like the compiler's (`<root>/src`, `<root>/out`, sub-folders mirrored into out/),
 * then latexmk runs with exactly the compiler's argv and log-related environment (apps/compiler/src/latexmk.ts):
 *
 *   latexmk -norc -<pdf|pdfxe|pdflua> -interaction=nonstopmode -file-line-error -synctex=1 -jobname=output
 *           -outdir=<abs out dir> main.tex
 *   env: max_print_line=10000 error_line=254 half_error_line=238
 *
 * out/output.log is written to `<case>/<engine>.log`; for the cases in CONSOLE_CASES latexmk's own console output
 * (which echoes BibTeX and every TeX pass) goes to `<case>/<engine>.console.log`.
 *
 * Machine-specific paths are rewritten so the committed logs are reproducible and contain no personal data:
 * the build root becomes BUILD_ROOT (it contains a space on purpose: TeX then quotes the out-dir file names),
 * the TeX distribution root becomes TEXLIVE_ROOT, the home directory becomes /home/user.
 *
 * Expected outputs are not written here: run `LOG_PARSER_UPDATE=1 npx vitest run` and review every diff by hand.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUILD_ROOT = '/srv/ligature builds/b1'
export const TEXLIVE_ROOT = '/usr/local/texlive/2026'
const ENGINES = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' }
const CONSOLE_CASES = new Set(['bibtex', 'bibtex-warn', 'errors'])
const here = dirname(fileURLToPath(import.meta.url))

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'latin1', windowsHide: true, timeout: 600_000, ...opts })
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`)
  return r
}

/** A case-insensitive regex for an absolute path, matching either slash direction. */
function pathRegex(p) {
  const parts = p.split(/[\\/]+/).filter(Boolean).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const lead = /^[\\/]/.test(p) ? '[\\\\/]' : ''
  return new RegExp(lead + parts.join('[\\\\/]+'), 'gi')
}

function sanitize(text, buildRoot, texRoot) {
  let out = text.replace(pathRegex(buildRoot), BUILD_ROOT)
  if (texRoot) out = out.replace(pathRegex(texRoot), TEXLIVE_ROOT)
  out = out.replace(pathRegex(homedir()), '/home/user')
  out = out.replace(/\r\n/g, '\n')
  // TinyTeX's Windows .exe wrapper reports latexmk's exit status itself; that is not latexmk output.
  out = out.replace(/^.*runscript\.tlu:\d+: command failed with exit code \d+:\n(?:perl(?:\.exe)? .*\n)?/gm, '')
  const user = userInfo().username
  // what is left (e.g. "...\<user>\AppData\..." shortened by the Windows runscript wrapper)
  if (user.length > 2) out = out.replace(new RegExp(`(?<=[\\\\/])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\\\/])`, 'gi'), 'user')
  if (user.length > 2 && out.toLowerCase().includes(user.toLowerCase())) {
    const line = out.split('\n').find(l => l.toLowerCase().includes(user.toLowerCase()))
    throw new Error(`sanitized log still contains the user name; extend sanitize():\n${line}`)
  }
  return out
}

function sourceFiles(dir, base = dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files.push(...sourceFiles(p, base))
    else if (!/\.(log|json)$/.test(name)) files.push(relative(base, p))
  }
  return files
}

function texRoot() {
  const r = run('kpsewhich', ['-var-value=SELFAUTOPARENT'])
  const v = r.stdout.trim()
  return v === '' ? null : v
}

function generate(caseName, tex) {
  const caseDir = join(here, caseName)
  for (const [engine, flag] of Object.entries(ENGINES)) {
    const root = mkdtempSync(join(tmpdir(), 'ligature logfix '))
    try {
      const src = join(root, 'src')
      const out = join(root, 'out')
      mkdirSync(src)
      mkdirSync(out)
      for (const f of sourceFiles(caseDir)) {
        mkdirSync(dirname(join(src, f)), { recursive: true })
        mkdirSync(dirname(join(out, f)), { recursive: true }) // the compiler mirrors source folders into out/
        cpSync(join(caseDir, f), join(src, f))
      }
      const args = ['-norc', flag, '-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-jobname=output',
        `-outdir=${out}`, 'main.tex']
      const env = {
        ...process.env,
        TEXMFOUTPUT: out, openin_any: 'p', openout_any: 'p', shell_escape: 'f',
        max_print_line: '10000', error_line: '254', half_error_line: '238',
      }
      const r = run('latexmk', args, { cwd: src, env })
      const log = readFileSync(join(out, 'output.log'), 'latin1')
      writeFileSync(join(caseDir, `${engine}.log`), sanitize(log, root, tex), 'latin1')
      if (CONSOLE_CASES.has(caseName)) {
        writeFileSync(join(caseDir, `${engine}.console.log`), sanitize(r.stdout + r.stderr, root, tex), 'latin1')
      }
      console.log(`${caseName}/${engine}: latexmk exit ${r.status}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

const wanted = process.argv.slice(2)
const cases = readdirSync(here).filter(n => statSync(join(here, n)).isDirectory() && sourceFiles(join(here, n)).includes('main.tex'))
const tex = texRoot()
for (const c of cases) if (wanted.length === 0 || wanted.includes(c)) generate(c, tex)
