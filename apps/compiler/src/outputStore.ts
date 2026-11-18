/**
 * Worker-owned copy of each project's latest outputs: BUILDS_DIR/.outputs/<projectId>/<name>.
 * The helper streams outputs here, so GET /output never opens anything inside a project directory
 * (a planted `out/output.pdf -> /etc/shadow` symlink has nothing to point at).
 * A build's outputs replace the previous set atomically per file (temp file + rename).
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, rename, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import type { OutputName } from './contract.ts'
import { openForWrite, openRegular } from './fsSafe.ts'

export class OutputStore {
  readonly dir: string

  constructor(dir: string) { this.dir = dir }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
  }

  /** Caller must have validated projectId (UUID) and name (OUTPUT_NAMES). */
  open(projectId: string, name: OutputName) {
    return openRegular(join(this.dir, projectId, name))
  }

  /** Mark the project as just compiled (the mtime of its directory here is what idle eviction goes by). */
  async touch(projectId: string): Promise<void> {
    const dir = join(this.dir, projectId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const now = new Date()
    await utimes(dir, now, now)
  }

  async begin(projectId: string): Promise<OutputBatch> {
    const dir = join(this.dir, projectId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return new OutputBatch(dir)
  }
}

export class OutputBatch {
  private readonly dir: string
  private readonly staged = new Map<OutputName, string>()

  constructor(dir: string) { this.dir = dir }

  /** Stage one output; `fill` receives a writer for its bytes. */
  async stage(name: OutputName, fill: (write: (chunk: Buffer) => Promise<void>) => Promise<void>): Promise<void> {
    const tmp = join(this.dir, `.tmp-${randomBytes(8).toString('hex')}`)
    this.staged.set(name, tmp)
    const fh = await openForWrite(tmp)
    try {
      await fill(async chunk => { await fh.write(chunk) })
    } finally {
      await fh.close()
    }
  }

  /** Publish the staged outputs and delete any output of an earlier build that this one did not produce. */
  async commit(): Promise<void> {
    for (const [name, tmp] of this.staged) await rename(tmp, join(this.dir, name))
    for (const entry of await readdir(this.dir)) {
      if (!this.staged.has(entry as OutputName)) await rm(join(this.dir, entry), { force: true, recursive: true })
    }
    this.staged.clear()
  }

  async abort(): Promise<void> {
    for (const tmp of this.staged.values()) await rm(tmp, { force: true })
    this.staged.clear()
  }
}
