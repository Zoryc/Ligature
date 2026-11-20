import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Y from 'yjs'
import { ENGINES, fileDocName, isValidRelPath, type BuildResult, type CompileStatus, type Diagnostic, type Engine, type Manifest } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import type { Collab } from '../collab/collab.ts'
import type { DocStore } from '../collab/docStore.ts'
import { ApiError } from '../errors.ts'
import { detectMainFile } from '../files/mainFile.ts'
import { projectEngine } from '../projects/repo.ts'
import { readProjectContent } from '../collab/barrier.ts'
import { buildDir, latestBuildRecord, writeBuildRecord, type BuildRecord } from './builds.ts'
import type { CompilerClient } from './compilerClient.ts'
import { computeDiagnostics, mergeDiagnostics } from './diagnostics.ts'
import { SynctexCache, type SynctexCacheOptions } from './synctex.ts'

export type { BuildResult } from '@ligature/shared'

/** Who asked for a build (BuildResult.startedBy is the display name). */
export interface BuildRequester { id: string; displayName: string }

export const NO_MAIN_FILE_MESSAGE = 'No main file: create main.tex or choose one in Settings'

interface Snapshot {
  treeVersion: number
  manifest: Manifest
  /** hash -> bytes, for text files (binaries are read from the blob store on demand) */
  textBlobs: Map<string, Buffer>
  binaryHashes: Set<string>
  /** Main file path; null when there is none and none could be detected. */
  mainFile: string | null
  /** Set when the main file was detected now (main_file_id was NULL): persist it. */
  detectedMainId: string | null
  engine: Engine
  stateVectors: Record<string, string>
  docSnapshots: Record<string, string>
  /** path -> file id */
  paths: Record<string, string>
}

export interface OrchestratorOptions {
  /** Builds running at once (compile slots). */
  concurrency: number
  /** Builds waiting for a slot, instance-wide, before new requests get `503 compiler-busy` (docs/M2.md §4). */
  maxQueue: number
  /** Builds one user may have waiting for a slot (fairness: one user cannot fill the queue); default 3. */
  maxQueuePerUser?: number
  /** Parsed SyncTeX indexes kept in memory (docs/M2.md §3). */
  synctexCache?: SynctexCacheOptions
  /** Called after a build finished with status `success` (the history takes a compile version). */
  onSuccess?: (projectId: string) => void
}

export const DEFAULT_MAX_COMPILE_QUEUE = 20
export const DEFAULT_MAX_COMPILE_QUEUE_PER_USER = 3

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

export const BUILD_FAILED_MESSAGE = 'The build failed: see the raw log (latexmk, biber or bibtex reported the problem).'
/**
 * A TeX error ("! ...") or a Biber error ("ERROR - ...", maybe behind "[123] Biber.pm:456> ") in the log. A fatal
 * error TeX writes to stderr ("! Unable to read an entire line---bufsize=200000.") may continue the console line
 * of the files it had opened: "(./main.tex (/x/article.cls))! Unable ...".
 */
const FAILURE_LINE_RES = [/^(?:[^\n]*?\))?! +(\S.*)$/m, /^(?:\[\d+\] [\w.]+:\d+> )?ERROR - (\S.*)$/m]
const FAILURE_LINE_MAX = 300

/**
 * A failed build must say why. When the parsed log has no error (the problem was only reported by latexmk,
 * biber or bibtex on the console, which the compiler appends to such a log), add one: the first "!" or
 * biber ERROR line of the log when there is one, else a pointer to the raw log. Null when not needed.
 */
export function buildFailureDiagnostic(status: CompileStatus, log: string, diagnostics: Diagnostic[]): Diagnostic | null {
  if (status === 'success' || diagnostics.some(d => d.severity === 'error')) return null
  let message = BUILD_FAILED_MESSAGE
  for (const re of FAILURE_LINE_RES) {
    const m = re.exec(log)
    if (!m) continue
    const line = m[1]!.trim()
    message = `The build failed: ${line.length > FAILURE_LINE_MAX ? `${line.slice(0, FAILURE_LINE_MAX - 1)}…` : line}`
    break
  }
  return { severity: 'error', kind: 'build', message }
}

/** Simple counting semaphore. */
class Semaphore {
  private waiters: (() => void)[] = []
  constructor(private free: number) {}
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--
    else await new Promise<void>(r => this.waiters.push(r))
    return () => { const w = this.waiters.shift(); if (w) w(); else this.free++ }
  }
}

export class CompileOrchestrator {
  private readonly global: Semaphore
  private readonly maxQueue: number
  private readonly maxQueuePerUser: number
  /** Builds created but not yet holding a compile slot. */
  private waiting = 0
  /** The same, per requesting user. */
  private readonly waitingByUser = new Map<string, number>()
  /** Per-project single flight: the running build, and at most one queued follow-up shared by all waiters. */
  private readonly inflight = new Map<string, { running: Promise<BuildResult>; next: Promise<BuildResult> | null }>()
  /** SyncTeX queries against stored builds, with the per-build index cache (docs/M2.md §3). */
  readonly synctex: SynctexCache
  private readonly onSuccess: ((projectId: string) => void) | undefined

  constructor(
    private readonly db: DB,
    private readonly store: DocStore,
    private readonly collab: Collab,
    private readonly compiler: CompilerClient,
    private readonly outputsDir: string,
    private readonly blobsDir: string,
    opts: OrchestratorOptions,
  ) {
    this.global = new Semaphore(Math.max(1, opts.concurrency))
    this.maxQueue = Math.max(0, opts.maxQueue)
    this.maxQueuePerUser = Math.max(1, opts.maxQueuePerUser ?? DEFAULT_MAX_COMPILE_QUEUE_PER_USER)
    this.synctex = new SynctexCache(outputsDir, opts.synctexCache)
    this.onSuccess = opts.onSuccess
  }

  /** Number of builds waiting for a compile slot. */
  get queueLength(): number {
    return this.waiting
  }

  /**
   * Request a compile. Requests made while a build runs collapse into one follow-up build (its
   * `startedBy` is whoever asked first). A request that would add a build while `maxQueue` builds are
   * already waiting, or while the requester already has `maxQueuePerUser` builds waiting, is refused with
   * `503 compiler-busy`; joining an existing follow-up never is.
   */
  compile(projectId: string, by: BuildRequester): Promise<BuildResult> {
    const st = this.inflight.get(projectId)
    if (st?.next) return st.next
    const mine = this.waitingByUser.get(by.id) ?? 0
    if (this.waiting >= this.maxQueue || mine >= this.maxQueuePerUser) {
      throw new ApiError(503, 'compiler-busy', 'The compiler is busy; try again in a moment')
    }
    this.waiting++
    this.waitingByUser.set(by.id, mine + 1)
    if (!st) {
      const running = this.run(projectId, by).finally(() => this.advance(projectId))
      this.inflight.set(projectId, { running, next: null })
      return running
    }
    st.next = st.running.catch(() => undefined).then(() => this.run(projectId, by))
    return st.next
  }

  private advance(projectId: string): void {
    const st = this.inflight.get(projectId)
    if (!st) return
    if (st.next) {
      const running = st.next.finally(() => this.advance(projectId))
      this.inflight.set(projectId, { running, next: null })
    } else {
      this.inflight.delete(projectId)
    }
  }

  /**
   * The snapshot barrier: read every file's current content in ONE synchronous pass (no await),
   * so no incoming update can interleave. Live docs are authoritative; closed docs use the compacted text mirror.
   */
  snapshot(projectId: string): Snapshot {
    const proj = projectEngine(this.db, projectId)
    if (!proj) throw new Error('project not found')
    const content = readProjectContent(this.db, this.store, this.collab, projectId)
    const treeVersion = content.treeVersion
    const filePathById = content.paths
    const manifest: Manifest = {}
    const textBlobs = new Map<string, Buffer>()
    const binaryHashes = new Set<string>()
    const stateVectors: Record<string, string> = {}
    const docSnapshots: Record<string, string> = {}
    const paths: Record<string, string> = {}
    const texts: { path: string; text: string; id: string }[] = []
    for (const f of content.files) {
      const path = f.path
      if (!isValidRelPath(path)) throw new Error(`invalid path in tree: ${JSON.stringify(path)}`)
      if (f.kind === 'text') {
        if (f.live) {
          stateVectors[f.id] = Buffer.from(Y.encodeStateVector(f.live)).toString('base64')
          docSnapshots[f.id] = Buffer.from(Y.encodeSnapshot(Y.snapshot(f.live))).toString('base64')
        }
        const buf = Buffer.from(f.text, 'utf8')
        const h = sha256(buf)
        manifest[path] = h
        textBlobs.set(h, buf)
        paths[path] = f.id
        texts.push({ path, text: f.text, id: f.id })
      } else {
        manifest[path] = f.blobHash
        binaryHashes.add(f.blobHash)
        paths[path] = f.id
      }
    }
    let mainFile = proj.mainFileId ? filePathById.get(proj.mainFileId) ?? null : null
    let detectedMainId: string | null = null
    if (mainFile === null) {
      mainFile = detectMainFile(texts)
      detectedMainId = mainFile === null ? null : paths[mainFile] ?? null
    }
    const engine = (ENGINES as readonly string[]).includes(proj.engine) ? proj.engine as Engine : 'pdflatex'
    return { treeVersion, manifest, textBlobs, binaryHashes, mainFile, detectedMainId, engine, stateVectors, docSnapshots, paths }
  }

  private async run(projectId: string, by: BuildRequester): Promise<BuildResult> {
    let release: () => void
    try {
      release = await this.global.acquire()
    } finally {
      this.waiting--
      const n = (this.waitingByUser.get(by.id) ?? 1) - 1
      if (n <= 0) this.waitingByUser.delete(by.id)
      else this.waitingByUser.set(by.id, n)
    }
    const buildId = randomUUID()
    try {
      const snap = this.snapshot(projectId) // synchronous barrier, taken once we hold a compile slot
      if (snap.detectedMainId !== null) this.persistDetectedMain(projectId, snap.detectedMainId)
      const startedAt = Date.now()
      let status: BuildResult['status']
      let log: string
      let durationMs: number
      let hasPdf = false
      let extra: Diagnostic[] = []
      const dir = buildDir(this.outputsDir, projectId, buildId)
      if (snap.mainFile === null) {
        status = 'failure'
        log = `${NO_MAIN_FILE_MESSAGE}\n`
        extra = [{ severity: 'error', kind: 'no-main-file', message: NO_MAIN_FILE_MESSAGE }]
        durationMs = Date.now() - startedAt
      } else {
        const { missing } = await this.compiler.sync(projectId, snap.manifest)
        for (const h of missing) {
          const data = snap.textBlobs.get(h) ?? (snap.binaryHashes.has(h) ? readFileSync(this.blobPath(h)) : null)
          if (!data) throw new Error(`compiler asked for unknown blob ${h}`)
          await this.compiler.putBlob(h, data)
        }
        const res = await this.compiler.compile(projectId, {
          manifest: snap.manifest, mainFile: snap.mainFile, engine: snap.engine, timeoutMs: 90_000,
        })
        mkdirSync(dir, { recursive: true })
        for (const name of res.outputs) {
          if (name !== 'output.pdf' && name !== 'output.synctex.gz') continue
          const data = await this.compiler.output(projectId, name)
          if (data) { writeFileSync(join(dir, name), data); if (name === 'output.pdf') hasPdf = true }
        }
        status = res.status
        log = res.log
        durationMs = res.durationMs
      }
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'output.log'), log)
      let diagnostics = mergeDiagnostics(extra, computeDiagnostics({ log, paths: snap.paths, projectId }))
      const failed = buildFailureDiagnostic(status, log, diagnostics)
      if (failed) diagnostics = mergeDiagnostics([failed], diagnostics)
      const record: BuildRecord = {
        buildId, status, durationMs, log, hasPdf, diagnostics, startedBy: by.displayName,
        snapshot: { treeVersion: snap.treeVersion, docs: snap.stateVectors, docSnapshots: snap.docSnapshots },
        paths: snap.paths, finishedAt: Date.now(),
      }
      writeBuildRecord(this.outputsDir, projectId, record)
      this.collab.broadcast(projectId, { type: 'compile-finished', buildId, status })
      if (status === 'success' && this.onSuccess) {
        try { this.onSuccess(projectId) } catch (e) { console.error('[compile] after-success hook failed', e) }
      }
      const { paths: _paths, finishedAt: _finishedAt, ...result } = record
      return result
    } finally {
      release()
    }
  }

  /** Persist a main file chosen by detection (only if still unset) and tell clients. */
  private persistDetectedMain(projectId: string, fileId: string): void {
    const changed = this.db.prepare('UPDATE projects SET main_file_id = ? WHERE id = ? AND main_file_id IS NULL')
      .run(fileId, projectId).changes > 0
    if (changed) this.collab.broadcast(projectId, { type: 'project-changed' })
  }

  /** The most recent finished build of a project (stored record), or null. */
  latest(projectId: string): BuildRecord | null {
    return latestBuildRecord(this.outputsDir, projectId)
  }

  outputPath(projectId: string, buildId: string, name: 'output.pdf' | 'output.log' | 'output.synctex.gz'): string {
    return join(this.outputsDir, projectId, buildId, name)
  }

  get outputs(): string {
    return this.outputsDir
  }

  private blobPath(hash: string): string {
    return join(this.blobsDir, hash.slice(0, 2), hash.slice(2))
  }
}
