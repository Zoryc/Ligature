import { DEFAULT_MAX_RECORDS, edit, view, type SynctexIndex } from '@ligature/synctex'
import type { PdfRect, SynctexEditResponse } from '@ligature/shared'
import { ApiError, notFound } from '../errors.ts'
import { loadBuildSynctex, MAX_SYNCTEX_BYTES } from './builds.ts'
import { findInputsSrcRoot, PathMap, relativeTo } from './buildPaths.ts'
import { SynctexParsePool } from './synctexPool.ts'

/*
 * SyncTeX queries against stored builds (docs/M2.md §3). Paths in a synctex file are absolute paths of
 * the build's `src/` dir; they are mapped to project files with the build's path map, and anything that is
 * not a file of the build (TeX Live, the out dir's .aux) is never returned. Files are gunzipped and parsed
 * in a worker thread (never on the event loop); parsed indexes are cached per build in an LRU bounded by
 * build count and by total records.
 */

export interface SynctexCacheOptions {
  /** Builds kept parsed (default 8). */
  maxBuilds?: number
  /** Total records over all cached builds (default 3,000,000, about 150 MB). The newest build is always kept. */
  maxRecords?: number
  /** Largest gunzipped synctex file accepted, in bytes (default 50 MiB). */
  maxBytes?: number
  /**
   * Most records parsed per build (default: half of `maxRecords`, at most the parser's 2,000,000), so the
   * two most recent builds always fit together and alternating between them never re-parses.
   */
  maxRecordsPerBuild?: number
  /** Distinct builds being parsed at once (default 4); a further cache miss gets `503 synctex-busy`. */
  maxPendingParses?: number
}

export const DEFAULT_SYNCTEX_CACHE_BUILDS = 8
export const DEFAULT_SYNCTEX_CACHE_RECORDS = 3_000_000
export const DEFAULT_SYNCTEX_PENDING_PARSES = 4
/** Unusable synctex files remembered (outside the LRU, so they never evict parsed builds). */
const MAX_UNUSABLE = 256

interface ProjectInput { fileId: string; path: string }

interface Loaded {
  index: SynctexIndex
  /** Input path (as stored in the index) -> project file, for inputs that are files of the build. */
  byInput: Map<string, ProjectInput>
  /** File id -> its input paths (as stored in the index). */
  inputsOf: Map<string, string[]>
  /** Cache weight. */
  records: number
}

export interface ViewParams { fileId: string; line: number; column?: number }
export interface EditParams { page: number; x: number; y: number }

export interface QueryOptions {
  /**
   * Called before a cache miss starts a parse (not when the build is cached, already being parsed, or
   * known to be unusable); throw to refuse it (the route applies the per-user parse rate limit).
   */
  admit?: () => void
}

export class SynctexCache {
  private readonly lru = new Map<string, Loaded>()
  /** Builds whose synctex file exists but cannot be used (too large, corrupt), oldest first. */
  private readonly unusable = new Set<string>()
  /** Parses in progress, shared by concurrent queries for the same build. */
  private readonly inflight = new Map<string, Promise<Loaded | null>>()
  private readonly pool = new SynctexParsePool()
  private total = 0
  private readonly maxBuilds: number
  private readonly maxRecords: number
  private readonly maxBytes: number
  private readonly maxRecordsPerBuild: number
  private readonly maxPending: number
  /** Number of synctex files parsed (for tests and diagnostics). */
  parses = 0

  constructor(private readonly outputsDir: string, opts: SynctexCacheOptions = {}) {
    this.maxBuilds = Math.max(1, opts.maxBuilds ?? DEFAULT_SYNCTEX_CACHE_BUILDS)
    this.maxRecords = Math.max(1, opts.maxRecords ?? DEFAULT_SYNCTEX_CACHE_RECORDS)
    this.maxBytes = opts.maxBytes ?? MAX_SYNCTEX_BYTES
    this.maxRecordsPerBuild = Math.max(1, opts.maxRecordsPerBuild ?? Math.min(DEFAULT_MAX_RECORDS, Math.floor(this.maxRecords / 2)))
    this.maxPending = Math.max(1, opts.maxPendingParses ?? DEFAULT_SYNCTEX_PENDING_PARSES)
  }

  /** Cached builds, least recently used first (`projectId/buildId`). */
  get cached(): string[] {
    return [...this.lru.keys()]
  }

  get cachedRecords(): number {
    return this.total
  }

  /** Stop the parser thread (pending queries fail). */
  close(): Promise<void> {
    return this.pool.close()
  }

  /** Forward search: boxes for a line of a project file, all on one page; [] if the file has none. */
  async view(projectId: string, buildId: string, q: ViewParams, opts: QueryOptions = {}): Promise<PdfRect[]> {
    const b = await this.load(projectId, buildId, opts)
    for (const input of b.inputsOf.get(q.fileId) ?? []) {
      const boxes = view(b.index, { path: input, line: q.line, ...(q.column !== undefined ? { column: q.column } : {}) })
      if (boxes.length > 0) return boxes
    }
    return []
  }

  /** Inverse search: the project file and line at a point of a page, or null when nothing maps there. */
  async edit(projectId: string, buildId: string, q: EditParams, opts: QueryOptions = {}): Promise<SynctexEditResponse | null> {
    const b = await this.load(projectId, buildId, opts)
    if (b.byInput.size === 0) return null
    const r = edit(b.index, q, { accept: p => b.byInput.has(p) })
    const file = r ? b.byInput.get(r.path) : undefined
    if (!r || !file) return null
    return { fileId: file.fileId, path: file.path, line: r.line, column: r.column }
  }

  /**
   * The parsed build, from the cache or parsed in the worker thread; `404 not-found` when the build or its
   * synctex is missing or unusable, `503 synctex-busy` when too many builds are being parsed already.
   */
  private async load(projectId: string, buildId: string, opts: QueryOptions): Promise<Loaded> {
    const key = `${projectId}/${buildId}`
    const hit = this.lru.get(key)
    if (hit) {
      this.lru.delete(key) // move to the most-recent end
      this.lru.set(key, hit)
      return hit
    }
    if (this.unusable.has(key)) throw notFound('This build has no usable SyncTeX data')
    let p = this.inflight.get(key)
    if (!p) {
      const raw = loadBuildSynctex(this.outputsDir, projectId, buildId)
      if (!raw) throw notFound('This build has no SyncTeX data')
      if (this.inflight.size >= this.maxPending) throw new ApiError(503, 'synctex-busy', 'SyncTeX is busy; try again in a moment')
      opts.admit?.()
      p = this.parse(key, projectId, raw.gz, raw.paths).finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    const loaded = await p
    if (!loaded) throw notFound('This build has no usable SyncTeX data')
    return loaded
  }

  private async parse(key: string, projectId: string, gz: Buffer, paths: Record<string, string>): Promise<Loaded | null> {
    this.parses++
    const index = await this.pool.parse(gz, this.maxBytes, this.maxRecordsPerBuild)
    if (!index) {
      this.unusable.add(key)
      if (this.unusable.size > MAX_UNUSABLE) this.unusable.delete(this.unusable.values().next().value!)
      return null
    }
    const map = new PathMap(paths)
    const root = findInputsSrcRoot(index.inputs.values(), projectId, map)
    const byInput = new Map<string, ProjectInput>()
    const inputsOf = new Map<string, string[]>()
    if (root !== undefined) {
      for (const input of new Set(index.inputs.values())) {
        const rel = relativeTo(root, input)
        const fileId = rel === null ? undefined : map.fileId(rel)
        if (fileId === undefined) continue
        byInput.set(input, { fileId, path: map.pathOf(fileId) ?? rel! })
        const list = inputsOf.get(fileId) ?? []
        list.push(input)
        inputsOf.set(fileId, list)
      }
    }
    const loaded: Loaded = { index, byInput, inputsOf, records: index.count }
    this.insert(key, loaded)
    return loaded
  }

  private insert(key: string, entry: Loaded): void {
    this.lru.set(key, entry)
    this.total += entry.records
    for (const [k, e] of this.lru) {
      if (this.lru.size <= this.maxBuilds && this.total <= this.maxRecords) break
      if (k === key) continue // the newest build always stays
      this.lru.delete(k)
      this.total -= e.records
    }
  }
}
