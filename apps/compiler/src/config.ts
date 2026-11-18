/** Worker configuration from environment variables (see README.md for the full list). */
import { resolve } from 'node:path'
import { SANDBOX_KINDS, type SandboxKind } from './sandbox/index.ts'
import { DEFAULT_MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from './limits.ts'

export type Listen = { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number }

export interface Config {
  production: boolean
  listen: Listen
  buildsDir: string
  sandbox: SandboxKind
  /** argv prefix for latexmk */
  latexmk: string[]
  prlimit: boolean
  maxTimeoutMs: number
  /** group allowed to connect to the unix socket (the app's gid), if the app does not run as root */
  socketGid: number | null
  /** what one build may write on top of its sources */
  quota: { bytes: number; entries: number }
  /** blob cache eviction: blobs unused for maxAgeMs go, then the oldest until the cache fits in maxBytes */
  blobCache: { maxBytes: number; maxAgeMs: number }
  /** build directories of projects not compiled for this long are deleted (they are only a cache) */
  buildDirMaxIdleMs: number
  /** compiles are refused (status error) while BUILDS_DIR has less free space than this; 0 disables the check */
  minFreeBytes: number
}

const MB = 1024 * 1024
const HOUR = 3600_000

/** A non-negative integer environment variable, or `def` if unset. */
function intEnv(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const s = env[name]
  if (s === undefined || s === '') return def
  const n = Number(s)
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n)) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(s)}`)
  return n
}

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)

export function parseListen(s: string): Listen {
  if (s.startsWith('unix:')) {
    const path = s.slice('unix:'.length)
    if (!path.startsWith('/')) throw new Error(`COMPILER_LISTEN unix socket path must be absolute: ${s}`)
    return { kind: 'unix', path }
  }
  const m = /^tcp:(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(s)
  if (m) {
    const port = Number(m[2])
    if (port > 65535) throw new Error(`bad port in COMPILER_LISTEN: ${s}`)
    return { kind: 'tcp', host: m[1]!.replace(/^\[|\]$/g, ''), port }
  }
  throw new Error(`COMPILER_LISTEN must be unix:/abs/path or tcp:host:port, got ${JSON.stringify(s)}`)
}

/** LIGATURE_LATEXMK: a path/command name, or a JSON array argv prefix such as ["node","/x/fake-latexmk.mjs"]. */
export function parseLatexmk(s: string | undefined): string[] {
  if (s === undefined || s === '') return ['latexmk']
  if (s.trimStart().startsWith('[')) {
    const v: unknown = JSON.parse(s)
    if (!Array.isArray(v) || v.length === 0 || !v.every(x => typeof x === 'string' && x.length > 0)) {
      throw new Error('LIGATURE_LATEXMK JSON must be a non-empty array of strings')
    }
    return v as string[]
  }
  return [s]
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production'
  const listen = parseListen(env.COMPILER_LISTEN ?? (production ? 'unix:/run/ligature/compiler.sock' : 'tcp:127.0.0.1:7071'))
  if (listen.kind === 'tcp' && production && env.ALLOW_TCP !== '1') {
    throw new Error('Refusing a TCP listener with NODE_ENV=production: use COMPILER_LISTEN=unix:/run/ligature/compiler.sock (or set ALLOW_TCP=1 if you really mean it)')
  }
  // The worker has no authentication, and in development it runs TeX with the developer's own rights.
  if (listen.kind === 'tcp' && !isLoopback(listen.host) && env.ALLOW_TCP !== '1') {
    throw new Error(`Refusing a TCP listener on non-loopback ${listen.host}: anyone who can reach it could run TeX on this machine. ` +
      'Use 127.0.0.1 (or set ALLOW_TCP=1 if you really mean it)')
  }
  const sandbox = (env.SANDBOX ?? (production ? 'uid' : 'none')) as SandboxKind
  if (!SANDBOX_KINDS.includes(sandbox)) throw new Error(`SANDBOX must be one of ${SANDBOX_KINDS.join(', ')}`)
  const maxTimeoutMs = env.COMPILE_MAX_TIMEOUT_MS ? Number(env.COMPILE_MAX_TIMEOUT_MS) : DEFAULT_MAX_TIMEOUT_MS
  if (!Number.isInteger(maxTimeoutMs) || maxTimeoutMs < MIN_TIMEOUT_MS) throw new Error('COMPILE_MAX_TIMEOUT_MS must be an integer >= 1000')
  let socketGid: number | null = null
  if (env.COMPILER_SOCKET_GID !== undefined && env.COMPILER_SOCKET_GID !== '') {
    socketGid = Number(env.COMPILER_SOCKET_GID)
    if (!Number.isInteger(socketGid) || socketGid < 0 || socketGid >= 100_000) {
      // project uids/gids start at 100000; never let one of them own the socket
      throw new Error('COMPILER_SOCKET_GID must be an integer in [0, 100000)')
    }
  }
  return {
    production,
    listen,
    buildsDir: resolve(env.BUILDS_DIR ?? (production ? '/builds' : './builds')),
    sandbox,
    latexmk: parseLatexmk(env.LIGATURE_LATEXMK),
    prlimit: env.LIGATURE_PRLIMIT !== '0',
    maxTimeoutMs,
    socketGid,
    quota: { bytes: positive('PROJECT_DISK_QUOTA_MB', 1024) * MB, entries: positive('PROJECT_MAX_FILES', 100_000) },
    blobCache: { maxBytes: intEnv(env, 'BLOB_CACHE_MAX_MB', 2048) * MB, maxAgeMs: intEnv(env, 'BLOB_CACHE_MAX_AGE_HOURS', 72) * HOUR },
    buildDirMaxIdleMs: intEnv(env, 'BUILD_DIR_MAX_IDLE_DAYS', 7) * 24 * HOUR,
    minFreeBytes: intEnv(env, 'BUILDS_MIN_FREE_MB', 1024) * MB,
  }

  function positive(name: string, def: number): number {
    const n = intEnv(env, name, def)
    if (n === 0) throw new Error(`${name} must be at least 1`)
    return n
  }
}
