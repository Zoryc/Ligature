/** LaTeX, package, class and font warnings, engine warnings, and "No pages of output". */
import { continuation, diag, raw, type Ctx, type Recogniser } from './context.ts'
import { scanContext } from './errors.ts'
import type { DiagnosticSeverity } from './types.ts'

/** Multi-line warnings never span more lines than this. */
const MAX_WARNING_LINES = 40

const ON_INPUT_LINE_RE = /\s*on input line (\d+)\.?$/

function referenceKind(text: string): string | null {
  if (/^(?:Reference|Hyper reference) .* undefined/.test(text) || /^There were undefined references/.test(text)) {
    return 'undefined-reference'
  }
  if (/^Citation .* undefined/.test(text) || /^There were undefined citations/.test(text)) return 'undefined-citation'
  return null
}

interface Header { name: string; kind: string; text: string }

function header(line: string): Header | null {
  let m = /^LaTeX Warning:(?:\s+|$)(.*)$/.exec(line)
  if (m) return { name: 'LaTeX', kind: referenceKind(m[1]!) ?? 'latex', text: m[1]! }
  m = /^LaTeX Font Warning:(?:\s+|$)(.*)$/.exec(line)
  if (m) return { name: 'Font', kind: 'font', text: m[1]! }
  m = /^Package (\S+) Warning:(?:\s+|$)(.*)$/.exec(line)
  if (m) return { name: m[1]!, kind: referenceKind(m[2]!) ?? `package:${m[1]!}`, text: m[2]! }
  m = /^Class (\S+) Warning:(?:\s+|$)(.*)$/.exec(line)
  if (m) return { name: m[1]!, kind: `class:${m[1]!}`, text: m[2]! }
  return null
}

/** `LaTeX Warning: ...`, `Package <name> Warning: ...` (+ `(<name>)` continuation lines), `Class`, `LaTeX Font`. */
export const tryLatexWarning: Recogniser = (ctx, i) => {
  const h = header(ctx.lines[i]!)
  if (!h) return 0
  let text = h.text.trimEnd()
  let j = i + 1
  const limit = Math.min(ctx.lines.length, i + MAX_WARNING_LINES)
  for (; j < limit; j++) {
    const l = ctx.lines[j]!
    let more = continuation(l, h.name)
    // Some warnings continue on indented lines without the prefix ("Unused global option(s):\n    [x].");
    // an indented `(` is a file being opened, not part of the warning.
    if (more === null && /^\s+\S/.test(l) && !/^\s*[()]/.test(l)) more = l.trim()
    if (more === null) break
    if (more !== '') text = text === '' ? more : `${text} ${more}`
  }
  const m = ON_INPUT_LINE_RE.exec(text)
  let line: number | undefined
  if (m) {
    const n = Number(m[1])
    if (Number.isSafeInteger(n) && n > 0) line = n
    text = text.slice(0, m.index)
    if (!/[.!?]$/.test(text)) text += '.'
  }
  ctx.emit(diag(warningSeverity(h.kind, text), h.kind, text, ctx.stack.current(line), raw(ctx.lines, i, j)))
  return j - i
}

/**
 * Shell escape is off in Ligature unless an admin opts in (docs/PLAN.md), so epstopdf says so for every document
 * that loads it (graphicx with pdfTeX): nothing the author can fix, only worth knowing when an .eps image does
 * not convert.
 */
function warningSeverity(kind: string, text: string): DiagnosticSeverity {
  if (kind === 'package:epstopdf' && /^Shell escape feature is not enabled\.?$/.test(text)) return 'info'
  return 'warning'
}

/** pdfTeX/XeTeX/LuaTeX engine warnings and missing characters. */
export const tryEngineWarning: Recogniser = (ctx, i) => {
  const line = ctx.lines[i]!
  // pdfTeX: "pdfTeX warning (ext4): destination with the same identifier ..." (sometimes with error context)
  let m = /^(?:pdfTeX|XeTeX|LuaTeX|dvipdfmx|xdvipdfmx) warning(?: \(([^)]*)\))?: ?(.*)$/i.exec(line)
  if (m) {
    const ctxInfo = /^(?:<|l\.\d)/.test(ctx.lines[i + 1] ?? '') ? scanContext(ctx.lines, i + 1) : null
    const end = ctxInfo ? ctxInfo.end : i + 1
    if (/^no pages of output\.?$/i.test(m[2]!.trim())) {
      ctx.emit(diag('error', 'tex', 'No pages of output.', ctx.stack.current(), raw(ctx.lines, i, end)))
    } else {
      ctx.emit(diag('warning', 'tex', m[2]!.trim(), ctx.stack.current(ctxInfo?.line), raw(ctx.lines, i, end)))
    }
    return end - i
  }
  // LuaTeX: "warning  (pdf backend): no pages of output."
  m = /^warning\s+\(([^)]*)\): ?(.*)$/.exec(line)
  if (m) {
    const text = m[2]!.trim()
    if (/^no pages of output\.?$/i.test(text)) ctx.emit(diag('error', 'tex', 'No pages of output.', ctx.stack.current(), line.trim()))
    else ctx.emit(diag('warning', 'tex', text, ctx.stack.current(), line.trim()))
    return 1
  }
  if (/^No pages of output\.$/.test(line)) {
    ctx.emit(diag('error', 'tex', 'No pages of output.', ctx.stack.current(), line))
    return 1
  }
  m = /^Missing character: (.*)$/.exec(line)
  if (m) {
    ctx.emit(diag('warning', 'font', `Missing character: ${m[1]!.trim()}`, ctx.stack.current(), line.trim()))
    return 1
  }
  return 0
}
