/** State shared by the recognisers, and small helpers. */
import type { FileStack, Location } from './fileStack.ts'
import { looksLikeFileName } from './paths.ts'
import { RAW_MAX_CHARS, type DiagnosticSeverity, type ParsedDiagnostic } from './types.ts'

export interface Ctx {
  lines: string[]
  stack: FileStack
  emit(d: ParsedDiagnostic): void
  /** Inside BibTeX output (between "This is BibTeX" and the next run). */
  inBibtex: boolean
  /** Database files BibTeX reported ("Database file #1: refs.bib"), as project paths (null: not a project file). */
  bibDatabases: (string | null)[]
  /** The .bib Biber reported reading last ("INFO - Found BibTeX data source 'refs.bib'"), as Biber names it. */
  biberSource: string | null
  /** Biber 2.2x's temporary copies (hashed names) -> the data source each is a copy of, as first seen. */
  biberCopies: Map<string, string>
  /**
   * Inside the end of latexmk's console the compiler appends to a log without errors (between its
   * "==== Ligature: ..." marker lines): only errors and BibTeX/Biber messages count there.
   */
  inConsoleTail: boolean
  /** "==> Fatal error occurred": reported only when the log shows no other error (e.g. a truncated log). */
  fatalSummary: ParsedDiagnostic | null
}

/**
 * A recogniser looks at line `i`; it returns how many lines it consumed (0 = not its message). Consumed lines are
 * not scanned for `(`/`)`, so text in messages, error context and box contents cannot corrupt the file stack.
 */
export type Recogniser = (ctx: Ctx, i: number) => number

/** `file:line: message` (file-line-error style). */
const FILE_LINE_RE = /^(.+?):(\d+): ?(.*)$/
const FILE_EXT_LINE_RE = /\.[A-Za-z][\w-]{0,9}:\d/

/**
 * `line` is absent when TeX printed line 0 (lines are 1-based: 0 means it was not reading a line of that file).
 */
export interface FileLine { file: string; line?: number; message: string }

/**
 * One-entry memo: the error scan asks about the line after an error (is it the next error?), and the main loop
 * then asks again about the same line. Equal strings give equal answers, so keying on the text is safe.
 */
let memoLine: string | undefined
let memoResult: FileLine | null = null

export function matchFileLine(line: string): FileLine | null {
  if (line === memoLine) return memoResult
  const r = matchFileLineUncached(line)
  memoLine = line
  memoResult = r
  return r
}

function matchFileLineUncached(line: string): FileLine | null {
  if (line.length > 20_000) return null
  // Cheap necessary condition (looksLikeFileName wants `.ext` right before `:<line>`), so that the many lines
  // with a colon that are no file:line error ("y:1: z", "Chapter 1: ...") skip the backtracking regex.
  if (!FILE_EXT_LINE_RE.test(line)) return null
  const m = FILE_LINE_RE.exec(line)
  if (!m || !looksLikeFileName(m[1]!)) return null
  const n = Number(m[2])
  if (!Number.isSafeInteger(n)) return null
  const message = m[3]!.trim()
  return n > 0 ? { file: m[1]!, line: n, message } : { file: m[1]!, message }
}

/** Does this line start a TeX error message? */
export function isErrorStart(line: string): boolean {
  return line.startsWith('! ') || line === '!' || matchFileLine(line) !== null
}

export function raw(lines: string[], from: number, to: number): string {
  let s = ''
  for (let k = from; k < to && k < lines.length; k++) {
    const t = lines[k]!.slice(0, RAW_MAX_CHARS + 1).trimEnd()
    s += (k === from ? '' : '\n') + t
    if (s.length > RAW_MAX_CHARS) return s.slice(0, RAW_MAX_CHARS - 1) + '…'
  }
  return s.trimEnd()
}

export function diag(severity: DiagnosticSeverity, kind: string, message: string, loc: Location,
  rawText: string, endLine?: number): ParsedDiagnostic {
  const d: ParsedDiagnostic = { severity, kind, message }
  if (loc.path !== undefined) d.path = loc.path
  // Lines are 1-based; a 0 (or garbage) from the log means "no line".
  if (loc.line !== undefined && Number.isSafeInteger(loc.line) && loc.line > 0) {
    d.line = loc.line
    if (endLine !== undefined && endLine >= loc.line) d.endLine = endLine
  }
  if (rawText !== '') d.raw = rawText
  return d
}

/** Continuation lines of a multi-line LaTeX message: "(hyperref)                removing ...". */
export function continuation(line: string, name: string): string | null {
  const prefix = `(${name})`
  if (!line.startsWith(prefix)) return null
  const rest = line.slice(prefix.length)
  if (rest !== '' && !/^\s/.test(rest)) return null
  return rest.trim()
}
