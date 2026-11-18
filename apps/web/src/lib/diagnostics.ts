/**
 * Build diagnostics in the editor (docs/M2.md §2): counts for the problems list, and positions that
 * follow the text as it is edited until the next build replaces them.
 *
 * A diagnostic is anchored to a character range (its line, or its line range for bad boxes) and the
 * range is mapped through every change of the Y.Text (local or remote). While a file is closed only
 * its line numbers are kept; they are anchored again against the text when the file is reopened.
 */
import type { Diagnostic } from '@ligature/shared'

/** One operation of a Y.Text delta (YTextEvent.delta), relative to the text before the change. */
export interface DeltaOp {
  retain?: number
  delete?: number
  insert?: string | object
}

/** Where a position goes after a change. assoc < 0 keeps it before text inserted exactly there, > 0 moves it after. */
export function mapPos(pos: number, delta: readonly DeltaOp[], assoc: -1 | 1): number {
  let old = 0
  let shift = 0
  for (const op of delta) {
    if (op.retain !== undefined) {
      if (pos < old + op.retain) return pos + shift
      old += op.retain
    } else if (op.insert !== undefined) {
      const len = typeof op.insert === 'string' ? op.insert.length : 1
      if (pos === old && assoc < 0) return pos + shift
      shift += len
    } else if (op.delete !== undefined) {
      if (pos < old + op.delete) return old + shift // inside the deleted range: collapse to its start
      old += op.delete
      shift -= op.delete
    }
  }
  return pos + shift
}

/** 0-based offsets of the start of every line. */
export function lineStarts(text: string): number[] {
  const out = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) out.push(i + 1)
  return out
}

/** 1-based line containing offset `pos`. */
export function lineAt(starts: readonly number[], pos: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= pos) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** [start of `line`, end of `endLine`] (both clamped to the text; the end excludes the line break). */
export function lineRange(text: string, starts: readonly number[], line: number, endLine = line): { from: number; to: number } {
  const n = starts.length
  const a = Math.min(Math.max(1, line), n)
  const b = Math.min(Math.max(a, endLine), n)
  const from = starts[a - 1] ?? 0
  const next = starts[b]
  const to = next === undefined ? text.length : next - 1
  return { from, to: Math.max(from, to) }
}

/** A diagnostic of one file with its current line numbers (they move with edits). */
export interface LineDiagnostic {
  diag: Diagnostic
  line: number
  endLine: number
}

/** The diagnostics of `fileId` from a build, at the build's line numbers (no line: line 1). */
export function linesForFile(diags: readonly Diagnostic[], fileId: string): LineDiagnostic[] {
  return diags.filter(d => d.fileId === fileId).map(d => {
    const line = d.line ?? 1
    return { diag: d, line, endLine: Math.max(line, d.endLine ?? line) }
  })
}

interface Anchored {
  diag: Diagnostic
  from: number
  to: number
}

/** Diagnostics of the open file, anchored to character ranges of its text. */
export class FileDiagnostics {
  private items: Anchored[]

  constructor(lines: readonly LineDiagnostic[], text: string) {
    const starts = lineStarts(text)
    this.items = lines.map(l => ({ diag: l.diag, ...lineRange(text, starts, l.line, l.endLine) }))
  }

  get size(): number {
    return this.items.length
  }

  /** Follow one change of the text (YTextEvent.delta). */
  applyDelta(delta: readonly DeltaOp[]): void {
    for (const it of this.items) {
      const from = mapPos(it.from, delta, 1)
      const to = mapPos(it.to, delta, -1)
      it.from = from
      it.to = Math.max(from, to)
    }
  }

  /** Current ranges, for CodeMirror (clamped to the text length). */
  ranges(length: number): { diag: Diagnostic; from: number; to: number }[] {
    return this.items.map(it => {
      const from = Math.min(it.from, length)
      return { diag: it.diag, from, to: Math.min(Math.max(from, it.to), length) }
    })
  }

  /** Current line of a diagnostic (by identity), or null if it is not one of this file's. */
  lineOf(diag: Diagnostic, text: string): number | null {
    const it = this.items.find(x => x.diag === diag)
    return it ? lineAt(lineStarts(text), it.from) : null
  }

  /** Back to line numbers (when the file is closed). */
  toLines(text: string): LineDiagnostic[] {
    const starts = lineStarts(text)
    return this.items.map(it => ({ diag: it.diag, line: lineAt(starts, it.from), endLine: lineAt(starts, it.to) }))
  }
}

/**
 * The text of a file when a compile started plus every change since, so the diagnostics of that build
 * can be anchored to the text they were computed from and then brought up to date.
 */
export class ChangeLog {
  readonly fileId: string
  readonly text: string
  private readonly deltas: DeltaOp[][] = []

  constructor(fileId: string, text: string) {
    this.fileId = fileId
    this.text = text
  }

  record(delta: readonly DeltaOp[]): void {
    this.deltas.push(delta.map(op => ({ ...op })))
  }

  anchor(lines: readonly LineDiagnostic[]): FileDiagnostics {
    const fd = new FileDiagnostics(lines, this.text)
    this.replay(d => fd.applyDelta(d))
    return fd
  }

  /** Every change since the start, in order. */
  replay(apply: (delta: readonly DeltaOp[]) => void): void {
    for (const d of this.deltas) apply(d)
  }
}

/** A diagnostic as the editor shows it: anchored to a range of the current text. */
export interface EditorDiagnostic {
  from: number
  to: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source?: string
}

/** The open file's diagnostics for CodeMirror. */
export function editorDiagnostics(fd: FileDiagnostics, length: number): EditorDiagnostic[] {
  return fd.ranges(length).map(r => ({ from: r.from, to: r.to, severity: r.diag.severity, message: r.diag.message, source: r.diag.kind }))
}

export interface SeverityCounts { errors: number; warnings: number; infos: number }

export function countSeverities(diags: readonly Pick<Diagnostic, 'severity'>[]): SeverityCounts {
  const c = { errors: 0, warnings: 0, infos: 0 }
  for (const d of diags) {
    if (d.severity === 'error') c.errors++
    else if (d.severity === 'warning') c.warnings++
    else c.infos++
  }
  return c
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "3 errors, 5 warnings", "1 error, 2 bad boxes", or "No problems". */
export function problemsSummary(c: SeverityCounts): string {
  const parts: string[] = []
  if (c.errors) parts.push(plural(c.errors, 'error'))
  if (c.warnings) parts.push(plural(c.warnings, 'warning'))
  if (c.infos) parts.push(c.infos === 1 ? '1 bad box' : `${c.infos} bad boxes`)
  return parts.length ? parts.join(', ') : 'No problems'
}

/** "chapters/intro.tex:12" / "chapters/intro.tex:12-15" / "main.tex" / "" */
export function locationText(d: Pick<Diagnostic, 'path' | 'line' | 'endLine'>): string {
  if (!d.path) return d.line ? `line ${d.line}` : ''
  if (!d.line) return d.path
  return d.endLine && d.endLine !== d.line ? `${d.path}:${d.line}-${d.endLine}` : `${d.path}:${d.line}`
}
