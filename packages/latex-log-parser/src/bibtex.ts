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

/** Biber: "WARN - ..." / "ERROR - ..." (optionally behind "[123] Biber.pm:456> "). */
export const tryBiber: Recogniser = (ctx, i) => {
  const line = ctx.lines[i]!
  const m = /^(?:\[\d+\] [\w.]+:\d+> )?(WARN|ERROR) - (.*)$/.exec(line)
  if (!m) return 0
  const text = m[2]!.trim()
  // "BibTeX subsystem: /tmp/biber_tmp_x/refs.bib_123.utf8, line 15, syntax error: ..." — biber copies the .bib,
  // so only the base name is known.
  const at = /([^\s'"/\\]+\.bib)(?:_\d+\.utf8)?, line (\d+)/.exec(text)
  let loc: Location = {}
  if (at) loc = { path: at[1]!, line: Number(at[2]) }
  else {
    const entry = /\(([^\s'"/\\()]+\.bib)\)/.exec(text)
    if (entry) loc = { path: entry[1]! }
  }
  ctx.emit(diag(m[1] === 'ERROR' ? 'error' : 'warning', 'biber', text, loc, line))
  return 1
}
