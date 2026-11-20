/** TeX errors: `file:line: message` and `! message`, with their context lines (`l.<n> ...`) and help text. */
import type { Location } from './fileStack.ts'
import { continuation, diag, isErrorStart, matchFileLine, raw, type Ctx, type Recogniser } from './context.ts'

/** How far after the message we look for the `l.<n>` context line. */
const CONTEXT_WINDOW = 60
/** Help text is a few lines; never consume more than this. */
const HELP_MAX = 30

interface Classified { kind: string; message: string; continuationName?: string }

function classify(message: string): Classified {
  // The message was trimmed: when the text is all on continuation lines, nothing follows the colon
  // ("Package fontspec Error:" then "(fontspec)  The font ... cannot be found").
  const latex = /^LaTeX Error:(?:\s+|$)(.*)$/.exec(message)
  if (latex) {
    const text = latex[1]!
    if (/^File [`'"].+?' not found\.?$/.test(text)) return { kind: 'missing-file', message: text, continuationName: 'LaTeX' }
    return { kind: 'latex', message: text, continuationName: 'LaTeX' }
  }
  // "Fatal Package fontspec Error: The fontspec package requires either XeTeX or" (\PackageFatalError, expl3)
  if (message.startsWith('Package ') || message.startsWith('Class ') || message.startsWith('Fatal ')) {
    const m = /^(?:Fatal )?(Package|Class) (\S+) Error:(?:\s+|$)(.*)$/.exec(message)
    if (m) return { kind: `${m[1]!.toLowerCase()}:${m[2]!}`, message: m[3]!, continuationName: m[2]! }
  }
  if (message.startsWith('I can\'t find file ')) return { kind: 'missing-file', message }
  return { kind: 'tex', message }
}

interface Context {
  /** line number from `l.<n>` */
  line?: number
  /** index of the first line after the context (help text starts here) */
  end: number
  /** detail from a `*** (...)` line ("job aborted, no legal \end found") */
  detail?: string
}

/**
 * Find the error context starting at `from`: lines up to `l.<n>` (or `<*>` when TeX was reading the command
 * line) and the line after it. Stops at the next error, or at `stop`. Null if there is none.
 */
export function scanContext(lines: string[], from: number, stop = lines.length): Context | null {
  const limit = Math.min(lines.length, stop, from + CONTEXT_WINDOW)
  for (let k = from; k < limit; k++) {
    const l = lines[k]!
    if (k > from && isErrorStart(l)) return null
    const ln = /^l\.(\d+)(?: |$)/.exec(l)
    if (ln || l.startsWith('<*>')) {
      let end = Math.min(lines.length, k + 2) // the context pair: text read so far, text not yet read
      const ctx: Context = { end }
      if (ln) {
        const n = Number(ln[1])
        if (Number.isSafeInteger(n) && n > 0) ctx.line = n
      }
      const star = end < lines.length ? /^\*\*\* \((.*)\)\s*$/.exec(lines[end]!) : null
      if (star) {
        ctx.detail = star[1]!
        end++
      }
      ctx.end = end
      return ctx
    }
  }
  return null
}

/** Skip help text after the context: up to the next empty line. Returns the index of that empty line. */
export function skipHelp(lines: string[], from: number, l3: boolean): number {
  let k = from
  // LaTeX3 (expl3) errors print an empty line before their help text.
  if (l3 && k + 1 < lines.length && lines[k] === '' && lines[k + 1] !== '' && !isErrorStart(lines[k + 1]!)) k++
  const limit = Math.min(lines.length, k + HELP_MAX)
  while (k < limit && lines[k] !== '' && !isErrorStart(lines[k]!)) k++
  return k
}

/** The undefined control sequence: the last token of the first half of the first context line. */
function culprit(lines: string[], from: number, ctxEnd: number): string | null {
  if (from >= ctxEnd) return null
  const first = lines[from]!.trimEnd()
  const m = /(\\(?:[A-Za-z@]+|.))$/.exec(first)
  return m ? m[1]! : null
}

export const tryError: Recogniser = (ctx, i) => {
  const line = ctx.lines[i]!
  let message: string
  let file: { name: string; line: number | undefined } | null = null
  if (line.startsWith('! ') || line === '!') {
    message = line.slice(1).trim()
  } else {
    const fl = matchFileLine(line)
    if (!fl) return 0
    message = fl.message
    file = { name: fl.file, line: fl.line }
  }

  // "==> Fatal error occurred, no output PDF file produced!" only restates earlier errors (see parse.ts).
  if (message.startsWith('==> Fatal error occurred')) {
    ctx.fatalSummary ??= diag('error', 'tex', 'Fatal error occurred, no output PDF file produced!', ctx.stack.current(), line.trim())
    return 1
  }

  const c = classify(message)
  let j = i + 1
  let text = c.message
  if (c.continuationName !== undefined) {
    for (; j < ctx.lines.length; j++) {
      const more = continuation(ctx.lines[j]!, c.continuationName)
      if (more === null) break
      if (more !== '') text = text === '' ? more : `${text} ${more}`
    }
  }
  const context = scanContext(ctx.lines, j)
  let end = j
  if (context) {
    let l3 = false
    for (let k = i + 1; k < context.end && !l3; k++) l3 = ctx.lines[k]!.startsWith('For immediate help type H <return>')
    end = skipHelp(ctx.lines, context.end, l3)
    if (text === 'Undefined control sequence.' || text === 'Undefined control sequence') {
      const cs = culprit(ctx.lines, j, context.end)
      if (cs) text = `Undefined control sequence ${cs}`
    }
    if ((text === 'Emergency stop.' || text === 'Emergency stop') && context.detail) text = `Emergency stop (${context.detail})`
  }

  let loc: Location
  if (file) loc = ctx.stack.at(file.name, file.line)
  else loc = ctx.stack.current(context?.line)
  ctx.emit(diag('error', c.kind, text, loc, raw(ctx.lines, i, context ? context.end : j)))
  return Math.max(1, end - i)
}
