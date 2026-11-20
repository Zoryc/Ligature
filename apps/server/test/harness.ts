import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { ProjectDetail } from '@ligature/shared'

const SERVER_DIR = resolve(import.meta.dirname, '..')
export const ORIGIN = 'http://localhost:5173'

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'ligature-test-'))
}

export interface RunningServer { proc: ChildProcess; port: number; base: string; output: () => string }

/** Start the real server as a child process (node + tsx loader, so SIGKILL hits the server itself). */
export async function startServer(dataDir: string, port: number, extraEnv: Record<string, string> = {}): Promise<RunningServer> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), DATA_DIR: dataDir, COMPILER_URL: 'http://127.0.0.1:1', ...extraEnv },
    // The IPC channel lets tests ask for a graceful stop on Windows too (see stopGracefully).
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let out = ''
  proc.stdout!.on('data', d => { out += d })
  proc.stderr!.on('data', d => { out += d })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${out}`)
    try { if ((await fetch(`${base}/api/health`)).ok) return { proc, port, base, output: () => out } } catch { /* not up yet */ }
    await sleep(100)
  }
  proc.kill('SIGKILL')
  throw new Error(`server did not start:\n${out}`)
}

export async function killHard(s: RunningServer): Promise<void> {
  if (s.proc.exitCode !== null || s.proc.signalCode !== null) return
  const exited = new Promise(r => s.proc.once('exit', r))
  s.proc.kill('SIGKILL')
  await exited
}

/**
 * Graceful stop (flush documents, close the database), as on SIGTERM. Windows has no SIGTERM for child
 * processes, so there the same shutdown is requested over the IPC channel.
 */
export async function stopGracefully(s: RunningServer, timeoutMs = 15_000): Promise<void> {
  if (s.proc.exitCode !== null || s.proc.signalCode !== null) return
  const exited = new Promise<void>(r => s.proc.once('exit', () => r()))
  if (process.platform === 'win32') s.proc.send('shutdown')
  else s.proc.kill('SIGTERM')
  const timer = setTimeout(() => s.proc.kill('SIGKILL'), timeoutMs)
  await exited
  clearTimeout(timer)
  if (s.proc.exitCode !== 0) throw new Error(`graceful stop failed (exit ${s.proc.exitCode}, signal ${s.proc.signalCode}):\n${s.output()}`)
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function login(base: string, username: string): Promise<string> {
  const r = await fetch(`${base}/api/dev/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username }),
  })
  if (!r.ok) throw new Error(`login failed ${r.status}`)
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!
  return cookie
}

export async function getJson<T>(base: string, path: string, cookie: string): Promise<T> {
  const r = await fetch(`${base}${path}`, { headers: { cookie } })
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`)
  return r.json() as Promise<T>
}

export async function demoProject(base: string, cookie: string): Promise<ProjectDetail> {
  const list = await getJson<{ id: string }[]>(base, '/api/projects', cookie)
  return getJson<ProjectDetail>(base, `/api/projects/${list[0]!.id}`, cookie)
}

/**
 * A Node Hocuspocus client that authenticates with the session cookie, like a browser would. A function
 * gives the cookie of each (re)connection: the browser's cookie after its user logged in again.
 */
export function connect(base: string, cookie: string | (() => string), docName: string) {
  const Polyfill = class extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { cookie: typeof cookie === 'string' ? cookie : cookie(), origin: ORIGIN } })
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: base.replace('http', 'ws') + '/collab',
    WebSocketPolyfill: Polyfill,
    delay: 100, minDelay: 100, maxDelay: 500, factor: 1.2, jitter: false,
  })
  const doc = new Y.Doc()
  let denied: string | null = null
  /** Reasons of per-document CLOSE messages from the server (revocation). */
  const closes: string[] = []
  /** Stateless payloads received (MetaEvents on the meta doc). */
  const stateless: string[] = []
  const provider = new HocuspocusProvider({
    websocketProvider: socket, name: docName, document: doc, token: '',
    onAuthenticationFailed: ({ reason }) => { denied = reason },
    onClose: ({ event }) => { if (event?.reason) closes.push(event.reason) },
    onStateless: ({ payload }) => { stateless.push(payload) },
  })
  provider.attach()
  return {
    doc, provider, socket, closes, stateless,
    text: () => doc.getText('content'),
    denied: () => denied,
    events: () => stateless.map(s => JSON.parse(s) as { type: string; [k: string]: unknown }),
    destroy: () => { provider.destroy(); socket.destroy() },
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

export const COMPILER_DIR = resolve(import.meta.dirname, '../../compiler')
export const HAS_LATEXMK = spawnSync('latexmk -v', { shell: true, stdio: 'ignore' }).status === 0

/** Start the real compiler worker (SANDBOX=none) on a TCP port. */
export async function startCompiler(port: number): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ['src/worker.ts'], {
    cwd: COMPILER_DIR,
    env: { ...process.env, NODE_ENV: 'development', COMPILER_LISTEN: `tcp:127.0.0.1:${port}`, SANDBOX: 'none',
      BUILDS_DIR: mkdtempSync(join(tmpdir(), 'ligature-builds-')) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  proc.stdout!.on('data', d => { out += d }); proc.stderr!.on('data', d => { out += d })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`compiler exited:\n${out}`)
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return proc } catch { /* not up */ }
    await sleep(100)
  }
  proc.kill('SIGKILL')
  throw new Error(`compiler did not start:\n${out}`)
}
