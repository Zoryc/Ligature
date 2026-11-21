/**
 * The project index for autocomplete (docs/AUTOCOMPLETE.md): labels, bibliography entries and the project's own
 * commands and environments, per file. Pure parsing; the project page feeds it texts (projectTexts.ts) and the
 * completion source (latexCompletion.ts) reads it on every suggestion, so the getters return cached arrays.
 */

import { group, groups, lineLocator, plainTitle, stripComments, type Groups } from '../outline.ts'
import type { BibEntry, LabelEntry, UserDefinition } from './completionTypes.ts'

export interface TexIndex {
  labels: LabelEntry[]
  definitions: UserDefinition[]
}

// ---------- small scanners over comment-stripped text ----------

/** True when the character at `i` is escaped by an odd number of backslashes before it. */
export function escapedAt(text: string, i: number): boolean {
  let n = 0
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++
  return n % 2 === 1
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i] ?? '')) i++
  return i
}

/** A control sequence name at `i`, written `\x` or `{\x}`; null otherwise. */
function csName(text: string, args: Groups, i: number): { name: string; end: number } | null {
  if (text[i] === '{') {
    const g = args.brace(i, MAX_NAME)
    const m = g ? /^\s*\\([A-Za-z@]+|.)\s*$/.exec(g.content) : null
    return g && m?.[1] ? { name: m[1], end: g.end } : null
  }
  if (text[i] !== '\\') return null
  const m = /^\\([A-Za-z@]+|.)/.exec(text.slice(i, i + 200))
  return m?.[1] ? { name: m[1], end: i + m[0].length } : null
}

/**
 * Arguments of an xparse spec ("m o m", "O{x} m", "s m"). Our type keeps only "N arguments, the first maybe
 * optional", so: required = the `m` (and `v`) arguments; any optional ones count as one leading optional.
 * Delimited required arguments (`r()`) are left out: braces would be wrong for them.
 */
export function xparseArgs(spec: string): { argCount: number; optionalDefault: boolean } {
  let required = 0
  let optionals = 0
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i]
    if (c === 'm' || c === 'v') required++
    else if (c === 'o') optionals++
    else if (c === 'O') { optionals++; i = skipGroup(spec, i + 1) }
    else if (c === 'd') { optionals++; i += 2 }
    else if (c === 'D') { optionals++; i = skipGroup(spec, i + 3) }
    else if (c === 'r') i += 2
    else if (c === 'R') i = skipGroup(spec, i + 3)
    else if (c === 't') i += 1
    else if (c === 'e' || c === '>' || c === '=') i = skipGroup(spec, i + 1)
    else if (c === 'E') i = skipGroup(spec, skipGroup(spec, i + 1) + 1)
  }
  return { argCount: required + (optionals > 0 ? 1 : 0), optionalDefault: optionals > 0 }
}

/** Index of the last character of the {...} group at `i` (or `i - 1` when there is none). */
function skipGroup(text: string, i: number): number {
  const j = skipSpace(text, i)
  const g = group(text, j)
  return g ? g.end - 1 : i - 1
}

// ---------- .tex ----------

const HEADINGS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'])
const NEW_COMMAND = new Set(['newcommand', 'renewcommand', 'providecommand'])
const NEW_ENV = new Set(['newenvironment', 'renewenvironment'])
const XPARSE_COMMAND = new Set(['NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand', 'DeclareDocumentCommand'])
const XPARSE_ENV = new Set(['NewDocumentEnvironment', 'RenewDocumentEnvironment', 'ProvideDocumentEnvironment', 'DeclareDocumentEnvironment'])
const DEF = new Set(['def', 'gdef', 'edef', 'xdef'])

/** Environments that only lay things out: a label inside them is described by an outer one or the heading. */
const NEUTRAL_ENVS = new Set([
  'document', 'center', 'flushleft', 'flushright', 'minipage', 'raggedright', 'small', 'footnotesize', 'scriptsize',
  'tiny', 'large', 'Large', 'normalsize', 'landscape', 'multicols', 'samepage', 'adjustbox', 'spacing',
  'singlespace', 'onehalfspace', 'doublespace',
])

const TOKEN = new RegExp(
  '\\\\(begin|end|label|caption|part|chapter|section|subsection|subsubsection|paragraph|newcommand|renewcommand|' +
  'providecommand|DeclareMathOperator|def|gdef|edef|xdef|NewDocumentCommand|RenewDocumentCommand|' +
  'ProvideDocumentCommand|DeclareDocumentCommand|newenvironment|renewenvironment|NewDocumentEnvironment|' +
  'RenewDocumentEnvironment|ProvideDocumentEnvironment|DeclareDocumentEnvironment|newtheorem)(?![A-Za-z@])(\\*?)',
  'g',
)

/**
 * A heading or caption, made readable only when a label needs it (most never are): `prev` is the one before
 * it, which an empty title falls back to; `resolved` caches the answer of a lookup.
 */
interface Title { raw: string; prev: Title | undefined; text?: string; resolved?: string }

interface EnvFrame { name: string; caption?: Title }

/** Longest label, environment or command name we read; longer "names" are broken or planted text. */
const MAX_NAME = 200
/** Longest xparse argument spec and \def parameter text we read. */
const MAX_SPEC = 200
/** Environments deeper than this drop the outermost: real documents nest a handful, and it bounds the work per \end. */
const MAX_DEPTH = 100
/** Headings and captions made readable per file at most: plenty for real files, a bound for planted ones. */
const MAX_TITLES = 5000

/** A title's readable text, or the one before it when empty. Amortised O(1) per call: visited titles cache it. */
function titleText(start: Title | undefined, budget: { left: number }): string | undefined {
  const seen: Title[] = []
  let found: string | undefined
  for (let t = start; t; t = t.prev) {
    if (t.resolved !== undefined) {
      found = t.resolved || undefined
      break
    }
    seen.push(t)
    if (t.text === undefined) {
      if (budget.left <= 0) break
      budget.left--
      t.text = plainTitle(t.raw)
    }
    if (t.text) {
      found = t.text
      break
    }
  }
  for (const t of seen) t.resolved = found ?? ''
  return found
}

/** Index of the innermost frame named `name`, or -1. */
function lastFrame(envs: readonly EnvFrame[], name: string): number {
  for (let k = envs.length - 1; k >= 0; k--) if (envs[k]?.name === name) return k
  return -1
}

/** Labels (with what they label) and the commands and environments a .tex/.sty/.cls file defines. */
export function indexTex(raw: string, fileId: string): TexIndex {
  const text = stripComments(raw)
  const lineAt = lineLocator(text)
  const args = groups(text) // linear whatever the text: unclosed groups cost nothing per lookup
  const labels: LabelEntry[] = []
  const definitions: UserDefinition[] = []
  const envs: EnvFrame[] = []
  let heading: Title | undefined
  const budget = { left: MAX_TITLES }
  const innermost = () => {
    for (let k = envs.length - 1; k >= 0; k--) if (!NEUTRAL_ENVS.has(envs[k]?.name ?? '')) return envs[k]
    return undefined
  }
  const define = (kind: UserDefinition['kind'], name: string, argCount: number, optionalDefault: boolean, at: number) => {
    definitions.push({ kind, name, argCount, ...(optionalDefault ? { optionalDefault: true } : {}), fileId, line: lineAt(at) })
  }

  TOKEN.lastIndex = 0
  for (let r = TOKEN.exec(text); r; r = TOKEN.exec(text)) {
    if (escapedAt(text, r.index)) continue // "\\label" is a line break followed by text
    const cmd = r[1] ?? ''
    let i = skipSpace(text, r.index + r[0].length)

    if (cmd === 'begin' || cmd === 'end' || cmd === 'label') {
      const g = args.brace(i, MAX_NAME)
      if (!g) continue
      const name = g.content.trim()
      if (cmd === 'begin') {
        if (envs.push({ name }) > MAX_DEPTH) envs.shift()
      } else if (cmd === 'end') {
        const k = lastFrame(envs, name)
        if (k >= 0) envs.length = k // also closes environments left open inside (broken source)
      } else if (name && !name.includes('#')) { // "fig:#1" inside a macro definition is not a real label
        const frame = innermost()
        const caption = frame && titleText(frame.caption, budget)
        const context = frame ? (caption ? `${frame.name}: ${caption}` : frame.name) : titleText(heading, budget)
        labels.push({ name, fileId, line: lineAt(r.index), ...(context ? { context } : {}) })
      }
      continue
    }
    if (cmd === 'caption' || HEADINGS.has(cmd)) {
      const short = args.bracket(i)
      if (short) i = skipSpace(text, short.end)
      const g = args.brace(i)
      if (!g) continue
      if (cmd === 'caption') {
        const frame = innermost()
        if (frame) frame.caption = { raw: g.content, prev: frame.caption }
      } else heading = { raw: g.content, prev: heading }
      continue
    }
    if (NEW_COMMAND.has(cmd) || NEW_ENV.has(cmd)) {
      const env = NEW_ENV.has(cmd)
      const name = env ? args.brace(i, MAX_NAME) : csName(text, args, i)
      if (!name) continue
      const id = 'content' in name ? name.content.trim() : name.name
      i = skipSpace(text, name.end)
      const count = args.bracket(i, MAX_NAME)
      const n = count ? Number.parseInt(count.content.trim(), 10) || 0 : 0
      const dflt = count ? args.bracket(skipSpace(text, count.end)) : null
      if (id) define(env ? 'environment' : 'command', id, n, n > 0 && !!dflt, r.index)
      continue
    }
    if (XPARSE_COMMAND.has(cmd) || XPARSE_ENV.has(cmd)) {
      const env = XPARSE_ENV.has(cmd)
      const name = env ? args.brace(i, MAX_NAME) : csName(text, args, i)
      if (!name) continue
      const id = 'content' in name ? name.content.trim() : name.name
      const spec = args.brace(skipSpace(text, name.end), MAX_SPEC)
      const parsed = xparseArgs(spec?.content ?? '')
      if (id) define(env ? 'environment' : 'command', id, parsed.argCount, parsed.optionalDefault, r.index)
      continue
    }
    if (cmd === 'DeclareMathOperator') {
      const name = csName(text, args, i)
      if (name) define('command', name.name, 0, false, r.index)
      continue
    }
    if (DEF.has(cmd)) {
      const name = csName(text, args, i)
      if (!name) continue
      // Parameter text up to the body: "#1#2" -> 2 arguments. Looked for nearby only: an unbounded search
      // per \def would make a file of repeated "\def\a" quadratic.
      const near = text.slice(name.end, name.end + MAX_SPEC + 1)
      const body = near.indexOf('{')
      const params = body === -1 ? '' : near.slice(0, body)
      define('command', name.name, (params.match(/#[1-9]/g) ?? []).length, false, r.index)
      continue
    }
    if (cmd === 'newtheorem') {
      const g = args.brace(i, MAX_NAME)
      if (g?.content.trim()) define('environment', g.content.trim(), 0, false, r.index)
    }
  }
  return { labels, definitions }
}

// ---------- .bib ----------

const ENTRY_START = /@\s*([A-Za-z]+)\s*([{(])/g
/** A line that starts a new entry: where a broken entry (missing closing brace) is cut off. */
const LINE_ENTRY = /\n[ \t]*@\s*[A-Za-z]+\s*[{(]/y

/** Index of the delimiter closing the entry whose body starts at `i`, or where the next entry starts. */
function entryEnd(text: string, i: number, open: string): number {
  let depth = 0
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0 && open === '{') return j
      depth--
    } else if (c === ')' && depth === 0 && open === '(') return j
    else if (c === '\n') {
      LINE_ENTRY.lastIndex = j
      if (LINE_ENTRY.test(text)) return j
    }
  }
  return text.length
}

/** Readable field text: no outer delimiters, no braces, TeX accents and escapes reduced to their letters. */
function cleanValue(v: string): string {
  return v
    .replace(/\\[`'^"~=.]\s*\{?\\?([A-Za-z])\}?/g, '$1')
    // Letter accents (\c{c}, \v s) need a brace or a space, or "\url" would lose its "u".
    .replace(/\\[uvHcdbtr](?:\s+|\{\\?)([A-Za-z])\}?/g, '$1')
    .replace(/\\([&%$#_])/g, '$1')
    // Logos are words in titles ("The {\TeX}book"); other commands are markup.
    .replace(/\\(TeX|LaTeX|LaTeXe|BibTeX|XeTeX|LuaTeX|pdfTeX|ConTeXt)(?![A-Za-z])/g, '$1')
    .replace(/\\[A-Za-z]+\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One field value at `i`: {…}, "…", a number or a @string name, joined with #. */
function fieldValue(body: string, i: number, strings: Map<string, string>): { value: string; end: number } {
  let value = ''
  for (;;) {
    i = skipSpace(body, i)
    const c = body[i]
    if (c === '{') {
      const g = group(body, i)
      if (!g) return { value: value + body.slice(i + 1), end: body.length }
      value += g.content
      i = g.end
    } else if (c === '"') {
      let depth = 0
      let j = i + 1
      for (; j < body.length; j++) {
        const d = body[j]
        if (d === '\\') { j++; continue }
        if (d === '{') depth++
        else if (d === '}') depth--
        else if (d === '"' && depth <= 0) break
      }
      value += body.slice(i + 1, j)
      i = j + 1
    } else {
      const m = /^[^\s,#}]+/.exec(body.slice(i))
      if (!m) return { value, end: i }
      value += /^\d+$/.test(m[0]) ? m[0] : strings.get(m[0].toLowerCase()) ?? m[0]
      i += m[0].length
    }
    i = skipSpace(body, i)
    if (body[i] !== '#') return { value, end: i }
    i++
  }
}

/** The `name = value` fields of an entry body (after the key), lower-cased names. */
function fields(body: string, strings: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  while (i < body.length) {
    const m = /^[\s,]*([A-Za-z][\w:.+-]*)\s*=/.exec(body.slice(i))
    if (!m?.[1]) break // broken from here on: keep what we have
    const v = fieldValue(body, i + m[0].length, strings)
    out.set(m[1].toLowerCase(), v.value)
    i = Math.max(v.end, i + m[0].length)
  }
  return out
}

/** Entries of a .bib file: key, type, author, year (or the date's year) and title. Tolerates broken entries. */
export function indexBib(text: string, fileId: string): BibEntry[] {
  const out: BibEntry[] = []
  const strings = new Map<string, string>()
  ENTRY_START.lastIndex = 0
  for (let r = ENTRY_START.exec(text); r; r = ENTRY_START.exec(text)) {
    const type = (r[1] ?? '').toLowerCase()
    const start = r.index + r[0].length
    const end = entryEnd(text, start, r[2] ?? '{')
    ENTRY_START.lastIndex = Math.max(end, start)
    const body = text.slice(start, end)
    if (type === 'comment' || type === 'preamble') continue
    if (type === 'string') {
      for (const [k, v] of fields(body, strings)) strings.set(k, v)
      continue
    }
    const comma = body.indexOf(',')
    const key = (comma === -1 ? body : body.slice(0, comma)).trim()
    if (!key || /[\s{}"=]/.test(key)) continue
    const f = comma === -1 ? new Map<string, string>() : fields(body.slice(comma + 1), strings)
    const title = cleanValue(f.get('title') ?? '')
    const author = cleanValue(f.get('author') ?? f.get('editor') ?? '')
    const year = cleanValue(f.get('year') ?? '') || (/\d{4}/.exec(f.get('date') ?? '')?.[0] ?? '')
    out.push({ key, fileId, type, ...(title ? { title } : {}), ...(author ? { author } : {}), ...(year ? { year } : {}) })
  }
  return out
}

// ---------- the whole project ----------

export interface IndexedFile {
  id: string
  /** Path from the project root, e.g. "chapters/intro.tex". */
  path: string
  kind: 'folder' | 'text' | 'binary'
}

const TEX_FILE = /\.(tex|ltx|sty|cls)$/i
const BIB_FILE = /\.bib$/i

/** Per-file index results for the whole project; getters return arrays cached until the next change. */
export class ProjectIndex {
  private tex = new Map<string, TexIndex>()
  private bib = new Map<string, BibEntry[]>()
  /** What each file was indexed from: its text and how it was parsed (a rename can change that, not the text). */
  private indexed = new Map<string, { text: string; bib: boolean }>()
  private paths = new Map<string, string>()
  private allPaths: string[] = []
  private cache: { labels?: LabelEntry[]; bib?: BibEntry[]; defs?: UserDefinition[] } = {}
  /** Bumped on every change, so consumers can cache what they build from the index. */
  version = 0

  /**
   * Index a file's text (by its name's extension). Skipped when neither the text nor the kind of file changed,
   * so calling it for every file after a rename is cheap; returns whether anything changed.
   */
  update(fileId: string, name: string, text: string): boolean {
    const bib = BIB_FILE.test(name)
    if (!bib && !TEX_FILE.test(name)) return this.remove(fileId)
    const before = this.indexed.get(fileId)
    if (before && before.text === text && before.bib === bib) return false
    if (bib) {
      this.bib.set(fileId, indexBib(text, fileId))
      this.tex.delete(fileId)
    } else {
      this.tex.set(fileId, indexTex(text, fileId))
      this.bib.delete(fileId)
    }
    this.indexed.set(fileId, { text, bib })
    this.changed()
    return true
  }

  remove(fileId: string): boolean {
    const had = this.indexed.delete(fileId)
    this.tex.delete(fileId)
    this.bib.delete(fileId)
    if (had) this.changed()
    return had
  }

  /** Forget every file not in `ids` (deleted from the project). */
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids)
    for (const id of [...this.indexed.keys()]) if (!keep.has(id)) this.remove(id)
  }

  /** The project's files and folders (for file-path suggestions and for showing where a label is). */
  setFiles(files: readonly IndexedFile[]): void {
    this.paths = new Map(files.map(f => [f.id, f.path]))
    this.allPaths = files.filter(f => f.kind !== 'folder').map(f => f.path)
    this.changed()
  }

  pathOf(fileId: string): string | undefined {
    return this.paths.get(fileId)
  }

  /** Paths of every file (not folders) from the project root. */
  filePaths(): readonly string[] {
    return this.allPaths
  }

  labels(): readonly LabelEntry[] {
    return (this.cache.labels ??= [...this.tex.values()].flatMap(t => t.labels))
  }

  bibEntries(): readonly BibEntry[] {
    return (this.cache.bib ??= [...this.bib.values()].flat())
  }

  /** The project's own commands and environments; the first definition of a name wins. */
  definitions(): readonly UserDefinition[] {
    if (this.cache.defs) return this.cache.defs
    const seen = new Set<string>()
    const out: UserDefinition[] = []
    for (const t of this.tex.values()) {
      for (const d of t.definitions) {
        const k = `${d.kind}:${d.name}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push(d)
      }
    }
    return (this.cache.defs = out)
  }

  private changed(): void {
    this.cache = {}
    this.version++
  }
}
