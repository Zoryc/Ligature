/**
 * Oracle helpers: compile the fixture documents with real TeX, ask the `synctex` command-line tool, and
 * compare its answers with ours. Used by `generate-fixtures.ts` (records the answers into JSON) and by
 * `live.test.ts` (compares live when TeX and synctex are installed).
 */
import { execFile, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import type { PdfRect } from '@ligature/shared'
import { normalizePath } from '../src/paths.ts'
import { Kind, type SynctexIndex } from '../src/types.ts'
import { recordBox } from '../src/geometry.ts'
import type { EditResult } from '../src/edit.ts'

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
export const DOCS = join(FIXTURES, 'docs')

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex'
export const ENGINES: Engine[] = ['pdflatex', 'xelatex', 'lualatex']
export const DOC_NAMES = ['multifile', 'twocolumn', 'figure', 'longpar'] as const
export interface Case { doc: string; engine: Engine; name: string }
export const CASES: Case[] = DOC_NAMES.flatMap((doc) => ENGINES.map((engine) => ({ doc, engine, name: `${doc}-${engine}` })))

/** Where the committed fixtures pretend the build ran (like the server's build dirs). */
export const FAKE_SRC = '/build/src'

const ENGINE_FLAG: Record<Engine, string> = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' }

export const isWindows = process.platform === 'win32'
/** `synctex help` exits with a non-zero status, so "installed" means "could be started". */
export const hasSynctexCli = (): boolean => {
  const r = spawnSync('synctex', ['help'], { stdio: 'ignore' })
  return !r.error && r.status !== null
}
export const hasLatexmk = (): boolean => spawnSync('latexmk', ['-v'], { stdio: 'ignore' }).status === 0

/** Every file of a fixture document, relative to its directory, `/`-separated. */
export function docFiles(doc: string): string[] {
  const root = join(DOCS, doc)
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(root, p).split('\\').join('/'))
    }
  }
  walk(root)
  return out.sort()
}

export interface Compiled { srcDir: string; outDir: string; pdf: string; synctexText: string }

/** Compiles a fixture document into `workDir/src` + `workDir/out` the way the compiler worker does. */
export function compileCase(c: Case, workDir: string): Compiled {
  const srcDir = join(workDir, 'src')
  const outDir = join(workDir, 'out')
  mkdirSync(outDir, { recursive: true })
  cpSync(join(DOCS, c.doc), srcDir, { recursive: true })
  const r = spawnSync('latexmk', ['-norc', ENGINE_FLAG[c.engine], '-interaction=nonstopmode', '-file-line-error',
    '-synctex=1', '-jobname=output', `-outdir=${outDir}`, 'main.tex'], { cwd: srcDir, encoding: 'utf8', timeout: 300_000 })
  const pdf = join(outDir, 'output.pdf')
  let gz: Buffer
  try {
    gz = readFileSync(join(outDir, 'output.synctex.gz'))
  } catch {
    throw new Error(`${c.name}: no synctex output (latexmk status ${r.status})\n${r.stdout}\n${r.stderr}`)
  }
  return { srcDir, outDir, pdf, synctexText: gunzipSync(gz).toString('utf8') }
}

// ------------------------------------------------------------------------------------------- CLI

const exec = (args: string[], cwd: string): Promise<string> => new Promise((resolve) => {
  execFile('synctex', args, { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true }, (_err, stdout) => resolve(stdout ?? ''))
})

function blocks(out: string): Map<string, string>[] {
  const res: Map<string, string>[] = []
  let cur: Map<string, string> | null = null
  for (const raw of out.split(/\r?\n/)) {
    if (raw === 'SyncTeX result begin') cur = new Map()
    else if (raw === 'SyncTeX result end') {
      if (cur) res.push(cur)
      cur = null
    } else if (cur) {
      const i = raw.indexOf(':')
      if (i > 0 && !cur.has(raw.slice(0, i))) cur.set(raw.slice(0, i), raw.slice(i + 1))
    }
  }
  return res
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** `synctex view -i line:0:file -o pdf` -> boxes (top-left origin). */
export async function cliView(pdf: string, cwd: string, file: string, line: number): Promise<PdfRect[]> {
  const out = await exec(['view', '-i', `${line}:0:${file}`, '-o', pdf], cwd)
  return blocks(out).map((b) => {
    const num = (k: string) => Number(b.get(k))
    const W = num('W')
    const H = num('H')
    const h = num('h')
    const v = num('v')
    return { page: num('Page'), x: r3(Math.min(h, h + W)), y: r3(Math.min(v - H, v)), width: r3(Math.abs(W)), height: r3(Math.abs(H)) }
  }).filter((r) => Number.isFinite(r.page) && Number.isFinite(r.x) && Number.isFinite(r.y))
}

export interface CliEdit { file: string; line: number; column: number }

/** `synctex edit -o page:x:y:pdf` -> results, files mapped with `mapPath`. */
export async function cliEdit(pdf: string, cwd: string, page: number, x: number, y: number,
  mapPath: (p: string) => string): Promise<CliEdit[]> {
  const out = await exec(['edit', '-o', `${page}:${x}:${y}:${pdf}`], cwd)
  return blocks(out).map((b) => ({ file: mapPath(b.get('Input') ?? ''), line: Number(b.get('Line')), column: Number(b.get('Column')) }))
}

/** Runs `fn` over `items` with at most `n` in flight, preserving order. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }))
  return out
}

// ---------------------------------------------------------------------------------------- paths

const canon = (p: string) => {
  const n = normalizePath(p)
  return isWindows ? n.toLowerCase() : n
}

/**
 * Maps a path written by TeX on this machine to its committed form: the project's src dir becomes
 * `/build/src`, the out dir `/build/out`, TeX Live files `/usr/local/texlive/2026/...`.
 */
export function makeRewriter(srcDir: string, outDir: string): (p: string) => string {
  const src = canon(srcDir)
  const out = canon(outDir)
  return (p: string) => {
    const n = normalizePath(p)
    const c = isWindows ? n.toLowerCase() : n
    if (c === src || c.startsWith(src + '/')) return FAKE_SRC + n.slice(src.length)
    if (c === out || c.startsWith(out + '/')) return '/build/out' + n.slice(out.length)
    const i = n.indexOf('/texmf-dist/')
    if (i >= 0) return '/usr/local/texlive/2026' + n.slice(i)
    const j = n.search(/\/texmf-[a-z]+\//)
    if (j >= 0) return '/usr/local/texlive/2026' + n.slice(j)
    return n
  }
}

/** A committed path -> what the oracle JSON stores: relative to the project for project files. */
export const toFixturePath = (p: string): string =>
  p.startsWith(FAKE_SRC + '/') ? p.slice(FAKE_SRC.length + 1) : p

/** Rewrites the `Input:` lines of a SyncTeX text with `rewrite`. */
export function rewriteInputs(text: string, rewrite: (p: string) => string): string {
  return text.replace(/^Input:(\d+):(.*?)(\r?)$/gm, (_m, tag: string, path: string, cr: string) => `Input:${tag}:${rewrite(path)}${cr}`)
}

// ------------------------------------------------------------------------------------- sampling

export function prng(seedText: string): () => number {
  let s = 0
  for (const ch of seedText) s = (Math.imul(s, 31) + ch.charCodeAt(0)) | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface EditSample { page: number; x: number; y: number }

/**
 * Inverse-search sample points: a jittered grid over each page (letter paper) plus points near
 * random glyph positions (so that most samples hit text).
 */
export function editSamples(ix: SynctexIndex, seed: string,
  perPage: { grid: readonly [number, number]; near: number } = { grid: [8, 10], near: 30 }): EditSample[] {
  const rnd = prng(seed)
  const r2 = (n: number) => Math.round(n * 100) / 100
  const out: EditSample[] = []
  for (let page = 1; page <= ix.pageCount; page++) {
    const [cols, rows] = perPage.grid
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        out.push({ page, x: r2(40 + (i + rnd()) * (530 / cols)), y: r2(40 + (j + rnd()) * (710 / rows)) })
      }
    }
    const glyphs: number[] = []
    for (let k = 0; k < ix.count; k++) {
      if (ix.page[k] === page && ix.kind[k] === Kind.Boundary) glyphs.push(k)
    }
    for (let k = 0; k < perPage.near && glyphs.length > 0; k++) {
      const g = glyphs[Math.floor(rnd() * glyphs.length)]!
      const x = ix.h[g]! * ix.scale + ix.xOffset + (rnd() * 16 - 4)
      const y = ix.v[g]! * ix.scale + ix.yOffset - rnd() * 7
      out.push({ page, x: r2(x), y: r2(y) })
    }
  }
  return out
}

/** Number of lines of a fixture source file. */
export const lineCount = (doc: string, file: string): number =>
  readFileSync(join(DOCS, doc, file), 'utf8').replace(/\n$/, '').split('\n').length

// ------------------------------------------------------------------------------------ agreement

/** Tolerance (PDF points) when testing boxes for overlap. */
export const OVERLAP_TOLERANCE = 2

const overlaps = (a: PdfRect, b: PdfRect, tol: number) =>
  a.page === b.page &&
  a.x - tol <= b.x + b.width && b.x - tol <= a.x + a.width &&
  a.y - tol <= b.y + b.height && b.y - tol <= a.y + a.height

/**
 * Forward agreement: both empty, or same page as the CLI's first box and at least one of our boxes
 * overlapping one of the CLI's boxes on that page (within `tol`).
 */
export function forwardAgrees(ours: PdfRect[], cli: PdfRect[], tol = OVERLAP_TOLERANCE): boolean {
  const first = cli[0]
  if (!first) return ours.length === 0
  if (ours.length === 0 || ours[0]!.page !== first.page) return false
  return ours.some((o) => cli.some((c) => overlaps(o, c, tol)))
}

/** Inverse agreement: same file and line as the CLI's first answer (both null also agrees). */
export function inverseAgrees(ours: { file: string; line: number } | null, cli: CliEdit[]): boolean {
  const first = cli[0]
  if (!first) return ours === null
  return ours !== null && ours.file === first.file && ours.line === first.line
}

export const editToFixture = (r: EditResult | null): { file: string; line: number } | null =>
  r ? { file: toFixturePath(r.path), line: r.line } : null

// --------------------------------------------------------------------------------- oracle files

export interface ViewSample { file: string; line: number; boxes: PdfRect[] }
export interface EditRecord extends EditSample { results: CliEdit[] }
export interface Oracle {
  case: string
  doc: string
  engine: Engine
  /** `synctex` CLI version line, for the record. */
  cli: string
  view: ViewSample[]
  edit: EditRecord[]
}

export const synctexGzPath = (c: Case) => join(FIXTURES, `${c.name}.synctex.gz`)
export const oraclePath = (c: Case) => join(FIXTURES, `${c.name}.oracle.json`)

/**
 * Whether a sample point lies on a line of text: inside an hbox that directly holds glyph runs, glue,
 * kerns or math. Points in margins and in the gaps between lines are ambiguous by nature.
 */
export function onText(ix: SynctexIndex, s: EditSample): boolean {
  const holders = new Set<number>()
  for (let i = 0; i < ix.count; i++) {
    const k = ix.kind[i]
    const leaf = k === Kind.Boundary || k === Kind.Glue || k === Kind.Kern || k === Kind.Math
    if (ix.page[i] === s.page && leaf && ix.parent[i]! >= 0) holders.add(ix.parent[i]!)
  }
  for (const b of holders) {
    if (ix.kind[b] !== Kind.HBox) continue
    const { left, top, right, bottom } = recordBox(ix, b)
    if (s.x >= left && s.x <= right && s.y >= top && s.y <= bottom) return true
  }
  return false
}
