import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { createAdaptorServer } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { openDb } from './db/index.ts'
import { DocStore } from './collab/docStore.ts'
import { createCollab } from './collab/collab.ts'
import { CompilerClient } from './compile/compilerClient.ts'
import { CompileOrchestrator } from './compile/orchestrator.ts'
import { createApp } from './http/app.ts'
import { seedDev } from './dev/seed.ts'
import { originChecker } from './http/origins.ts'

const env = process.env
const PROD = env.NODE_ENV === 'production'
const PORT = Number(env.PORT ?? 3000)
const HOST = env.HOST ?? (PROD ? '0.0.0.0' : '127.0.0.1')
const DATA_DIR = resolve(env.DATA_DIR ?? 'data')
const COMPILER_URL = env.COMPILER_URL ?? (PROD ? 'unix:/run/ligature/compiler.sock' : 'http://127.0.0.1:7071')
const ALLOWED_ORIGINS = new Set((env.ALLOWED_ORIGINS ?? (PROD ? '' : 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000'))
  .split(',').map(s => s.trim()).filter(Boolean))
const DEV_LOGIN = !PROD && env.DEV_LOGIN !== '0'

if (PROD && ALLOWED_ORIGINS.size === 0) throw new Error('ALLOWED_ORIGINS must be set in production')
const isAllowedOrigin = originChecker(ALLOWED_ORIGINS, !PROD)
if (PROD && COMPILER_URL.startsWith('http:') && env.ALLOW_TCP_COMPILER !== '1') {
  throw new Error('In production the compiler must be reached over a unix socket (COMPILER_URL=unix:...)')
}

const db = openDb(join(DATA_DIR, 'app.db'))
const store = new DocStore(db)
const recovered = store.recoverAll()
if (recovered) console.log(`[startup] recovered ${recovered} doc(s) from the update log`)
if (!PROD) seedDev(db, store)

const collab = createCollab(db, store)
const compiler = new CompilerClient(COMPILER_URL)
const orchestrator = new CompileOrchestrator(db, store, collab, compiler,
  join(DATA_DIR, 'outputs'), join(DATA_DIR, 'blobs'), Math.max(1, Math.floor(availableParallelism() / 2)))

const app = createApp({ db, compile: orchestrator, isAllowedOrigin, devLogin: DEV_LOGIN, secureCookies: PROD })
const server = createAdaptorServer({ fetch: app.fetch })

// WebSocket: one endpoint, many docs multiplexed by the Hocuspocus provider.
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x))
    else if (v !== undefined) headers.set(k, v)
  }
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { headers })
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const origin = req.headers.origin
  if (url.pathname !== '/collab' || !isAllowedOrigin(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    const conn = collab.hocuspocus.handleConnection(ws, toRequest(req))
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      conn.handleMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
    })
    ws.on('pong', () => conn.touch())
    ws.on('close', (code, reason) => conn.handleClose({ code, reason: reason.toString() }))
    ws.on('error', err => console.error('[ws] error', err))
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[ligature] listening on http://${HOST}:${PORT}  data=${DATA_DIR}  compiler=${COMPILER_URL}`)
  compiler.health().then(ok => console.log(`[ligature] compiler ${ok ? 'reachable' : 'NOT reachable (compiles will fail)'}`))
})

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[ligature] ${signal}: flushing documents…`)
  try {
    await collab.shutdown()
    wss.close()
    server.close()
    db.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))
