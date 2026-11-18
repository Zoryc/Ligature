/*
 * Mapping paths seen by TeX during a build (log file names, SyncTeX inputs) back to project files.
 *
 * The worker materialises a build's sources in `<BUILDS_DIR>/<projectId>/src/` (latexmk's cwd) and writes
 * outputs to `.../out/`. TeX prints project files relative to the cwd (`./chapters/intro.tex`) in the log,
 * and as absolute paths of the `src/` dir in the SyncTeX file. The worker does not report that directory,
 * so it is recovered from the text itself (docs/M2.md §2–§3): the `/<projectId>/src/` segment when present,
 * else a `/src/` segment followed by a path of the build's path map.
 */

/** Forward slashes, lower-case drive letter (`C:\x` -> `c:/x`). */
export function canonicalPath(p: string): string {
  const s = p.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s
}

/**
 * A build's path map (`project-relative path -> file id`) with lookups both ways. Path lookups are exact
 * first, then case-insensitive (project paths are unique case-insensitively, docs/M1.md, and TeX on a
 * case-insensitive file system prints the spelling used in `\input`).
 */
export class PathMap {
  private readonly lower = new Map<string, string>()
  private readonly byId = new Map<string, string>()

  constructor(private readonly paths: Readonly<Record<string, string>>) {
    for (const [path, id] of Object.entries(paths)) {
      this.lower.set(path.toLowerCase(), id)
      this.byId.set(id, path)
    }
  }

  /** File id of a project-relative path, or undefined when it is not a file of this build. */
  fileId(rel: string): string | undefined {
    if (Object.hasOwn(this.paths, rel)) return this.paths[rel]
    return this.lower.get(rel.toLowerCase())
  }

  /** Project-relative path of a file id in this build. */
  pathOf(fileId: string): string | undefined {
    return this.byId.get(fileId)
  }

  /** Lower-cased paths of the map. */
  lowerKeys(): Iterable<string> {
    return this.lower.keys()
  }

  get size(): number {
    return this.byId.size
  }
}

/** Characters that end a file name when scanning backwards through a log line. */
const OPENERS = new Set(['(', '"', "'", '`', '<', '[', '{', '=', '\n', '\r'])
/** How far back from the `/src/` segment a path may start. */
const MAX_PREFIX = 4096
/** Stop looking after this many `/src/` segments (hostile logs). */
const MAX_CANDIDATES = 1000

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The build's `src/` directory as written in `text` (a TeX log), canonicalised (`/` separators, lower-case
 * drive), or undefined when no absolute path into it appears. Prefers `/<projectId>/src/`; otherwise the
 * first `/src/` segment that is followed by a path of the build (`paths`).
 */
export function findLogSrcRoot(text: string, projectId: string | undefined, paths: PathMap): string | undefined {
  const norm = text.replace(/\\/g, '/') // same length: indices carry over
  if (projectId !== undefined && projectId !== '') {
    const re = new RegExp(`/${escapeRe(projectId)}/src/`, 'gi')
    for (let m = re.exec(norm), n = 0; m !== null && n < MAX_CANDIDATES; m = re.exec(norm), n++) {
      const root = rootEndingAt(norm, m.index + m[0].length - 1)
      if (root !== undefined) return root
    }
  }
  let from = 0
  for (let n = 0; n < MAX_FALLBACK_CANDIDATES; n++) {
    const i = norm.indexOf('/src/', from)
    if (i < 0) break
    from = i + 1
    if (!startsWithBuildPath(norm, i + 5, paths)) continue
    const root = rootEndingAt(norm, i + 4)
    if (root !== undefined) return root
  }
  return undefined
}

/** `/src/` segments checked against the path map (each check is one pass over the map). */
const MAX_FALLBACK_CANDIDATES = 200

/** The absolute path that ends just before `end` (the `/` after `src`), scanning back to its start. */
function rootEndingAt(norm: string, end: number): string | undefined {
  let k = end - 1
  const stop = Math.max(0, end - MAX_PREFIX)
  while (k >= stop && !OPENERS.has(norm[k]!)) k--
  const segment = norm.slice(k + 1, end)
  // The first place an absolute path can start: `/` or a drive letter `X:/`.
  // (Not after `.` or `~`: `./src/x` and `~/src/x` are relative.)
  const m = /(?:^|[^A-Za-z0-9.~_-])([A-Za-z]:\/|\/)/.exec(segment)
  if (!m) return undefined
  const start = m.index + m[0].length - m[1]!.length
  const root = canonicalPath(segment.slice(start))
  return root.length > 1 ? root : undefined
}

/** True if a path of the build starts at `at` in `norm`, followed by a delimiter or the end of the text. */
function startsWithBuildPath(norm: string, at: number, paths: PathMap): boolean {
  const rest = norm.slice(at, at + MAX_PREFIX).toLowerCase()
  for (const key of paths.lowerKeys()) {
    if (!rest.startsWith(key)) continue
    const next = rest[key.length]
    if (next === undefined || /[\s)":]/.test(next)) return true
  }
  return false
}

/**
 * The `src/` root of SyncTeX inputs (canonical, see `canonicalPath`): the `/<projectId>/src` prefix when an
 * input has it, else the `.../src` prefix under which most inputs are files of the build (ties: shortest).
 */
export function findInputsSrcRoot(inputs: Iterable<string>, projectId: string | undefined, paths: PathMap): string | undefined {
  const all = [...inputs].map(canonicalPath)
  if (projectId !== undefined && projectId !== '') {
    const re = new RegExp(`/${escapeRe(projectId)}/src/`, 'i')
    for (const p of all) {
      const m = re.exec(p)
      if (m) return p.slice(0, m.index + m[0].length - 1)
    }
  }
  const votes = new Map<string, number>()
  for (const p of all) {
    const seen = new Set<string>()
    for (let i = p.indexOf('/src/'); i >= 0; i = p.indexOf('/src/', i + 1)) {
      const root = p.slice(0, i + 4)
      if (seen.has(root) || paths.fileId(p.slice(i + 5)) === undefined) continue
      seen.add(root)
      votes.set(root, (votes.get(root) ?? 0) + 1)
    }
  }
  let best: string | undefined
  let bestVotes = 0
  for (const [root, n] of votes) {
    if (n > bestVotes || (n === bestVotes && best !== undefined && root.length < best.length)) {
      best = root
      bestVotes = n
    }
  }
  return best
}

/** Project-relative path of `path` under `root` (both canonical), or null when it is outside. */
export function relativeTo(root: string, path: string): string | null {
  const p = canonicalPath(path)
  if (!p.startsWith(root + '/')) return null
  const rel = p.slice(root.length + 1)
  if (rel === '' || rel.split('/').some(s => s === '' || s === '.' || s === '..')) return null
  return rel
}
