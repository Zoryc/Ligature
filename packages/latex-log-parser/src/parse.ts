/** parseLatexLog: one pass over the lines; recognisers claim message lines, the rest feeds the file stack. */
import { tryBadBox } from './badboxes.ts'
import { tryBiber, tryBibtex } from './bibtex.ts'
import { diag, isErrorStart, type Ctx, type Recogniser } from './context.ts'
import { tryError } from './errors.ts'
import { FileStack } from './fileStack.ts'
import { TRACEBACK, tryLuaError } from './lua.ts'
import { projectPathMapper } from './paths.ts'
import { MAX_DIAGNOSTICS, type ParsedDiagnostic, type ParseOptions } from './types.ts'
import { tryEngineWarning, tryLatexWarning } from './warnings.ts'

/** A new engine run (latexmk's console holds several): the file stack starts afresh. */
const RUN_START_RE = /^This is (?:pdfTeX|XeTeX|LuaTeX|LuaHBTeX|e-TeX|eTeX|TeX|Biber)\b/

/** Lines that are never TeX output and never touch the file stack. */
const NOISE_RE = /^(?:Latexmk: |Running '|Rule '|Run number \d+ of rule|-{6,}$|Collected error summary|For rule '|Initial Win CP|I changed them all to|Reverting Windows console)/

/** Marker lines the compiler worker puts around the end of latexmk's console (apps/compiler/src/logTail.ts). */
const CONSOLE_TAIL_START_RE = /^==== Ligature: .*latexmk console follows ====$/
const CONSOLE_TAIL_END_RE = /^==== Ligature: end of the latexmk console ====$/

/**
 * The end of latexmk's console, appended by the compiler worker to a failed build's log that shows no error.
 * It may begin in the middle of an engine run (its open files unknown), and the TeX warnings and bad boxes
 * in it are the last run's (already reported from its log) or older runs' (stale). So it starts a fresh file
 * stack, and inside it only errors and BibTeX/Biber messages are reported (Ctx.emit).
 */
const tryConsoleTail: Recogniser = (ctx, i) => {
  const line = ctx.lines[i]!
  const start = CONSOLE_TAIL_START_RE.test(line)
  if (!start && !CONSOLE_TAIL_END_RE.test(line)) return 0
  ctx.inConsoleTail = start
  ctx.inBibtex = false
  ctx.stack.reset()
  return 1
}

const countsInConsoleTail = (d: ParsedDiagnostic) => d.severity === 'error' || d.kind === 'biber' || d.kind === 'bibtex'

/** Notes the compiler worker appends ("[ligature: compile timed out after 60000 ms; process group killed]"). */
const tryCompilerNote: Recogniser = (ctx, i) => {
  const m = /^\[ligature: (.*)\]$/.exec(ctx.lines[i]!)
  if (!m) return 0
  if (!/^log truncated\b/.test(m[1]!)) ctx.emit(diag('error', 'compiler', m[1]!, {}, ctx.lines[i]!))
  return 1
}

/**
 * "Runaway argument?" (or definition, preamble, text): TeX shows the tokens it absorbed on the next line, then the
 * error. That token text is document text, so its `(`/`)` must not reach the file stack.
 */
const tryRunaway: Recogniser = (ctx, i) => {
  if (!/^Runaway (?:argument|definition|preamble|text)\?$/.test(ctx.lines[i]!)) return 0
  const next = ctx.lines[i + 1]
  return next === undefined || isErrorStart(next) ? 1 : 2
}

const tryRunStart: Recogniser = (ctx, i) => {
  const line = ctx.lines[i]!
  if (RUN_START_RE.test(line)) {
    ctx.stack.reset()
    ctx.inBibtex = false
    return 1
  }
  if (NOISE_RE.test(line)) {
    if (line.startsWith('Latexmk: ') || line.startsWith('Running \'')) {
      ctx.inBibtex = false
      ctx.stack.reset()
    }
    return 1
  }
  return 0
}

/**
 * Recognisers in order of precedence, each behind a cheap test of the line (mostly its first character), so that
 * the common line that is none of these costs a few comparisons rather than a dozen regex runs.
 */
const RECOGNISERS: { first: string; r: Recogniser }[] = [
  { first: '=', r: tryConsoleTail },
  { first: 'TLR-CFI', r: tryRunStart },
  { first: '[', r: tryCompilerNote },
  { first: '', r: tryLuaError }, // only lines followed by "stack traceback:" (before tryError: "x.lua:3: ...")
  { first: '!', r: tryError }, // also any line with a ':' (file:line: errors)
  { first: 'LPC', r: tryLatexWarning },
  { first: 'OUTL', r: tryBadBox },
  { first: 'pPxXlLdDwNM', r: tryEngineWarning },
  { first: 'TDW', r: tryBibtex }, // also inside BibTeX output and on lines with '---'
  { first: 'WEIB[', r: tryBiber },
  { first: 'R', r: tryRunaway },
]
const bitOf = (r: Recogniser): number => 1 << RECOGNISERS.findIndex(x => x.r === r)
const LUA_BIT = bitOf(tryLuaError)
const ERROR_BIT = bitOf(tryError)
const BIBTEX_BIT = bitOf(tryBibtex)

/** For each ASCII first character, the recognisers (bit k = RECOGNISERS[k]) that can match. */
const BY_FIRST_CHAR = new Uint16Array(128)
RECOGNISERS.forEach(({ first }, k) => {
  for (const c of first) BY_FIRST_CHAR[c.charCodeAt(0)]! |= 1 << k
})

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const

function key(d: ParsedDiagnostic): string {
  return `${d.severity}\u0000${d.kind}\u0000${d.message}\u0000${d.path ?? ''}\u0000${d.line ?? ''}\u0000${d.endLine ?? ''}`
}

/**
 * Parse a TeX/latexmk log (pdfTeX, XeTeX or LuaTeX; unwrapped, file-line-error style) into diagnostics:
 * deduplicated, errors first, then warnings, then bad boxes, each group in log order; at most 500.
 * Never throws.
 */
export function parseLatexLog(log: string, opts: ParseOptions = {}): ParsedDiagnostic[] {
  if (typeof log !== 'string' || log === '') return []
  const seen = new Set<string>()
  const found: ParsedDiagnostic[] = []
  const counts = { error: 0, warning: 0, info: 0 }
  const ctx: Ctx = {
    lines: log.split(/\r\n|\r|\n/),
    stack: new FileStack(projectPathMapper(opts.rootDir)),
    inBibtex: false,
    bibDatabases: [],
    biberSource: null,
    biberCopies: new Map(),
    inConsoleTail: false,
    fatalSummary: null,
    emit(d) {
      if (ctx.inConsoleTail && !countsInConsoleTail(d)) return
      const k = key(d)
      if (seen.has(k)) return
      // Enough of this severity to fill the cap on its own: later ones can never be returned.
      if (counts[d.severity] >= MAX_DIAGNOSTICS) return
      seen.add(k)
      counts[d.severity]++
      found.push(d)
    },
  }
  const n = ctx.lines.length
  for (let i = 0; i < n;) {
    const line = ctx.lines[i]!
    if (line === '') {
      i++
      continue
    }
    const c = line.charCodeAt(0)
    let mask = c < 128 ? BY_FIRST_CHAR[c]! : 0
    if (ctx.lines[i + 1] === TRACEBACK) mask |= LUA_BIT
    if (line.indexOf(':') > 0) mask |= ERROR_BIT
    if (ctx.inBibtex || line.includes('---')) mask |= BIBTEX_BIT
    let used = 0
    for (let k = 0; mask !== 0 && k < RECOGNISERS.length; k++, mask >>= 1) {
      if ((mask & 1) === 0) continue
      used = RECOGNISERS[k]!.r(ctx, i)
      if (used > 0) break
    }
    if (used > 0) {
      i += used
      continue
    }
    ctx.stack.feed(line)
    i++
  }
  if (counts.error === 0 && ctx.fatalSummary) ctx.emit(ctx.fatalSummary)
  return found
    .map((d, idx) => ({ d, idx }))
    .sort((a, b) => SEVERITY_ORDER[a.d.severity] - SEVERITY_ORDER[b.d.severity] || a.idx - b.idx)
    .slice(0, MAX_DIAGNOSTICS)
    .map(x => x.d)
}
