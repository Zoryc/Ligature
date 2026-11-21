/**
 * The Contents outline: the document's headings across all files, following \input / \include from the
 * main file (Folio design). Pure functions; the project page supplies the texts.
 */

export type HeadingKind = 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'paragraph'
const LEVEL: Record<HeadingKind, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 }

/** One item found in a file, in order. */
export type SourceItem =
  | { type: 'heading'; kind: HeadingKind; title: string; starred: boolean; line: number }
  | { type: 'special'; title: string; line: number } // Abstract, References
  | { type: 'appendix'; line: number }
  | { type: 'input'; path: string; line: number }

export interface OutlineEntry {
  fileId: string
  line: number
  title: string
  /** 0 = top level of this document. */
  depth: number
  /** "2.1", "A", or '' (starred headings, Abstract, References). */
  number: string
  /** Abstract, References and starred headings are set in italics. */
  unnumbered: boolean
}

/**
 * Blank out comments (keeping line structure): `%` up to the end of the line, unless escaped.
 * Shared with the autocomplete project index (latex/projectIndex.ts).
 */
export function stripComments(text: string): string {
  return text.replace(/(^|[^\\])%.*$/gm, '$1')
}

/** The balanced {...} group starting at `i` (text[i] === '{'); returns its content and the index after it. */
export function group(text: string, i: number): { content: string; end: number } | null {
  if (text[i] !== '{') return null
  let depth = 0
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') { j++; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return { content: text.slice(i + 1, j), end: j + 1 }
  }
  return null
}

export interface Group { content: string; end: number }

/** Argument lookups over one text, each O(1): see `groups`. */
export interface Groups {
  /** The balanced {...} group at `i`; null when there is none, it never closes, or its content is longer than `max`. */
  brace(i: number, max?: number): Group | null
  /** The [...] group at `i` (brackets count at its own brace level only); null like `brace`. */
  bracket(i: number, max?: number): Group | null
}

/**
 * Every `{` and `[` of `text` matched with its closer in one pass. Scanning forward from each command instead
 * (like `group`) costs O(n) per unclosed group, so a file of a repeated unclosed `\label{` would take minutes
 * to index; this keeps whole-file scans linear whatever the text.
 */
export function groups(text: string): Groups {
  const close = new Int32Array(text.length).fill(-1)
  const braces: number[] = []
  // Open brackets per brace level: a `]` inside {...} does not close a `[` outside it.
  const brackets: number[][] = [[]]
  for (let j = 0; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') j++
    else if (c === '{') {
      braces.push(j)
      brackets.push([])
    } else if (c === '}') {
      const open = braces.pop()
      if (open !== undefined) {
        close[open] = j
        brackets.pop()
      }
    } else if (c === '[') brackets[brackets.length - 1]?.push(j)
    else if (c === ']') {
      const open = brackets[brackets.length - 1]?.pop()
      if (open !== undefined) close[open] = j
    }
  }
  const at = (opener: string) => (i: number, max = Infinity): Group | null => {
    const j = text[i] === opener ? close[i] ?? -1 : -1
    return j === -1 || j - i - 1 > max ? null : { content: text.slice(i + 1, j), end: j + 1 }
  }
  return { brace: at('{'), bracket: at('[') }
}

/** Headings longer than this (in source characters) are cut: keeps the work per heading bounded. */
const MAX_TITLE_SOURCE = 500

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ',
  Psi: 'Ψ', Omega: 'Ω',
}

/** Readable text of a heading: drop markup, keep words (and Greek letters). */
export function plainTitle(tex: string): string {
  return tex.slice(0, MAX_TITLE_SOURCE)
    .replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (all, name: string) => GREEK[name] ?? all)
    .replace(/\\(?:label|index|footnote|cite\w*|ref)\s*\{[^}]*\}/g, '')
    .replace(/\\(?:\\|newline|linebreak)(?:\[[^\]]*\])?/g, ' ')
    .replace(/\$([^$]*)\$/g, '$1')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\[A-Za-z@]+\*?\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/--/g, '–')
    .replace(/\s+/g, ' ')
    .trim()
}

const COMMAND = /\\(part|chapter|section|subsection|subsubsection|paragraph|input|include|subfile|appendix|printbibliography|bibliography|begin\s*\{abstract\})(\*?)/g

/** A function from a text offset to its 1-based line (binary search over the line starts). */
export function lineLocator(text: string): (pos: number) => number {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return (pos: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] ?? 0) <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** Items read per file at most: no real file has more headings, and it bounds the work on a planted one. */
const MAX_ITEMS = 5000

/** Headings, inputs and special items of one file, in order (1-based lines). */
export function scanSource(raw: string): SourceItem[] {
  const text = stripComments(raw)
  const out: SourceItem[] = []
  const lineAt = lineLocator(text)
  const args = groups(text)
  COMMAND.lastIndex = 0
  for (let r = COMMAND.exec(text); r && out.length < MAX_ITEMS; r = COMMAND.exec(text)) {
    const name = r[1] ?? ''
    const starred = r[2] === '*'
    const line = lineAt(r.index)
    let i = r.index + r[0].length
    // A longer command that starts with one of ours (\sectionmark, \includegraphics, \inputencoding): skip.
    if (/[A-Za-z@]/.test(text[i] ?? '') && !name.startsWith('begin')) continue
    if (name === 'appendix') { out.push({ type: 'appendix', line }); continue }
    if (name.startsWith('begin')) { out.push({ type: 'special', title: 'Abstract', line }); continue }
    if (name === 'printbibliography' || name === 'bibliography') { out.push({ type: 'special', title: 'References', line }); continue }
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') i++
    if (name === 'input' || name === 'include' || name === 'subfile') {
      const g = args.brace(i, 1000)
      if (g && g.content.trim()) out.push({ type: 'input', path: g.content.trim(), line })
      continue
    }
    if (text[i] === '[') { // optional short title: skip it
      const short = args.bracket(i)
      if (!short) continue
      i = short.end
      while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') i++
    }
    const g = args.brace(i)
    if (!g) continue
    out.push({ type: 'heading', kind: name as HeadingKind, title: plainTitle(g.content) || '(untitled)', starred, line })
  }
  return out
}

export interface OutlineSource {
  mainFileId: string
  /** A file's current text (null: not loaded or not a text file). */
  text: (fileId: string) => string | null
  /** The file an \input path names, relative to the main file's folder (null: not in the project). */
  resolve: (path: string) => string | null
}

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The whole document's outline, following \input/\include from the main file (each file once). */
export function buildOutline(src: OutlineSource): OutlineEntry[] {
  const flat: { fileId: string; item: Exclude<SourceItem, { type: 'input' }> }[] = []
  const seen = new Set<string>()
  const walk = (fileId: string, depth: number) => {
    if (seen.has(fileId) || depth > 16) return
    seen.add(fileId)
    const text = src.text(fileId)
    if (text === null) return
    for (const item of scanSource(text)) {
      if (item.type === 'input') {
        const target = src.resolve(item.path)
        if (target) walk(target, depth + 1)
      } else {
        flat.push({ fileId, item })
      }
    }
  }
  walk(src.mainFileId, 0)

  const levels = flat.flatMap(f => (f.item.type === 'heading' ? [LEVEL[f.item.kind]] : []))
  const top = levels.length ? Math.min(...levels.filter(l => l > 0), 5) : LEVEL.section
  const counters = [0, 0, 0, 0, 0, 0]
  let appendix = false
  const out: OutlineEntry[] = []
  for (const { fileId, item } of flat) {
    if (item.type === 'appendix') {
      appendix = true
      counters.fill(0)
      continue
    }
    if (item.type === 'special') {
      out.push({ fileId, line: item.line, title: item.title, depth: 0, number: '', unnumbered: true })
      continue
    }
    const level = LEVEL[item.kind]
    if (level === 0) { // parts: shown at the top level, not numbered with the sections
      out.push({ fileId, line: item.line, title: item.title, depth: 0, number: '', unnumbered: true })
      continue
    }
    const depth = Math.max(0, level - top)
    let number = ''
    if (!item.starred && depth <= 2) {
      counters[depth] = (counters[depth] ?? 0) + 1
      for (let d = depth + 1; d < counters.length; d++) counters[d] = 0
      const parts = counters.slice(0, depth + 1).map((n, d) => (d === 0 && appendix ? ALPHA[(n - 1) % 26] ?? String(n) : String(n)))
      number = parts.join('.')
    }
    out.push({ fileId, line: item.line, title: item.title, depth, number, unnumbered: item.starred })
  }
  return out
}

/** The worst problem inside each entry's part of its file (up to the next entry of the same file). */
export function entryMarks(
  entries: OutlineEntry[], problems: (fileId: string) => { line: number; severity: string }[],
): ('error' | 'warning' | null)[] {
  return entries.map((e, i) => {
    let end = Infinity
    for (let j = i + 1; j < entries.length; j++) {
      const n = entries[j]
      if (n && n.fileId === e.fileId && n.line > e.line) { end = n.line; break }
    }
    let mark: 'error' | 'warning' | null = null
    for (const p of problems(e.fileId)) {
      if (p.line < e.line || p.line >= end) continue
      if (p.severity === 'error') return 'error'
      if (p.severity === 'warning') mark = 'warning'
    }
    return mark
  })
}

/** Resolve an \input path like TeX: relative to the main file's folder, with or without ".tex". */
export function resolveInput(path: string, mainDir: string, files: Map<string, { id: string }>): string | null {
  const clean = path.replace(/^\.\//, '').replace(/"/g, '')
  const base = mainDir && !clean.startsWith('/') ? `${mainDir}/${clean}` : clean.replace(/^\//, '')
  for (const p of [base, `${base}.tex`]) {
    const f = files.get(normalize(p))
    if (f) return f.id
  }
  return null
}

/** Resolve `.` and `..` segments and drop empty ones ("a/./b/../c" -> "a/c"). */
export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}
