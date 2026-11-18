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
import { CompileOrchestrator } from './compile/orchestrator.ts'
import { createApp } from './http/app.ts'
import { createLimiters, DEFAULT_RATE_LIMITS, type Limiters, type RateLimitConfig } from './http/rateLimit.ts'
import { BlobStore } from './files/blobStore.ts'
import { DEFAULT_LIMITS, type Limits, type Services } from './services.ts'
import { seedDev } from './dev/seed.ts'
import { readCookie, SESSION_COOKIE, sessionForToken } from './auth/sessions.ts'

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
  const store = new DocStore(db)
  const recovered = store.recoverAll()
  if (recovered) console.log(`[startup] recovered ${recovered} doc(s) from the update log`)
  if (cfg.seed) seedDev(db, store)

  const collab = createCollab(db, store, cfg.sessionCheckMs !== undefined ? { sessionCheckMs: cfg.sessionCheckMs } : {})
  const blobs = new BlobStore(db, join(cfg.dataDir, 'blobs'))
  const compiler = new CompilerClient(cfg.compilerUrl)
  const orchestrator = new CompileOrchestrator(db, store, collab, compiler,
    join(cfg.dataDir, 'outputs'), blobs.dir, Math.max(1, Math.floor(availableParallelism() / 2)))
  const limits: Limits = { ...DEFAULT_LIMITS, ...cfg.limits }
  const limiters = createLimiters({ ...DEFAULT_RATE_LIMITS, ...cfg.rateLimits })

  const webDistDir = cfg.webDistDir && existsSync(join(cfg.webDistDir, 'index.html')) ? cfg.webDistDir : null
  const app = createApp({
    db, store, collab, blobs, limits, limiters, compile: orchestrator,
    isAllowedOrigin: cfg.isAllowedOrigin, devLogin: cfg.devLogin, secureCookies: cfg.production,
    trustProxy: cfg.trustProxy, webDistDir,
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
    if (userId === null && anonSockets >= ws.maxAnonSockets) return reject(socket, '503 Service Unavailable')
    // Count before the (async) handshake completes, so a burst cannot overshoot the caps.
    if (userId !== null) socketsPerUser.set(userId, (socketsPerUser.get(userId) ?? 0) + 1)
    else anonSockets++
    let counted = true
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
    db, store, collab, blobs, limits, limiters, server, app, orchestrator, compiler, listening,
    async stop() {
      if (stopped) return
      stopped = true
      for (const c of [...wssAuthed.clients, ...wssAnon.clients]) c.terminate()
      await collab.shutdown()
      wssAuthed.close()
      wssAnon.close()
      server.closeAllConnections?.()
      await new Promise<void>(r => server.close(() => r()))
      db.close()
    },
  }
}
