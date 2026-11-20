/**
 * Sandbox helper: a short-lived process, one per compile, working in the project directory.
 *
 * With the 'uid' sandbox the worker spawns it with the project's uid/gid, so ALL file I/O inside the
 * project directory (writing sources, running latexmk, reading outputs) happens with the project's
 * identity and never as root. With the 'none' sandbox (dev) it runs as the current user.
 *
 * It speaks protocol.ts over stdin/stdout: receives the job and file contents, materialises src/,
 * runs latexmk, and streams the results back. stderr is for diagnostics only.
 */
import { createHash } from 'node:crypto'
import { rm, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CompileStatus, OutputName } from './contract.ts'
import { QuotaWatch, type Quota } from './diskUsage.ts'
import { openForWrite, openRegular } from './fsSafe.ts'
import { seedFontNames, systemTexmfVar } from './fontNames.ts'
import { HashCache } from './hashCache.ts'
import { latexmkArgs, runCommand, texEnv } from './latexmk.ts'
import { MAX_CONSOLE_TAIL_BYTES, MAX_LOG_BYTES, MAX_PDF_BYTES, MAX_REPORTED_LOG_BYTES, MAX_SYNCTEX_BYTES } from './limits.ts'
import { fitUtf8Tail, readTail, reportedLog } from './logTail.ts'
import { applyRemovals, ensureLayout, ensureParents, layout, mirrorDirs, planSync, type Layout } from './materialize.ts'
import { Channel, ProtocolError, type JobMsg, type OutputInfo } from './protocol.ts'

const isQuota = (q: unknown): q is Quota => {
  const { bytes, entries } = (q ?? {}) as { bytes?: unknown; entries?: unknown }
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 &&
    typeof entries === 'number' && Number.isSafeInteger(entries) && entries > 0
}

const ch = new Channel(process.stdin, process.stdout)

async function receiveBlob(src: string, hash: string, size: number, paths: string[], cache: HashCache): Promise<void> {
  const [first, ...rest] = paths
  if (!first) throw new ProtocolError('blob with no target path')
  const firstAbs = join(src, ...first.split('/'))
  await ensureParents(src, first)
  const fh = await openForWrite(firstAbs)
  const h = createHash('sha256')
  try {
    await ch.recvData(size, async chunk => {
      h.update(chunk)
      await fh.write(chunk)
    })
  } finally {
    await fh.close()
  }
  if (h.digest('hex') !== hash) throw new ProtocolError(`content of ${first} does not match its hash`)
  await cache.record(src, first, hash)
  for (const p of rest) {
    await ensureParents(src, p)
    await copyNoFollow(firstAbs, join(src, ...p.split('/')))
    await cache.record(src, p, hash)
  }
}

/** Poll interval of the disk quota during a build: 2 s, or longer so that walking the tree takes at most ~10% of the time. */
const QUOTA_POLL_MS = 2000

/** Delete everything a build may have produced (out/, HOME, TMPDIR, TeX caches) and recreate the layout. */
async function wipeBuildFiles(l: Layout): Promise<void> {
  for (const d of [l.out, l.home, l.tmp, l.texmfVar, l.texmfConfig]) await rm(d, { recursive: true, force: true, maxRetries: 3 })
  await ensureLayout(l, false)
}

async function copyNoFollow(from: string, to: string): Promise<void> {
  const f = await openRegular(from)
  if (!f) throw new Error(`vanished: ${from}`)
  const w = await openForWrite(to)
  try {
    for await (const chunk of f.fh.createReadStream({ autoClose: false })) await w.write(chunk as Buffer)
  } finally {
    await w.close()
    await f.fh.close()
  }
}

/** Best effort (see fontNames.ts): without the copy LuaLaTeX still works, its first compile is only slower. */
async function seedLuaFontNames(l: Layout, env: Record<string, string>): Promise<void> {
  try {
    await seedFontNames(l.texmfVar, () => systemTexmfVar(env))
  } catch (e) {
    process.stderr.write(`[helper] luaotfload names database not seeded: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

interface FileStamp { mtimeMs: number; size: number }

async function stamp(path: string): Promise<FileStamp | null> {
  const f = await openRegular(path)
  if (!f) return null
  await f.fh.close()
  return { mtimeMs: f.mtimeMs, size: f.size }
}

interface OpenOutput { info: OutputInfo; fh: FileHandle | null; data: Buffer | null }

async function main(): Promise<void> {
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error('the helper refuses to run as root')
  const msg = await ch.recv()
  if (!msg || msg.t !== 'job') throw new ProtocolError('expected a job message')
  const job = msg as unknown as JobMsg
  if (typeof job.dir !== 'string' || !isAbsolute(job.dir)) throw new ProtocolError('job without an absolute dir')
  process.chdir(job.dir)
  const l: Layout = layout(process.cwd())

  if (!isQuota(job.quota)) throw new ProtocolError('job without a valid quota')
  const quota = job.quota

  // 1. Sources: delete what is not in the manifest, ask for what is missing or changed.
  await ensureLayout(l, job.clean)
  const cache = await HashCache.load(l.root, job.clean)
  const plan = await planSync(l.src, job.manifest, (src, rel) => cache.hashOf(src, rel))
  await applyRemovals(l.src, plan.remove)
  await ch.send({ t: 'need', hashes: [...plan.needed.keys()] })
  const pending = new Map(plan.needed)
  for (;;) {
    const m = await ch.recv()
    if (!m) throw new ProtocolError('worker closed the channel')
    if (m.t === 'blobs-done') break
    if (m.t !== 'blob' || typeof m.hash !== 'string' || typeof m.size !== 'number') throw new ProtocolError('expected a blob message')
    const paths = pending.get(m.hash)
    if (!paths) throw new ProtocolError(`unexpected blob ${m.hash}`)
    pending.delete(m.hash)
    await receiveBlob(l.src, m.hash, m.size, paths, cache)
  }
  if (pending.size > 0) throw new ProtocolError(`worker did not send ${pending.size} blob(s)`)
  try { await cache.save(l.root, job.manifest) } catch { /* only an optimisation */ }
  await mirrorDirs(l.out, job.manifest)

  // Disk quota: whatever an earlier build (or a process it left behind) wrote beyond it is wiped first.
  const watch = await QuotaWatch.start(l.root, l.src, job.manifest, quota)
  if (await watch.check()) {
    await wipeBuildFiles(l)
    await mirrorDirs(l.out, job.manifest)
  }
  const env = texEnv(process.env, l)
  if (job.engine === 'lualatex') await seedLuaFontNames(l, env)

  // 2. Build, checking the disk quota while it runs.
  const pdfPath = join(l.out, 'output.pdf')
  const synctexPath = join(l.out, 'output.synctex.gz')
  const logPath = join(l.out, 'output.log')
  const before = { pdf: await stamp(pdfPath), synctex: await stamp(synctexPath) }
  const stop = new AbortController() // kills the run
  const ended = new AbortController() // ends the polling
  let overQuota: string | null = null
  const poll = (async () => {
    let interval = QUOTA_POLL_MS
    for (;;) {
      await sleep(interval, undefined, { signal: ended.signal })
      const t0 = Date.now()
      overQuota = await watch.check().catch(() => null)
      if (overQuota) { stop.abort(); return }
      interval = Math.max(QUOTA_POLL_MS, 10 * (Date.now() - t0)) // a slow walk (huge tree) is not repeated back to back
    }
  })().catch(() => { /* aborted by `ended` */ })
  const run = await runCommand({
    argv: [...job.limitPrefix, ...job.latexmk, ...latexmkArgs(job.engine, job.mainFile, l.out)],
    cwd: l.src,
    env,
    timeoutMs: job.timeoutMs,
    signal: stop.signal,
  })
  ended.abort()
  await poll
  // The last check also catches what was written between two polls.
  overQuota ??= await watch.check()

  // 3. Collect results. After a failed run, a pdf/synctex left over from an earlier build is not reported.
  const notes: string[] = []
  const fileLog = await readTail(logPath, MAX_LOG_BYTES)
  const outputs: OpenOutput[] = []
  if (overQuota) {
    await wipeBuildFiles(l)
    notes.push(`[ligature: ${overQuota}; the build was stopped and its files were deleted]`)
  }
  const succeeded = !overQuota && !run.timedOut && run.spawnError === null && run.exitCode === 0
  const take = async (name: OutputName, path: string, cap: number, old: FileStamp | null): Promise<boolean> => {
    if (overQuota) return false
    const f = await openRegular(path)
    if (!f) return false
    const fresh = !old || old.mtimeMs !== f.mtimeMs || old.size !== f.size
    if (!succeeded && !fresh) { await f.fh.close(); return false }
    if (f.size > cap) {
      notes.push(`[ligature: ${name} is ${f.size} bytes, over the ${cap} byte limit; discarded]`)
      await f.fh.close()
      return false
    }
    outputs.push({ info: { name, size: f.size }, fh: f.fh, data: null })
    return true
  }
  const hasPdf = await take('output.pdf', pdfPath, MAX_PDF_BYTES, before.pdf)
  await take('output.synctex.gz', synctexPath, MAX_SYNCTEX_BYTES, before.synctex)

  let status: CompileStatus
  if (overQuota) status = 'failure'
  else if (run.timedOut) { status = 'timeout'; notes.push(`[ligature: compile timed out after ${job.timeoutMs} ms; process group killed]`) }
  else if (run.spawnError !== null) { status = 'error'; notes.push(`[ligature: could not run latexmk: ${run.spawnError}]`) }
  else status = succeeded && hasPdf ? 'success' : 'failure'

  let log = reportedLog(fileLog, run.console, status !== 'success', MAX_CONSOLE_TAIL_BYTES)
  if (notes.length) log = `${log}${log.endsWith('\n') || log === '' ? '' : '\n'}${notes.join('\n')}\n`
  // Decoding can grow the text (invalid UTF-8 bytes become 3-byte U+FFFD): cap the bytes actually sent.
  log = fitUtf8Tail(log, MAX_REPORTED_LOG_BYTES)
  if (fileLog !== null) {
    const data = Buffer.from(log, 'utf8')
    outputs.push({ info: { name: 'output.log', size: data.length }, fh: null, data })
  }

  // 4. Stream back.
  try {
    await ch.send({ t: 'result', status, durationMs: run.durationMs, log, outputs: outputs.map(o => o.info) })
    for (const o of outputs) {
      await ch.send({ t: 'output', ...o.info })
      if (o.data) await ch.sendData(o.info.size, [o.data])
      else if (o.fh && o.info.size > 0) await ch.sendData(o.info.size, o.fh.createReadStream({ start: 0, end: o.info.size - 1, autoClose: false }))
    }
    await ch.send({ t: 'done' })
  } finally {
    for (const o of outputs) await o.fh?.close()
  }
}

main().then(
  () => { process.stdout.end(() => process.exit(0)) },
  async (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e)
    process.stderr.write(`[helper] ${e instanceof Error ? e.stack : message}\n`)
    try { await ch.send({ t: 'error', message }) } catch { /* channel gone */ }
    process.stdout.end(() => process.exit(1))
  },
)
