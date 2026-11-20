import { availableParallelism } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { createAdaptorServer } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { openDb, type DB } from './db/index.ts'
import { DocStore } from './collab/docStore.ts'
import { createCollab, type Collab } from './collab/collab.ts'
import { CompilerClient } from './compile/compilerClient.ts'
import { CompileOrchestrator, DEFAULT_MAX_COMPILE_QUEUE } from './compile/orchestrator.ts'
import type { SynctexCacheOptions } from './compile/synctex.ts'
import { sweepTrash as sweepTrashBatches } from './files/trash.ts'
import { createApp } from './http/app.ts'
import { createLimiters, DEFAULT_RATE_LIMITS, type Limiters, type RateLimitConfig } from './http/rateLimit.ts'
import { BlobStore } from './files/blobStore.ts'
import { DEFAULT_LIMITS, type Limits, type Services } from './services.ts'
import { seedDev } from './dev/seed.ts'
import { createHistory, type HistoryConfig } from './history/history.ts'
import { readCookie, SESSION_COOKIE, sessionForToken } from './auth/sessions.ts'
import { createSetupToken } from './auth/setup.ts'
import { hasUsers } from './auth/settings.ts'
import { createRebuilder, DEFAULT_REBUILD, type RebuildConfig, type Rebuilder } from './collab/rebuild.ts'
import type { GcConfig } from './maintenance/gc.ts'
import { createMaintenance, type Maintenance } from './maintenance/maintenance.ts'
import { startHeartbeat } from './maintenance/heartbeat.ts'
import {
  collabProbe, compilerProbe, createHealth, createProbeToken, dbProbe, diskProbe, HEALTH_PROBE_HEADER, isProbeToken, loopbackUrl,
  storeProbe, type Health, type HealthOptions,
} from './health/health.ts'

export interface LigatureConfig {
  dataDir: string
  port: number
  host: string
  compilerUrl: string
  isAllowedOrigin: (origin: string | null | undefined) => boolean
  production: boolean
  devLogin: boolean
  /** Seed alice/bob/carol + a demo project (development only). */
  seed: boolean
  trustProxy: boolean
  webDistDir: string | null
  limits?: Partial<Limits>
  rateLimits?: Partial<RateLimitConfig>
  wsLimits?: Partial<WsLimits>
  /** Re-check open sockets against their sessions this often (default 60 s). */
  sessionCheckMs?: number
  /** Builds waiting for a compile slot before `503 compiler-busy` (default 20). */
  compileQueueLimit?: number
  /** Builds one user may have waiting for a compile slot before `503 compiler-busy` (default 3). */
  compileQueuePerUser?: number
  /** Builds running at once (default: half the CPUs, at least 1). */
  compileConcurrency?: number
  /** Clock for the trash retention sweep and the version history (tests use a fake one). */
  clock?: () => number
  /** Version history timings and retention (docs/M3.md §1). */
  history?: Partial<HistoryConfig>
  /** How often the trash retention sweep runs (default hourly; it also runs at startup). */
  trashSweepMs?: number
  /** Parsed SyncTeX cache bounds (default 8 builds, 3M records). */
  synctexCache?: SynctexCacheOptions
  /** Garbage collection: grace period, project retention, schedule (docs/M3.md §3). */
  gc?: Partial<GcConfig>
  /** Oversized-doc rebuild thresholds (docs/M3.md §4). */
  rebuild?: Partial<RebuildConfig>
  /**
   * Origin sent by the /healthz WebSocket check (docs/M4.md §1); it must pass `isAllowedOrigin`.
   * main.ts passes the first of ALLOWED_ORIGINS. Default: `http://localhost:<listening port>`.
   */
  healthOrigin?: string
  /** /healthz timeout, cache and clock (tests). */
  health?: HealthOptions
}

export interface WsLimits {
  /** max frame size for sockets with a valid session (a Yjs sync of a large doc fits easily) */
  maxPayload: number
  /** concurrent sockets per user */
  maxSocketsPerUser: number
  /** sockets without a valid session: max frame size, total bytes per socket lifetime, concurrent count */
  anonMaxPayload: number
  anonMaxBytes: number
  maxAnonSockets: number
}

export const DEFAULT_WS_LIMITS: WsLimits = {
  maxPayload: 8 * 1024 * 1024,
  maxSocketsPerUser: 32,
  anonMaxPayload: 64 * 1024,
  anonMaxBytes: 256 * 1024,
  maxAnonSockets: 256,
}

export interface Ligature extends Services {
  server: Server
  app: ReturnType<typeof createApp>
  collab: Collab
  limiters: Limiters
  orchestrator: CompileOrchestrator
  compiler: CompilerClient
  /** Purge trash batches past their retention (runs at startup and every `trashSweepMs`). */
  sweepTrash(now?: number): Promise<number>
  /** Blob GC, retention, storage report (docs/M3.md §3, §5). */
  maintenance: Maintenance
  /** Oversized-doc rebuild (docs/M3.md §4). */
  rebuilder: Rebuilder
  /** GET /healthz (docs/M4.md §1). */
  health: Health
  /** First-admin setup token, or null (development, or accounts existed at startup). main.ts logs it. */
  setupToken: string | null
  /** Resolves once listening. */
  listening: Promise<void>
  /** Flush documents and close everything (does not exit the process). */
  stop(): Promise<void>
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x))
    else if (v !== undefined) headers.set(k, v)
  }
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { headers })
}

/** Build and start the whole app server (HTTP API + static SPA + Hocuspocus WebSocket). */
export function startLigature(cfg: LigatureConfig): Ligature {
  const db: DB = openDb(join(cfg.dataDir, 'app.db'))
  // Tells `ligature restore` that this DATA_DIR is in use (removed again once the database is closed).
  const heartbeat = startHeartbeat(cfg.dataDir)
  const store = new DocStore(db)
  const collab = createCollab(db, store, cfg.sessionCheckMs !== undefined ? { sessionCheckMs: cfg.sessionCheckMs } : {})
  const blobs = new BlobStore(db, join(cfg.dataDir, 'blobs'))
  const limits: Limits = { ...DEFAULT_LIMITS, ...cfg.limits }
  const clock = cfg.clock ?? Date.now
  const history = createHistory({ db, store, collab, blobs, limits }, { clock, ...(cfg.history ? { config: cfg.history } : {}) })
  collab.setChangeHooks(history.docHooks)
  // Oversized docs are rebuilt when compacted with nobody connected: on unload, and in startup recovery.
  const rebuilder = createRebuilder({ db, store, collab, isBusy: id => history.isBusy(id) }, { ...DEFAULT_REBUILD, ...cfg.rebuild })
  collab.setCompactionHook((name, c) => { rebuilder.afterCompaction(name, c, true) })
  const recovered = store.recoverAll((name, c) => { rebuilder.afterCompaction(name, c, false) })
  if (recovered) console.log(`[startup] recovered ${recovered} doc(s) from the update log`)
  if (cfg.seed) seedDev(db, store)
  const compiler = new CompilerClient(cfg.compilerUrl)
  const outputsDir = join(cfg.dataDir, 'outputs')
  const orchestrator = new CompileOrchestrator(db, store, collab, compiler, outputsDir, blobs.dir, {
    concurrency: cfg.compileConcurrency ?? Math.max(1, Math.floor(availableParallelism() / 2)),
    maxQueue: cfg.compileQueueLimit ?? DEFAULT_MAX_COMPILE_QUEUE,
    ...(cfg.compileQueuePerUser !== undefined ? { maxQueuePerUser: cfg.compileQueuePerUser } : {}),
    ...(cfg.synctexCache ? { synctexCache: cfg.synctexCache } : {}),
    onSuccess: projectId => { history.onCompileSuccess(projectId) },
  })

  // Trash retention: sweep at startup and periodically.
  const services: Services = { db, store, collab, blobs, limits, history }
  const sweepTrash = (now = clock()) => sweepTrashBatches(services, now)
  const runSweep = () => {
    if (!db.open) return
    sweepTrash().then(n => { if (n) console.log(`[trash] purged ${n} expired batch(es)`) },
      e => console.error('[trash] sweep failed', e))
  }
  runSweep()
  const sweepTimer = setInterval(runSweep, cfg.trashSweepMs ?? 60 * 60 * 1000)
  sweepTimer.unref()
  // Version scheduler: a first pass now (pre-M3 projects get their first version), then every 30 s.
  history.start()
  // Daily GC (blobs, orphan docs, purged projects, thinning, trash retention).
  const maintenance = createMaintenance({ services, outputsDir, clock, ...(cfg.gc ? { config: cfg.gc } : {}) })
  maintenance.start()
  const limiters = createLimiters({ ...DEFAULT_RATE_LIMITS, ...cfg.rateLimits })

  // Health checks of the real paths (docs/M4.md §1). The socket check dials our own listener, so it reads
  // the bound address when it runs (the server is created below; probes only run once requests arrive).
  // Its token keeps that socket out of the anonymous-socket cap (see HEALTH_PROBE_HEADER).
  const probeToken = createProbeToken()
  const health = createHealth({
    db: dbProbe(db),
    disk: diskProbe(cfg.dataDir),
    store: storeProbe(store),
    collab: collabProbe(() => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return null
      return { url: loopbackUrl(addr, '/collab'), origin: cfg.healthOrigin ?? `http://localhost:${addr.port}`, token: probeToken }
    }),
    compiler: compilerProbe(compiler),
  }, cfg.health)

  const webDistDir = cfg.webDistDir && existsSync(join(cfg.webDistDir, 'index.html')) ? cfg.webDistDir : null
  // A fresh public instance must not make whoever comes first its admin (auth/setup.ts).
  const setupToken = cfg.production && !hasUsers(db) ? createSetupToken() : null
  const app = createApp({
    db, store, collab, blobs, limits, history, limiters, compile: orchestrator, maintenance, rebuilder, setupToken,
    isAllowedOrigin: cfg.isAllowedOrigin, devLogin: cfg.devLogin, secureCookies: cfg.production,
    trustProxy: cfg.trustProxy, webDistDir, health,
  })
  const server = createAdaptorServer({ fetch: app.fetch }) as Server

  // WebSocket: one endpoint, many docs multiplexed by the Hocuspocus provider.
  // Sockets with a valid session cookie get the normal frame limit. Sockets without one are still
  // accepted, so the provider receives a proper `unauthenticated` denial (the web app relies on it),
  // but they get tiny frames, a small lifetime byte budget and a process-wide count cap: they can
  // never make the server buffer much.
  const ws = { ...DEFAULT_WS_LIMITS, ...cfg.wsLimits }
  const wssAuthed = new WebSocketServer({ noServer: true, maxPayload: ws.maxPayload })
  const wssAnon = new WebSocketServer({ noServer: true, maxPayload: ws.anonMaxPayload })
  const socketsPerUser = new Map<string, number>()
  let anonSockets = 0
  const reject = (socket: Duplex, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname !== '/collab' || !cfg.isAllowedOrigin(req.headers.origin)) return reject(socket, '403 Forbidden')
    const userId = sessionForToken(db, readCookie(req.headers.cookie, SESSION_COOKIE))?.user.id ?? null
    if (userId !== null && (socketsPerUser.get(userId) ?? 0) >= ws.maxSocketsPerUser) return reject(socket, '429 Too Many Requests')
    // The /healthz check's own socket (one per scope at most: single flight; closed at once) is not counted: a full anonymous
    // cap must not read as "collab is broken" (docs/M4.md §1).
    const probe = userId === null && isProbeToken(probeToken, req.headers[HEALTH_PROBE_HEADER])
    if (userId === null && !probe && anonSockets >= ws.maxAnonSockets) return reject(socket, '503 Service Unavailable')
    // Count before the (async) handshake completes, so a burst cannot overshoot the caps.
    if (userId !== null) socketsPerUser.set(userId, (socketsPerUser.get(userId) ?? 0) + 1)
    else if (!probe) anonSockets++
    let counted = !probe
    const uncount = () => {
      if (!counted) return
      counted = false
      if (userId === null) { anonSockets--; return }
      const n = (socketsPerUser.get(userId) ?? 1) - 1
      if (n <= 0) socketsPerUser.delete(userId)
      else socketsPerUser.set(userId, n)
    }
    socket.once('close', uncount)
    ;(userId !== null ? wssAuthed : wssAnon).handleUpgrade(req, socket, head, sock => {
      const conn = collab.hocuspocus.handleConnection(sock, toRequest(req))
      let anonBytes = 0
      sock.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        if (userId === null && (anonBytes += buf.byteLength) > ws.anonMaxBytes) {
          sock.terminate()
          return
        }
        conn.handleMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      })
      sock.on('pong', () => conn.touch())
      sock.on('close', (code, reason) => {
        uncount()
        conn.handleClose({ code, reason: reason.toString() })
      })
      sock.on('error', err => console.error('[ws] error', err))
    })
  })

  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, cfg.host, () => resolve())
  })

  let stopped = false
  return {
    db, store, collab, blobs, limits, history, limiters, server, app, orchestrator, compiler, listening, sweepTrash,
    maintenance, rebuilder, health, setupToken,
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(sweepTimer)
      await maintenance.stop()
      history.stop() // changes are still noted while shutting down; dirty projects are versioned at the next start
      await orchestrator.synctex.close()
      for (const c of [...wssAuthed.clients, ...wssAnon.clients]) c.terminate()
      await collab.shutdown()
      wssAuthed.close()
      wssAnon.close()
      server.closeAllConnections?.()
      await new Promise<void>(r => server.close(() => r()))
      db.close()
      heartbeat.stop()
    },
  }
}
