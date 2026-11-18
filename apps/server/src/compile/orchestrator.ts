import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Y from 'yjs'
import { ENGINES, fileDocName, isValidRelPath, type CompileStatus, type Engine, type Manifest } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import type { Collab } from '../collab/collab.ts'
import { TEXT_KEY, type DocStore } from '../collab/docStore.ts'
import { filePaths, liveFiles, projectEngine } from '../projects/repo.ts'
import type { CompilerClient } from './compilerClient.ts'

export interface BuildResult {
  buildId: string
  status: CompileStatus
  durationMs: number
  log: string
  hasPdf: boolean
  /** tree version + per-doc state vectors the build was made from (lets the client say "PDF is behind") */
  snapshot: {
    treeVersion: number
    docs: Record<string, string /* base64 state vector */>
    /** base64 Y.encodeSnapshot (state vector + delete set): lets the client also detect deletion-only edits */
    docSnapshots: Record<string, string>
  }
}

interface Snapshot {
  treeVersion: number
  manifest: Manifest
  /** hash -> bytes, for text files (binaries are read from the blob store on demand) */
  textBlobs: Map<string, Buffer>
  binaryHashes: Set<string>
  mainFile: string
  engine: Engine
  stateVectors: Record<string, string>
  docSnapshots: Record<string, string>
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

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
  /** Per-project single flight: the running build, and at most one queued follow-up shared by all waiters. */
  private readonly inflight = new Map<string, { running: Promise<BuildResult>; next: Promise<BuildResult> | null }>()

  constructor(
    private readonly db: DB,
    private readonly store: DocStore,
    private readonly collab: Collab,
    private readonly compiler: CompilerClient,
    private readonly outputsDir: string,
    private readonly blobsDir: string,
    concurrency: number,
  ) {
    this.global = new Semaphore(Math.max(1, concurrency))
  }

  /** Request a compile. Requests made while a build runs collapse into one follow-up build. */
  compile(projectId: string): Promise<BuildResult> {
    const st = this.inflight.get(projectId)
    if (!st) {
      const running = this.run(projectId).finally(() => this.advance(projectId))
      this.inflight.set(projectId, { running, next: null })
      return running
    }
    if (!st.next) {
      st.next = st.running.catch(() => undefined).then(() => this.run(projectId))
    }
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
    const treeVersion = (this.db.prepare('SELECT tree_version AS v FROM projects WHERE id = ?').get(projectId) as { v: number }).v
    const files = liveFiles(this.db, projectId)
    const paths = filePaths(files)
    const manifest: Manifest = {}
    const textBlobs = new Map<string, Buffer>()
    const binaryHashes = new Set<string>()
    const stateVectors: Record<string, string> = {}
    const docSnapshots: Record<string, string> = {}
    for (const f of files) {
      const path = paths.get(f.id)
      if (!path) continue
      if (!isValidRelPath(path)) throw new Error(`invalid path in tree: ${JSON.stringify(path)}`)
      if (f.kind === 'text') {
        const name = fileDocName(projectId, f.id, f.epoch)
        const live = this.collab.liveDoc(name)
        let text: string
        if (live) {
          text = live.getText(TEXT_KEY).toString()
          stateVectors[f.id] = Buffer.from(Y.encodeStateVector(live)).toString('base64')
          docSnapshots[f.id] = Buffer.from(Y.encodeSnapshot(Y.snapshot(live))).toString('base64')
        } else {
          text = this.store.storedText(name)?.text ?? ''
        }
        const buf = Buffer.from(text, 'utf8')
        const h = sha256(buf)
        manifest[path] = h
        textBlobs.set(h, buf)
      } else if (f.kind === 'binary' && f.blobHash) {
        manifest[path] = f.blobHash
        binaryHashes.add(f.blobHash)
      }
    }
    const mainFile = (proj.mainFileId && paths.get(proj.mainFileId)) || 'main.tex'
    const engine = (ENGINES as readonly string[]).includes(proj.engine) ? proj.engine as Engine : 'pdflatex'
    return { treeVersion, manifest, textBlobs, binaryHashes, mainFile, engine, stateVectors, docSnapshots }
  }

  private async run(projectId: string): Promise<BuildResult> {
    const release = await this.global.acquire()
    const buildId = randomUUID()
    try {
      const snap = this.snapshot(projectId) // synchronous barrier, taken once we hold a compile slot
      const { missing } = await this.compiler.sync(projectId, snap.manifest)
      for (const h of missing) {
        const data = snap.textBlobs.get(h) ?? (snap.binaryHashes.has(h) ? readFileSync(this.blobPath(h)) : null)
        if (!data) throw new Error(`compiler asked for unknown blob ${h}`)
        await this.compiler.putBlob(h, data)
      }
      const res = await this.compiler.compile(projectId, {
        manifest: snap.manifest, mainFile: snap.mainFile, engine: snap.engine, timeoutMs: 90_000,
      })
      const dir = join(this.outputsDir, projectId, buildId)
      mkdirSync(dir, { recursive: true })
      let hasPdf = false
      for (const name of res.outputs) {
        if (name !== 'output.pdf' && name !== 'output.synctex.gz') continue
        const data = await this.compiler.output(projectId, name)
        if (data) { writeFileSync(join(dir, name), data); if (name === 'output.pdf') hasPdf = true }
      }
      writeFileSync(join(dir, 'output.log'), res.log)
      const result: BuildResult = {
        buildId, status: res.status, durationMs: res.durationMs, log: res.log, hasPdf,
        snapshot: { treeVersion: snap.treeVersion, docs: snap.stateVectors, docSnapshots: snap.docSnapshots },
      }
      writeFileSync(join(dir, 'build.json'), JSON.stringify({ ...result, log: undefined }))
      this.collab.broadcast(projectId, { type: 'compile-finished', buildId, status: res.status })
      return result
    } finally {
      release()
    }
  }

  outputPath(projectId: string, buildId: string, name: 'output.pdf' | 'output.log' | 'output.synctex.gz'): string {
    return join(this.outputsDir, projectId, buildId, name)
  }

  private blobPath(hash: string): string {
    return join(this.blobsDir, hash.slice(0, 2), hash.slice(2))
  }
}
