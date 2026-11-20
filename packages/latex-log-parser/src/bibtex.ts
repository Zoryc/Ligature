/** BibTeX and Biber messages (as echoed by latexmk on its console). */
import type { Location } from './fileStack.ts'
import { diag, raw, type Ctx, type Recogniser } from './context.ts'

/** Lines BibTeX prints after an error to show where it was (" : author = ...", "I'm skipping ..."). */
function isBibtexErrorTail(line: string): boolean {
  return /^ : /.test(line) || line === ' :' || /^\(Error may have been on previous line\)$/.test(line) ||
    /^I'm skipping whatever remains of this (?:entry|command)$/.test(line)
}

/** A file BibTeX names: .bib files are project files (found via BIBINPUTS); the .aux it reads is in out/. */
function bibLocation(ctx: Ctx, file: string, line?: number): Location {
  if (/\.aux$/i.test(file)) return {}
  const p = ctx.stack.project(file.trim())
  if (p === null) return {}
  return line === undefined ? { path: p } : { path: p, line }
}

interface Where { file: string; line?: number }

/** "---line 15 of file refs.bib" / "---while reading file output.aux" */
function parseWhere(s: string): Where | null {
  let m = /^---line (\d+) of file (.+)$/.exec(s)
  if (m) {
    const n = Number(m[1])
    return Number.isSafeInteger(n) && n > 0 ? { file: m[2]!, line: n } : { file: m[2]! }
  }
  m = /^---while reading file (.+)$/.exec(s)
  return m ? { file: m[1]! } : null
}

export const tryBibtex: Recogniser = (ctx, i) => {
  const line = ctx.lines[i]!
  if (/^This is BibTeX\b/.test(line)) {
    ctx.inBibtex = true
    ctx.bibDatabases = []
    ctx.stack.reset()
    return 1
  }
  let m = /^Database file #\d+: (.+)$/.exec(line)
  if (m && ctx.inBibtex) {
    ctx.bibDatabases.push(ctx.stack.project(m[1]!.trim()))
    return 1
  }
  m = /^Warning--(.*)$/.exec(line)
  if (m) {
    const text = m[1]!.trim()
    const where = /^--line (\d+) of file (.+)$/.exec(ctx.lines[i + 1] ?? '')
    if (where) {
      ctx.emit(diag('warning', 'bibtex', text, bibLocation(ctx, where[2]!, Number(where[1])), raw(ctx.lines, i, i + 2)))
      return 2
    }
    // Warnings about an entry ("empty journal in incomplete") belong to the database when there is only one.
    let loc: Location = {}
    const only = ctx.bibDatabases.length === 1 ? ctx.bibDatabases[0] : null
    if (only && / in \S+$/.test(text)) loc = { path: only }
    ctx.emit(diag('warning', 'bibtex', text, loc, line))
    return 1
  }
  // "I was expecting a `,' or a `}'---line 15 of file refs.bib", "I found no \citation commands---while reading
  // file output.aux"; a long message may put the "---line ..." part on the next line.
  let text: string | null = null
  let where: Where | null = null
  let consumed = 1
  m = /^(.*?)(---.*)$/.exec(line)
  if (m && m[1]!.trim() !== '' && (where = parseWhere(m[2]!))) {
    text = m[1]!.trim()
  } else if (ctx.inBibtex && line.trim() !== '' && !/^\(There (?:was|were) /.test(line)) {
    where = parseWhere(ctx.lines[i + 1] ?? '')
    if (where) {
      text = line.trim()
      consumed = 2
    }
  }
  if (text !== null && where) {
    const loc = bibLocation(ctx, where.file, where.line)
    let j = i + consumed
    while (j < ctx.lines.length && j < i + consumed + 10 && isBibtexErrorTail(ctx.lines[j]!)) j++
    ctx.emit(diag('error', 'bibtex', text, loc, raw(ctx.lines, i, j)))
    return j - i
  }
  return 0
}

/**
 * Biber: "WARN - ..." / "ERROR - ..." (optionally behind "[123] Biber.pm:456> "; latexmk repeats them behind
 * "Biber error: " / "Biber warning: "), and the "INFO - Found BibTeX data source 'refs.bib'" line.
 */
const BIBER_RE = /^(?:Biber (?:error|warning): )?(?:\[\d+\] [\w.]+:\d+> )?(WARN|ERROR|INFO) - (.*)$/
/** Biber 2.2x reads a UTF-8 copy of the .bib named "<TMPDIR>/biber_tmp_XXXX/<md5>_<pid>.utf8". */
const BIBER_TMP_RE = /\S*biber_tmp_[^\s/\\]*[/\\][0-9a-f]+_\d+\.utf8/

/**
 * Biber 2.2x's temporary copy named in `text`, and the data source it is a copy of. Biber reads its sources
 * one after another and reports a source's errors before announcing the next, so a copy belongs to the
 * source current when it is first named. latexmk repeats the errors after biber has finished, when the
 * current source is the last one: the repeat must keep the first answer.
 */
function biberCopy(ctx: Ctx, text: string): { tmp: string; source: string } | null {
  const tmp = BIBER_TMP_RE.exec(text)?.[0]
  if (tmp === undefined) return null
  let source = ctx.biberCopies.get(tmp)
  if (source === undefined) {
    if (ctx.biberSource === null) return null
    source = ctx.biberSource
    ctx.biberCopies.set(tmp, source)
  }
  return { tmp, source }
}

function biberLocation(ctx: Ctx, text: string, copy: { source: string } | null): Location {
  // Older biber: "BibTeX subsystem: /tmp/biber_tmp_x/refs.bib_123.utf8, line 15, ..." (only the base name).
  const at = /([^\s'"/\\]+\.bib)(?:_\d+\.utf8)?, line (\d+)/.exec(text)
  if (at) return { path: at[1]!, line: Number(at[2]) }
  // Biber 2.2x: the copy has a hashed name.
  const tmp = /\.utf8, line (\d+)/.exec(text)
  if (tmp && copy !== null) {
    const p = ctx.stack.project(copy.source)
    if (p !== null) return { path: p, line: Number(tmp[1]) }
  }
  const entry = /\(([^\s'"/\\()]+\.bib)\)/.exec(text)
  return entry ? { path: entry[1]! } : {}
}

export const tryBiber: Recogniser = (ctx, i) => {
  const line = ctx.lines[i]!
  const m = BIBER_RE.exec(line)
  if (!m) return 0
  let text = m[2]!.trim()
  if (m[1] === 'INFO') {
    const src = /^Found BibTeX data source '(.+)'$/.exec(text)
    if (!src) return 0 // other INFO lines are not messages
    ctx.biberSource = src[1]!
    return 1
  }
  const copy = biberCopy(ctx, text)
  const loc = biberLocation(ctx, text, copy)
  // Name the user's file instead of biber's temporary copy of it.
  if (copy !== null) text = text.replace(copy.tmp, () => copy.source) // a function: no `$` patterns in a file name
  ctx.emit(diag(m[1] === 'ERROR' ? 'error' : 'warning', 'biber', text, loc, line))
  return 1
}
