import { resolve } from 'node:path'
import { originChecker } from './http/origins.ts'
import { startLigature } from './server.ts'

const env = process.env
const PROD = env.NODE_ENV === 'production'
const PORT = Number(env.PORT ?? 3000)
const HOST = env.HOST ?? (PROD ? '0.0.0.0' : '127.0.0.1')
const DATA_DIR = resolve(env.DATA_DIR ?? 'data')
const COMPILER_URL = env.COMPILER_URL ?? (PROD ? 'unix:/run/ligature/compiler.sock' : 'http://127.0.0.1:7071')
const ALLOWED_ORIGINS = new Set((env.ALLOWED_ORIGINS ?? (PROD ? '' : 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000'))
  .split(',').map(s => s.trim()).filter(Boolean))
// Dev login and the seeded users (known password) only in an explicit development environment:
// NODE_ENV unset, `development` or `test`. Any other value (e.g. `staging`) fails closed.
const DEV_ENV = !PROD && [undefined, '', 'development', 'test'].includes(env.NODE_ENV)
const DEV_LOGIN = DEV_ENV && env.DEV_LOGIN !== '0'
const WEB_DIST_DIR = resolve(env.WEB_DIST_DIR ?? resolve(import.meta.dirname, '../../web/dist'))
// Trash retention in days (docs/M2.md §1), default 30.
const TRASH_RETENTION_DAYS = env.TRASH_RETENTION_DAYS === undefined || env.TRASH_RETENTION_DAYS === '' ? 30 : Number(env.TRASH_RETENTION_DAYS)
if (!Number.isFinite(TRASH_RETENTION_DAYS) || TRASH_RETENTION_DAYS <= 0) throw new Error('TRASH_RETENTION_DAYS must be a positive number')
// Soft-deleted projects are purged by the GC this many days after deletion (docs/M3.md §3), default 30.
const PROJECT_RETENTION_DAYS = env.PROJECT_RETENTION_DAYS === undefined || env.PROJECT_RETENTION_DAYS === '' ? 30 : Number(env.PROJECT_RETENTION_DAYS)
if (!Number.isFinite(PROJECT_RETENTION_DAYS) || PROJECT_RETENTION_DAYS <= 0) throw new Error('PROJECT_RETENTION_DAYS must be a positive number')

if (PROD && ALLOWED_ORIGINS.size === 0) throw new Error('ALLOWED_ORIGINS must be set in production')
if (PROD && COMPILER_URL.startsWith('http:') && env.ALLOW_TCP_COMPILER !== '1') {
  throw new Error('In production the compiler must be reached over a unix socket (COMPILER_URL=unix:...)')
}

const app = startLigature({
  dataDir: DATA_DIR, port: PORT, host: HOST, compilerUrl: COMPILER_URL,
  isAllowedOrigin: originChecker(ALLOWED_ORIGINS, !PROD),
  production: PROD, devLogin: DEV_LOGIN, seed: DEV_ENV, trustProxy: env.TRUST_PROXY === '1',
  webDistDir: WEB_DIST_DIR,
  limits: { trashRetentionMs: TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000 },
  gc: { projectRetentionMs: PROJECT_RETENTION_DAYS * 24 * 60 * 60 * 1000 },
})

app.listening.then(() => {
  console.log(`[ligature] listening on http://${HOST}:${PORT}  data=${DATA_DIR}  compiler=${COMPILER_URL}`)
  if (DEV_LOGIN) console.warn('[ligature] DEV LOGIN ENABLED (development only): anyone can log in as any seeded user')
  app.compiler.health().then(ok => console.log(`[ligature] compiler ${ok ? 'reachable' : 'NOT reachable (compiles will fail)'}`))
}, err => {
  console.error('[ligature] failed to listen', err)
  process.exit(1)
})

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[ligature] ${signal}: flushing documents…`)
  try {
    await app.stop()
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))
// A parent process that spawned us with an IPC channel can ask for the same graceful stop (Windows has no SIGTERM).
process.on('message', m => { if (m === 'shutdown') void stop('shutdown message') })
