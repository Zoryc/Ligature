/** The worker's operations, independent of HTTP. Inputs are already validated by the caller. */
import { lstat, readdir, rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { isUuid, type CompileResponse, type Manifest, type OutputName } from './contract.ts'
import { BlobStore } from './blobStore.ts'
import { MAX_BLOB_BYTES } from './limits.ts'
import { OutputStore } from './outputStore.ts'
import { runCompile, type RunnerDeps } from './runner.ts'
import type { Sandbox } from './sandbox/index.ts'
import type { ValidCompileRequest } from './validate.ts'

/** How often the caches are swept. */
const GC_INTERVAL_MS = 3600_000
/** A blob used this recently is never evicted (covers the gap between a sync and its compile). */
const BLOB_MIN_AGE_MS = 15 * 60_000

export interface ServiceOptions {
  buildsDir: string
  sandbox: Sandbox
  latexmk: string[]
  helperArgv: string[]
  maxTimeoutMs: number
  quota: { bytes: number; entries: number }
  blobCache: { maxBytes: number; maxAgeMs: number }
  buildDirMaxIdleMs: number
  minFreeBytes: number
}

export class MissingBlobsError extends Error {
  readonly missing: string[]
  constructor(missing: string[]) {
    super(`${missing.length} blob(s) missing`)
    this.missing = missing
  }
}

export interface GcReport { blobsRemoved: number; blobBytesFreed: number; blobBytesKept: number; buildDirsRemoved: number }

export class CompilerService {
  readonly blobs: BlobStore
  readonly outputs: OutputStore
  readonly maxTimeoutMs: number
  readonly sandboxKind: string
  private readonly deps: RunnerDeps
  private readonly o: ServiceOptions
  /** Per-project serialisation: one compile (or eviction) at a time touches a project directory. */
  private readonly locks = new Map<string, Promise<unknown>>()
  private gcTimer: NodeJS.Timeout | null = null
  private gcRunning: Promise<GcReport> | null = null

  constructor(o: ServiceOptions) {
    this.o = o
    this.sandboxKind = o.sandbox.kind
    this.maxTimeoutMs = o.maxTimeoutMs
    this.blobs = new BlobStore(join(o.buildsDir, '.blobs'), MAX_BLOB_BYTES)
    this.outputs = new OutputStore(join(o.buildsDir, '.outputs'))
    this.deps = {
      buildsDir: o.buildsDir, blobs: this.blobs, outputs: this.outputs, sandbox: o.sandbox,
      latexmk: o.latexmk, helperArgv: o.helperArgv, quota: o.quota,
    }
  }

  async init(): Promise<void> {
    await this.o.sandbox.init(this.o.buildsDir)
    await this.blobs.init()
    await this.outputs.init()
    // Sweep now (in the background: start-up does not wait for it) and then periodically.
    void this.gc()
    this.gcTimer = setInterval(() => { void this.gc() }, GC_INTERVAL_MS)
    this.gcTimer.unref()
  }

  close(): void {
    if (this.gcTimer) clearInterval(this.gcTimer)
    this.gcTimer = null
  }

  /** Hashes referenced by the manifest that the cache lacks. */
  sync(manifest: Manifest): Promise<string[]> {
    return this.blobs.missing(Object.values(manifest))
  }

  async putBlob(hash: string, body: Readable): Promise<void> {
    if (await this.blobs.has(hash)) await this.blobs.verifyOnly(hash, body)
    else await this.blobs.put(hash, body)
  }

  async compile(projectId: string, req: ValidCompileRequest): Promise<CompileResponse> {
    const missing = await this.blobs.missing(Object.values(req.manifest))
    if (missing.length) throw new MissingBlobsError(missing)
    const low = await this.lowDisk()
    if (low) return { status: 'error', durationMs: 0, outputs: [], log: `[ligature: ${low}]\n` }
    return this.serialized(projectId, async () => {
      try {
        return await runCompile(this.deps, projectId, req)
      } finally {
        await this.outputs.touch(projectId)
      }
    })
  }

  /**
   * Answer a compile whose main file cannot be built (see validate.ts mainFileProblem) without running
   * anything: a `failure` whose log explains the problem. Like any failed build, it withdraws the
   * outputs of the previous build.
   */
  rejectMainFile(projectId: string, problem: string): Promise<CompileResponse> {
    return this.serialized(projectId, async () => {
      const empty = await this.outputs.begin(projectId)
      await empty.commit()
      await this.outputs.touch(projectId)
      return { status: 'failure', durationMs: 0, outputs: [], log: `[ligature: ${problem}]\n` }
    })
  }

  output(projectId: string, name: OutputName) {
    return this.outputs.open(projectId, name)
  }

  /** Free space of BUILDS_DIR; null if unknown (statfs unsupported). */
  async freeBytes(): Promise<number | null> {
    try {
      const s = await statfs(this.o.buildsDir)
      return s.bavail * s.bsize
    } catch {
      return null
    }
  }

  /** Evict unused blobs and idle build directories. Concurrent calls share one run. */
  gc(now = Date.now()): Promise<GcReport> {
    this.gcRunning ??= this.runGc(now).finally(() => { this.gcRunning = null })
    return this.gcRunning
  }

  /** Null, or why the build volume is too full to compile (after trying to make room). */
  private async lowDisk(): Promise<string | null> {
    if (this.o.minFreeBytes <= 0) return null
    if ((await this.freeBytes() ?? Infinity) >= this.o.minFreeBytes) return null
    await this.gc()
    const free = await this.freeBytes() ?? Infinity
    if (free >= this.o.minFreeBytes) return null
    const mb = (n: number) => `${Math.floor(n / (1024 * 1024))} MB`
    return `the compile server's build volume has only ${mb(free)} free (minimum ${mb(this.o.minFreeBytes)}); ` +
      'compiling is paused until an administrator frees space'
  }

  private async runGc(now: number): Promise<GcReport> {
    const report: GcReport = { blobsRemoved: 0, blobBytesFreed: 0, blobBytesKept: 0, buildDirsRemoved: 0 }
    try {
      const b = await this.blobs.gc({ ...this.o.blobCache, minAgeMs: BLOB_MIN_AGE_MS, now })
      report.blobsRemoved = b.removed
      report.blobBytesFreed = b.freedBytes
      report.blobBytesKept = b.keptBytes
      report.buildDirsRemoved = await this.evictIdleProjects(now)
    } catch (e) {
      console.error('[compiler] cache sweep failed', e)
    }
    return report
  }

  /** When a project was last compiled: its output store directory is touched by every compile. */
  private async lastUsed(projectId: string): Promise<number> {
    for (const p of [join(this.outputs.dir, projectId), join(this.o.buildsDir, projectId)]) {
      try { return (await lstat(p)).mtimeMs } catch { /* try the next */ }
    }
    return 0
  }

  /** Delete the build directories (and stored outputs) of projects not compiled for buildDirMaxIdleMs. */
  private async evictIdleProjects(now: number): Promise<number> {
    let removed = 0
    const idle = async (id: string) => now - (await this.lastUsed(id)) > this.o.buildDirMaxIdleMs
    const ids = new Set([...await readdir(this.o.buildsDir), ...await readdir(this.outputs.dir)].filter(isUuid))
    for (const id of ids) {
      if (!(await idle(id))) continue
      await this.serialized(id, async () => {
        if (!(await idle(id))) return // compiled while we waited for the lock
        try {
          await this.o.sandbox.removeProject(id, join(this.o.buildsDir, id))
          await rm(join(this.outputs.dir, id), { recursive: true, force: true })
          removed++
        } catch (e) {
          console.error(`[compiler] could not remove the idle build dir of ${id}`, e)
        }
      })
    }
    return removed
  }

  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(fn)
    const tail = run.catch(() => undefined)
    this.locks.set(key, tail)
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key) })
    return run
  }
}
