import { randomBytes, timingSafeEqual } from 'node:crypto'
import { statfs as fsStatfs } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Context } from 'hono'
import WebSocket from 'ws'
import type { HealthCheck, HealthReport, HealthStatus } from '@ligature/shared'
import type { DB } from '../db/index.ts'

/**
 * GET /healthz (docs/M4.md §1): checks the paths a user's work depends on (database, disk, document
 * store, collaboration socket, compiler) instead of only "the process runs".
 *
 * The endpoint is public, so the answer holds short reason codes only (never paths, hostnames or
 * exception text), and one run per scope is shared by concurrent callers and cached for a few seconds:
 * polling it cannot make the server open many sockets or call the compiler often.
 */

export type HealthScope = 'full' | 'app'

/** What a probe finds; `ms` is measured around it. */
export interface ProbeResult { status: HealthStatus; reason?: string; freeBytes?: number }

/** A probe stops its work (sockets, requests) when `signal` aborts (its timeout passed). */
export type Probe = (signal: AbortSignal) => Promise<ProbeResult> | ProbeResult

export interface Probes {
  db: Probe
  disk: Probe
  store: Probe
  collab: Probe
  compiler: Probe
}

export interface HealthOptions {
  /** Per-check timeout (default 2 s); a check that takes longer fails with reason `timeout`. */
  timeoutMs?: number
  /** How long a report is reused for the same scope (default 5 s). */
  cacheMs?: number
  clock?: () => number
}

export interface Health {
  /** The report for `scope`: cached, or from a run shared with concurrent callers. */
  report(scope: HealthScope): Promise<HealthReport>
}

export const HEALTH_TIMEOUT_MS = 2000
export const HEALTH_CACHE_MS = 5000

export const MB = 1024 * 1024
/** Below this much free space the disk check fails: edits, uploads and builds are about to fail. */
export const DISK_FAIL_BYTES = 100 * MB
/** Below this much it warns (the server stays healthy). */
export const DISK_WARN_BYTES = 1024 * MB

/** Run `probe` with a timeout. Exceptions become `fail` with reason `error` (their text is logged, not returned). */
export async function runProbe(name: string, probe: Probe, timeoutMs: number): Promise<HealthCheck & { freeBytes?: number }> {
  const start = performance.now()
  const ac = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<ProbeResult>(resolve => {
    timer = setTimeout(() => { ac.abort(); resolve({ status: 'fail', reason: 'timeout' }) }, timeoutMs)
  })
  let r: ProbeResult
  try {
    r = await Promise.race([Promise.resolve().then(() => probe(ac.signal)), timeout])
  } catch (e) {
    console.error(`[health] ${name} check failed`, e)
    r = { status: 'fail', reason: 'error' }
  } finally {
    clearTimeout(timer)
  }
  const ms = Math.round(performance.now() - start)
  return { status: r.status, ms, ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(r.freeBytes !== undefined ? { freeBytes: r.freeBytes } : {}) }
}

function overall(checks: HealthCheck[]): HealthReport['status'] {
  if (checks.some(c => c.status === 'fail')) return 'down'
  return checks.some(c => c.status === 'warn') ? 'degraded' : 'ok'
}

export function createHealth(probes: Probes, opts: HealthOptions = {}): Health {
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS
  const cacheMs = opts.cacheMs ?? HEALTH_CACHE_MS
  const clock = opts.clock ?? Date.now
  const cached = new Map<HealthScope, { until: number; report: HealthReport }>()
  const running = new Map<HealthScope, Promise<HealthReport>>()
  // Last status per check, so a failure is logged once when it starts, not on every poll.
  const lastStatus = new Map<string, HealthStatus>()

  const note = (name: string, c: HealthCheck) => {
    const before = lastStatus.get(name)
    lastStatus.set(name, c.status)
    if (before === c.status || (before === undefined && c.status === 'ok')) return
    const msg = `[health] ${name}: ${c.status}${c.reason ? ` (${c.reason})` : ''}`
    if (c.status === 'ok') console.log(msg)
    else console.warn(msg)
  }

  async function run(scope: HealthScope): Promise<HealthReport> {
    const at = clock()
    const probe = (name: keyof Probes) => runProbe(name, probes[name], timeoutMs).then(c => { note(name, c); return c })
    const [db, disk, store, collab, compiler] = await Promise.all([
      probe('db'), probe('disk'), probe('store'), probe('collab'),
      scope === 'full' ? probe('compiler') : Promise.resolve(undefined),
    ])
    const checks: HealthReport['checks'] = { db, disk, store, collab, ...(compiler ? { compiler } : {}) }
    const status = overall(Object.values(checks))
    return { ok: status !== 'down', status, at, checks }
  }

  return {
    report(scope) {
      const hit = cached.get(scope)
      if (hit && clock() < hit.until) return Promise.resolve(hit.report)
      const inFlight = running.get(scope)
      if (inFlight) return inFlight
      const p = run(scope).then(report => {
        cached.set(scope, { until: clock() + cacheMs, report })
        return report
      }).finally(() => running.delete(scope))
      running.set(scope, p)
      return p
    },
  }
}

/* ------------------------------------------------------------------------------------------ probes */

/** `SELECT 1` on the server's own connection. */
export function dbProbe(db: DB): Probe {
  return () => {
    if (!db.open) return { status: 'fail', reason: 'closed' }
    db.prepare('SELECT 1').get()
    return { status: 'ok' }
  }
}

type Statfs = (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>

/** Free space of the data directory. Where the platform has no statfs: ok, without a number. */
export function diskProbe(dataDir: string, statfs: Statfs | null = (fsStatfs as Statfs | undefined) ?? null): Probe {
  return async () => {
    if (typeof statfs !== 'function') return { status: 'ok' }
    let s: Awaited<ReturnType<Statfs>>
    try {
      s = await statfs(dataDir)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOSYS' || code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') return { status: 'ok' }
      throw e
    }
    const freeBytes = Number(s.bavail) * Number(s.bsize)
    if (freeBytes < DISK_FAIL_BYTES) return { status: 'fail', reason: 'low-disk', freeBytes }
    if (freeBytes < DISK_WARN_BYTES) return { status: 'warn', reason: 'low-disk', freeBytes }
    return { status: 'ok', freeBytes }
  }
}

/** The document store: its last flush of edits failed and none has succeeded since. */
export function storeProbe(store: { readonly flushFailing: boolean }): Probe {
  return () => store.flushFailing ? { status: 'fail', reason: 'write-failed' } : { status: 'ok' }
}

/** The compiler worker's own /healthz. */
export function compilerProbe(compiler: { health(timeoutMs?: number): Promise<boolean> }, timeoutMs = HEALTH_TIMEOUT_MS): Probe {
  return async () => (await compiler.health(timeoutMs)) ? { status: 'ok' } : { status: 'fail', reason: 'unreachable' }
}

/**
 * Where to reach our own listener from inside the process: a wildcard bind is reached over loopback
 * of the same family; a specific address is reached as itself. Returns a ws:// URL for `path`.
 */
export function loopbackUrl(addr: AddressInfo, path: string): string {
  let host = addr.address
  if (host === '0.0.0.0' || host === '') host = '127.0.0.1'
  else if (host === '::') host = '::1'
  if (host.includes(':')) host = `[${host}]`
  return `ws://${host}:${addr.port}${path}`
}

/**
 * Header that marks the /collab check's own socket. Its value is a random token made per process and
 * kept in memory only: the upgrade handler does not count that socket against the anonymous-socket
 * cap, so anyone holding the cap full (a remote client can, by reopening idle sockets) cannot make
 * /healthz report the instance down while signed-in editing works. Origin, frame and byte limits still apply.
 */
export const HEALTH_PROBE_HEADER = 'x-ligature-health'

export function createProbeToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Whether a request header carries this process's probe token (constant-time compare). */
export function isProbeToken(expected: string, got: string | string[] | undefined): boolean {
  if (typeof got !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(got)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface CollabTarget { url: string; origin: string; token?: string }

/**
 * A real WebSocket upgrade on /collab (no cookie), closed as soon as it opens. With `token` it is sent
 * in HEALTH_PROBE_HEADER, which keeps the socket out of the anonymous-socket count. Reasons:
 * `http-<status>` (e.g. 403 when `origin` is not allowed), `refused`, `error`.
 */
export function collabProbe(target: () => CollabTarget | null): Probe {
  return signal => new Promise<ProbeResult>(resolve => {
    const t = target()
    if (!t) { resolve({ status: 'fail', reason: 'not-listening' }); return }
    const ws = new WebSocket(t.url, {
      origin: t.origin, perMessageDeflate: false,
      ...(t.token !== undefined ? { headers: { [HEALTH_PROBE_HEADER]: t.token } } : {}),
    })
    let done = false
    const finish = (r: ProbeResult) => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const onAbort = () => { ws.terminate(); finish({ status: 'fail', reason: 'timeout' }) }
    signal.addEventListener('abort', onAbort)
    ws.on('open', () => { ws.close(); finish({ status: 'ok' }) })
    ws.on('unexpected-response', (req, res) => {
      finish({ status: 'fail', reason: `http-${res.statusCode ?? 0}` })
      res.resume()
      req.destroy()
    })
    ws.on('error', e => {
      const code = (e as NodeJS.ErrnoException).code
      finish({ status: 'fail', reason: code === 'ECONNREFUSED' ? 'refused' : 'error' })
    })
  })
}

/* ------------------------------------------------------------------------------------------- route */

/** GET (and, through Hono, HEAD) /healthz. `?scope=app` skips the compiler. */
export function healthHandler(health: Health) {
  return async (c: Context) => {
    const scope: HealthScope = c.req.query('scope') === 'app' ? 'app' : 'full'
    const report = await health.report(scope)
    c.header('Cache-Control', 'no-store')
    return c.json(report, report.ok ? 200 : 503)
  }
}
