/** File names in TeX logs: recognising them after `(`, and mapping them to project-relative paths. */

/** Longest file name we try to recognise (characters). */
const MAX_NAME = 1024

/** Extensions of files TeX commonly opens; preferred when a name with spaces could end at several dots. */
const KNOWN_EXT = new Set([
  'tex', 'ltx', 'sty', 'cls', 'clo', 'cfg', 'def', 'fd', 'dfu', 'ldf', 'dtx', 'ins', 'lua', 'aux', 'toc',
  'lof', 'lot', 'loa', 'lol', 'bbl', 'out', 'ind', 'gls', 'acr', 'nls', 'nav', 'snm', 'vrb', 'bib', 'bst', 'bbx',
  'cbx', 'lbx', 'dbx', 'mkii', 'mkiv', 'enc', 'map', 'tfm', 'vf', 'pfb', 'otf', 'ttf', 'ttc', 'png', 'jpg',
  'jpeg', 'pdf', 'eps', 'ps', 'mps', 'svg', 'txt', 'dat', 'csv', 'tikz', 'pgf', 'pdf_tex', 'pdftex', 'xdv', 'ist',
  'idx', 'thm', 'lco', 'dict', 'cpx', 'tpx', 'mtc', 'bmt', 'w18', 'ini', 'cnf', 'xmpdata', 'data',
])

const DELIMS = new Set([' ', '\t', ')', '(', '[', '{', '<', '"'])
const EXT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,9}$/

/** Forward slashes, lower-case drive letter, no trailing slash (except for a bare root). */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(s)) s = s[0]!.toLowerCase() + s.slice(1)
  s = s.replace(/(?<!^)\/{2,}/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p)
}

/** Resolve `.` and `..` in a relative path; null if it escapes upwards or is empty. */
function cleanRelative(p: string): string | null {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (/^\.{3,}$/.test(seg)) return null // "...\user\..." is a shortened path, not a project file
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  return out.length === 0 ? null : out.join('/')
}

/**
 * Returns a function mapping a file name from the log to a project-relative path, or null when the file is
 * not a project file (TeX Live, the out dir, anything else outside the source dir).
 */
export function projectPathMapper(rootDir: string | undefined): (name: string) => string | null {
  const root = rootDir === undefined || rootDir.trim() === '' ? null : normalizePath(rootDir.trim())
  return name => {
    const p = normalizePath(name)
    if (root !== null && root !== '/' && p.startsWith(root + '/')) return cleanRelative(p.slice(root.length + 1))
    if (isAbsolutePath(p) || p.startsWith('~')) return null
    return cleanRelative(p)
  }
}

/** True if `s` (text between `(` or line start and `:line:`) plausibly is a file name. */
export function looksLikeFileName(s: string): boolean {
  if (s === '' || s.length > MAX_NAME || /^\s/.test(s)) return false
  const anchored = s.startsWith('./') || s.startsWith('../') || isAbsolutePath(normalizePath(s))
  if (!anchored && /\s/.test(s)) return false
  const dot = s.lastIndexOf('.')
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return dot > slash && dot < s.length - 1 && EXT_RE.test(s.slice(dot + 1))
}

/**
 * The file name TeX printed right after the `(` at `open`, or null if the parenthesis does not open a file.
 * `end` is the index just past the name (past the closing quote for quoted names).
 */
export function fileNameAt(line: string, open: number): { name: string; end: number } | null {
  const start = open + 1
  if (line[start] === '"') {
    const close = line.indexOf('"', start + 1)
    if (close < 0 || close - start > MAX_NAME) return null
    const name = line.slice(start + 1, close)
    return looksLikeFileName(name) ? { name, end: close + 1 } : null
  }
  // The name runs at most to the next parenthesis or quote; it may contain spaces (pdfTeX and XeTeX don't quote).
  const limit = Math.min(line.length, start + MAX_NAME)
  let stop = regionEnd(line, start, limit)
  let region = line.slice(start, stop)
  if (region === '' || region[0] === ' ' || region[0] === '\t') return null
  const anchored = isAnchored(region)
  let j = nameEnd(region, anchored)
  // "./chapters/intro (old).tex": an anchored name may contain balanced parentheses; try that only when the text
  // before the parenthesis is no file name by itself.
  for (let tries = 0; j === null && anchored && tries < 4 && line[stop] === '('; tries++) {
    let close = -1
    for (let k = stop + 1; k < limit; k++) { // bounded: never scan the rest of a huge line
      const c = line[k]
      if (c === ')') {
        close = k
        break
      }
      if (c === '(' || c === '"') break
    }
    if (close < 0) break
    stop = regionEnd(line, close + 1, limit)
    region = line.slice(start, stop)
    j = nameEnd(region, anchored)
  }
  return j === null ? null : { name: region.slice(0, j), end: start + j }
}

/** Starts like a path that may contain spaces: ./x, ../x, /x, \x, C:/x, C:\x (cheap: called for every `(`). */
function isAnchored(s: string): boolean {
  const c0 = s[0]
  if (c0 === '/' || c0 === '\\') return true
  if (c0 === '.') return s[1] === '/' || s[1] === '\\' || (s[1] === '.' && (s[2] === '/' || s[2] === '\\'))
  return s[1] === ':' && (s[2] === '/' || s[2] === '\\') && /^[A-Za-z]/.test(s)
}

function regionEnd(line: string, from: number, limit: number): number {
  let k = from
  while (k < limit) {
    const c = line[k]
    if (c === '(' || c === ')' || c === '"' || c === '\n') break
    k++
  }
  return k
}

/**
 * Where the file name at the start of `region` ends: just after the first `.ext` followed by a delimiter or the
 * end of the region (a known TeX extension wins over others when the name contains spaces). Each candidate costs
 * O(extension length), so a hostile line full of dots stays linear.
 */
function nameEnd(region: string, anchored: boolean): number | null {
  const firstDot = region.indexOf('.')
  if (firstDot < 0) return null
  const firstSpace = region.search(/\s/)
  let generic: number | null = null
  for (let i = firstDot; i >= 0 && i < region.length - 1; i = region.indexOf('.', i + 1)) {
    if (firstSpace >= 0 && firstSpace < i && !anchored) break // unanchored names never contain spaces
    let j = i + 1
    while (j < region.length && j - i <= 11 && !DELIMS.has(region[j]!) && region[j] !== '.') j++
    if (j < region.length && !DELIMS.has(region[j]!)) continue // extension too long, or another dot follows
    const ext = region.slice(i + 1, j)
    if (!EXT_RE.test(ext) || i === 0 || region[i - 1] === '/') continue
    if (KNOWN_EXT.has(ext.toLowerCase())) return j
    if (firstSpace < 0 || firstSpace >= j) return j // no space inside: take it
    generic ??= j
  }
  return generic
}
