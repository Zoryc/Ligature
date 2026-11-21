/**
 * Search in all files (docs/RENAME-AND-REPLACE.md §5): plain text, matched literally, with match case and whole
 * word. Pure; the Search panel shows the results and Replace all finds the matches again with `findAll` on each
 * file's live text.
 */

export interface SearchOptions {
  matchCase: boolean
  /** Not preceded or followed by a letter, digit or `_`. */
  wholeWord: boolean
}

export interface TextRange { from: number; to: number }

/** Results shown at most; the counts stay exact beyond it. */
export const MAX_RESULTS = 2000

/** Characters with a meaning in a regular expression (in unicode mode, escaping anything else is an error). */
const SPECIAL = /[\\^$.*+?()[\]{}|/]/g

function pattern(query: string, opts: SearchOptions): RegExp {
  const literal = query.replace(SPECIAL, '\\$&')
  const body = opts.wholeWord ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal
  return new RegExp(body, opts.matchCase ? 'gu' : 'giu')
}

/** Every match of `query` in `text`, in order, never overlapping. The empty query finds nothing. */
export function findAll(text: string, query: string, opts: SearchOptions): TextRange[] {
  if (!query) return []
  const out: TextRange[] = []
  const re = pattern(query, opts)
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ from: m.index, to: m.index + m[0].length })
  }
  return out
}

/** One result: where it is (1-based line, 0-based column) and its line, cut around the match when long. */
export interface SearchResult {
  from: number
  to: number
  line: number
  column: number
  before: string
  match: string
  after: string
}

export interface FileResults {
  fileId: string
  /** Matches in this file (exact, even when not all are shown). */
  count: number
  results: SearchResult[]
}

export interface SearchSummary {
  /** Files with at least one match, in the order given. */
  files: FileResults[]
  total: number
  /** Fewer results are shown than there are. */
  capped: boolean
}

/** Characters kept before a match, and after it, in a result's line. */
const BEFORE = 32
const AFTER = 120

/** The match's line, cut to show the match. */
function excerpt(text: string, r: TextRange): Pick<SearchResult, 'before' | 'match' | 'after'> {
  const start = text.lastIndexOf('\n', r.from - 1) + 1
  let end = text.indexOf('\n', r.from)
  if (end === -1) end = text.length
  const lineEnd = text[end - 1] === '\r' ? end - 1 : end
  const head = text.slice(Math.max(start, r.from - BEFORE), r.from).trimStart()
  const before = r.from - start > BEFORE ? `…${head}` : head
  const matchEnd = Math.min(r.to, lineEnd)
  return { before, match: text.slice(r.from, Math.max(r.from, matchEnd)), after: text.slice(matchEnd, Math.min(lineEnd, matchEnd + AFTER)) }
}

/** Search `files` (each with its text) for `query`; at most `cap` results are built, the counts are exact. */
export function searchFiles(
  files: readonly { id: string; text: string }[], query: string, opts: SearchOptions, cap = MAX_RESULTS,
): SearchSummary {
  const out: FileResults[] = []
  let total = 0
  let shown = 0
  for (const f of files) {
    const ranges = findAll(f.text, query, opts)
    if (!ranges.length) continue
    const results: SearchResult[] = []
    let line = 1
    let at = 0
    let lineStart = 0
    for (const r of ranges) {
      if (shown >= cap) break
      for (; at < r.from; at++) {
        if (f.text[at] === '\n') {
          line++
          lineStart = at + 1
        }
      }
      results.push({ from: r.from, to: r.to, line, column: r.from - lineStart, ...excerpt(f.text, r) })
      shown++
    }
    total += ranges.length
    out.push({ fileId: f.id, count: ranges.length, results })
  }
  return { files: out, total, capped: shown < total }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "12 results in 3 files", "No results", or past the cap "2 000+ results; refine the search". */
export function summaryText(s: SearchSummary): string {
  if (s.total === 0) return 'No results'
  if (s.capped) return '2 000+ results; refine the search'
  return `${count(s.total, 'result', 'results')} in ${count(s.files.length, 'file', 'files')}`
}

/** "Replace 12 in 3 files": the Replace all button. */
export function replaceLabel(s: SearchSummary): string {
  return `Replace ${s.total} in ${count(s.files.length, 'file', 'files')}`
}

/** A search: its query and options. */
export interface SearchRequest { query: string; opts: SearchOptions }

/**
 * Are the results of `searched` the ones for what the fields say `now`? Not while they lag a change of the query
 * or of a toggle (the debounce): Replace all would then use a file list made for another search.
 */
export function sameSearch(searched: SearchRequest, now: SearchRequest): boolean {
  return searched.query === now.query
    && searched.opts.matchCase === now.opts.matchCase
    && searched.opts.wholeWord === now.opts.wholeWord
}
