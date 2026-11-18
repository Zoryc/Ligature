/**
 * Worker side of one compile: spawn the helper under the sandbox's identity, feed it the job and the
 * file contents it asks for, and receive the result and outputs. Everything the helper says is
 * validated, because it shares its uid with the (untrusted) TeX run.
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isHash, isOutputName, type CompileResponse, type CompileStatus, type OutputName } from './contract.ts'
import type { BlobStore } from './blobStore.ts'
import type { OutputStore, OutputBatch } from './outputStore.ts'
import type { Sandbox } from './sandbox/index.ts'
import { Channel, ProtocolError } from './protocol.ts'
import { HELPER_GRACE_MS, MAX_PDF_BYTES, MAX_REPORTED_LOG_BYTES, MAX_SYNCTEX_BYTES } from './limits.ts'
import { fitUtf8Tail, TailBuffer } from './logTail.ts'
import type { ValidCompileRequest } from './validate.ts'

const WIN = process.platform === 'win32'
const STATUSES: readonly CompileStatus[] = ['success', 'failure', 'timeout', 'error']
const OUTPUT_CAPS: Record<OutputName, number> = {
  'output.pdf': MAX_PDF_BYTES,
  'output.synctex.gz': MAX_SYNCTEX_BYTES,
  // the helper sends the capped log text plus a few notice lines
  'output.log': MAX_REPORTED_LOG_BYTES,
}
/** How long a helper may take to exit after its last message before its process group is killed. */
const HELPER_EXIT_WAIT_MS = 2000

export const HELPER_PATH = fileURLToPath(new URL('./helper.ts', import.meta.url))

/** argv to start the helper with this Node binary (adds the type-stripping flag on Node versions that need it). */
export function defaultHelperArgv(): string[] {
  const strip = process.features.typescript ? [] : ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
  return [process.execPath, ...strip, HELPER_PATH]
}

export interface RunnerDeps {
  buildsDir: string
  blobs: BlobStore
  outputs: OutputStore
  sandbox: Sandbox
  /** argv prefix for latexmk */
  latexmk: string[]
  helperArgv: string[]
  /** what one build may write on top of its sources */
  quota: { bytes: number; entries: number }
}

class HelperFailed extends Error {}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  if (WIN) { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return }
  try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
}

export async function runCompile(d: RunnerDeps, projectId: string, req: ValidCompileRequest): Promise<CompileResponse> {
  const started = Date.now()
  const dir = join(d.buildsDir, projectId)
  await d.sandbox.prepareProject(projectId, dir)

  const [cmd, ...args] = d.helperArgv
  if (!cmd) throw new Error('empty helper command')
  // cwd is BUILDS_DIR, not the project dir: libuv chdirs BEFORE dropping to the project uid, and root
  // without CAP_DAC_OVERRIDE cannot enter a 0700 directory owned by another uid. The helper chdirs itself.
  const child = spawn(cmd, args, {
    cwd: d.buildsDir,
    env: d.sandbox.helperEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !WIN,
    windowsHide: true,
    ...d.sandbox.identity(projectId),
  })
  const stderr = new TailBuffer(64 * 1024)
  child.stderr.on('data', (c: Buffer) => stderr.push(c))
  child.stdin.on('error', () => { /* EPIPE when the helper dies; surfaces as a closed channel */ })
  let spawnError: Error | null = null
  child.on('error', e => { spawnError = e; child.stdout.destroy() })
  let hasExited = false
  const exited = new Promise<void>(r => child.once('close', () => { hasExited = true; r() }))
  const waitExit = (ms: number) => Promise.race([exited, new Promise(r => setTimeout(r, ms).unref())])

  let watchdogFired = false
  const watchdog = setTimeout(() => { watchdogFired = true; killGroup(child.pid) }, req.timeoutMs + HELPER_GRACE_MS)

  const ch = new Channel(child.stdout, child.stdin)
  const expect = async (t: string) => {
    const m = await ch.recv()
    if (!m) throw new HelperFailed('helper exited unexpectedly')
    if (m.t === 'error') throw new HelperFailed(`helper error: ${typeof m.message === 'string' ? m.message.slice(0, 2000) : '?'}`)
    if (m.t !== t) throw new ProtocolError(`expected ${t}, got ${m.t}`)
    return m
  }

  let batch: OutputBatch | null = null
  try {
    await ch.send({
      t: 'job', dir, manifest: req.manifest, mainFile: req.mainFile, engine: req.engine, clean: req.clean,
      timeoutMs: req.timeoutMs, latexmk: d.latexmk, limitPrefix: d.sandbox.limitPrefix(req.timeoutMs), quota: d.quota,
    })

    // Contents the helper lacks: only hashes of this manifest, each at most once.
    const need = await expect('need')
    const wanted = new Set(Object.values(req.manifest))
    if (!Array.isArray(need.hashes) || need.hashes.length > wanted.size) throw new ProtocolError('bad need list')
    const asked = new Set<string>()
    for (const h of need.hashes as unknown[]) {
      if (typeof h !== 'string' || !isHash(h) || !wanted.has(h) || asked.has(h)) throw new ProtocolError('bad hash in need list')
      asked.add(h)
    }
    for (const h of asked) {
      const f = await d.blobs.open(h)
      if (!f) throw new HelperFailed(`blob ${h} is not in the cache`)
      try {
        await ch.send({ t: 'blob', hash: h, size: f.size })
        if (f.size > 0) await ch.sendData(f.size, f.fh.createReadStream({ start: 0, end: f.size - 1, autoClose: false }))
      } finally {
        await f.fh.close()
      }
    }
    await ch.send({ t: 'blobs-done' })

    const res = await expect('result')
    const status = res.status as CompileStatus
    if (!STATUSES.includes(status)) throw new ProtocolError('bad status')
    if (typeof res.log !== 'string' || !Array.isArray(res.outputs) || res.outputs.length > 3) throw new ProtocolError('bad result')
    const declared: { name: OutputName; size: number }[] = []
    for (const o of res.outputs as unknown[]) {
      const { name, size } = (o ?? {}) as { name?: unknown; size?: unknown }
      if (!isOutputName(name) || declared.some(x => x.name === name)) throw new ProtocolError('bad output name')
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > OUTPUT_CAPS[name]) throw new ProtocolError('bad output size')
      declared.push({ name, size })
    }

    batch = await d.outputs.begin(projectId)
    for (const o of declared) {
      const m = await expect('output')
      if (m.name !== o.name || m.size !== o.size) throw new ProtocolError('output does not match the result')
      await batch.stage(o.name, write => ch.recvData(o.size, write))
    }
    await expect('done')
    await batch.commit()
    return { status, durationMs: Date.now() - started, outputs: declared.map(o => o.name), log: fitUtf8Tail(res.log, MAX_REPORTED_LOG_BYTES) }
  } catch (e) {
    killGroup(child.pid)
    if (batch) await batch.abort()
    // Never leave outputs of an earlier build around for a build that failed this way.
    const empty = await d.outputs.begin(projectId)
    await empty.commit()
    const detail = spawnError ? `could not start the helper: ${(spawnError as Error).message}`
      : e instanceof Error ? e.message : String(e)
    const err = stderr.text().trim()
    const status: CompileStatus = watchdogFired ? 'timeout' : 'error'
    const head = watchdogFired ? `[ligature: compile helper killed after ${req.timeoutMs + HELPER_GRACE_MS} ms]` : `[ligature: ${detail}]`
    return { status, durationMs: Date.now() - started, outputs: [], log: err ? `${head}\n${err}\n` : `${head}\n` }
  } finally {
    clearTimeout(watchdog)
    child.stdin.end()
    // Whatever it reported, a helper still alive after its last message is killed (it shares its uid with
    // the TeX run, which could have taken it over), and then everything else the project left running.
    await waitExit(HELPER_EXIT_WAIT_MS)
    if (!hasExited) {
      killGroup(child.pid)
      child.kill('SIGKILL') // in case it left its process group; not yet reaped, so the pid is still ours
      await waitExit(HELPER_EXIT_WAIT_MS)
    }
    await d.sandbox.reap(projectId)
  }
}
