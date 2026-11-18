import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { fileDocName, type ProjectDetail, type TreeEntry } from '@ligature/shared'
import { killHard, login, ORIGIN, sleep, startServer, stopGracefully, tempDataDir, type RunningServer } from './harness.ts'

/*
 * The M3 done-criterion (docs/M3.md §6): random edits by 3 clients on one doc (two docs in some runs),
 * concurrent edits at the same spot, clients disconnecting and reconnecting, clients paused (editing
 * offline) and resumed, the server SIGKILLed and restarted on the same data dir, random short waits.
 * After each run: every client converges to the same text, a fresh client sees it too, so does a fresh
 * client after a SIGKILL with no client left (recovery from the update log alone), and after a graceful
 * stop and restart.
 *
 * Lost-edit check: every insert is a unique token `«n»`. Inserts never land inside a token and deletes
 * always take whole tokens, so the final text must hold exactly the tokens inserted and never deleted,
 * each once. A disconnect drops a client only after the server acknowledged all its edits, and a kill
 * waits > 400 ms after such a drop, so the documented 200 ms write buffer never holds the only copy.
 *
 * PROPERTY_RUNS (default 25) sets the number of runs; on failure the seed and path are printed:
 * replay with PROPERTY_SEED=<seed> PROPERTY_PATH=<path>.
 */

const RUNS = Number(process.env.PROPERTY_RUNS ?? 25)
const SCALE = process.env.CI ? 2 : 1
const PORT = 39294
const WAIT_MS = 20_000 * SCALE
const MAX_KILLS_PER_RUN = 2

type Cmd =
  | { t: 'insert'; client: number; doc: number; at: number; filler: string }
  | { t: 'burst'; client: number; doc: number; ats: number[] }
  | { t: 'delete'; client: number; doc: number; at: number; len: number }
  | { t: 'same-spot'; doc: number; at: number }
  | { t: 'pause'; client: number }
  | { t: 'resume'; client: number }
  | { t: 'reconnect'; client: number }
  | { t: 'kill'; quiet: boolean }
  | { t: 'wait'; ms: number }

interface Scenario { twoDocs: boolean; cmds: Cmd[] }

const client = fc.integer({ min: 0, max: 2 })
const doc = fc.integer({ min: 0, max: 1 })
/** A position as a fraction (per mille) of the client's current text length. */
const at = fc.integer({ min: 0, max: 1000 })

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('insert' as const), client, doc, at, filler: fc.constantFrom('', 'a', 'xy ', '\n', 'lorem ') }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('burst' as const), client, doc, ats: fc.array(at, { minLength: 2, maxLength: 25 }) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('delete' as const), client, doc, at, len: fc.integer({ min: 1, max: 12 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('same-spot' as const), doc, at }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('pause' as const), client }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('resume' as const), client }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('reconnect' as const), client }) },
  // quiet: wait until the write buffer surely went to disk first (the log-only case, with no client left, ends every run)
  { weight: 2, arbitrary: fc.record({ t: fc.constant('kill' as const), quiet: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 300 }) }) },
)

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({ twoDocs: fc.boolean(), cmds: fc.array(cmdArb, { minLength: 6, maxLength: 30, size: 'medium' }) })

/* ------------------------------------------------------------------ clients */

interface SimDoc { name: string; ydoc: Y.Doc; provider: HocuspocusProvider; denied: string | null }
interface SimClient { socket: HocuspocusProviderWebsocket; docs: SimDoc[]; paused: boolean; destroy(): void }

function makeClient(base: string, cookie: string, docNames: string[]): SimClient {
  const Polyfill = class extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { cookie, origin: ORIGIN } })
      // Closing a socket that is still CONNECTING (a pause or destroy while the provider reconnects after a
      // kill) makes ws emit 'error'; destroy() removes the provider's listeners first. Unhandled, that
      // error would crash the test run although every assertion passed.
      this.on('error', () => undefined)
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: base.replace('http', 'ws') + '/collab', WebSocketPolyfill: Polyfill,
    delay: 100, minDelay: 100, maxDelay: 400, factor: 1.2, jitter: false,
  })
  const docs = docNames.map(name => {
    const ydoc = new Y.Doc()
    const d: SimDoc = { name, ydoc, provider: null as unknown as HocuspocusProvider, denied: null }
    d.provider = new HocuspocusProvider({
      websocketProvider: socket, name, document: ydoc, token: '',
      onAuthenticationFailed: ({ reason }) => { d.denied = reason },
    })
    d.provider.attach()
    return d
  })
  return {
    socket, docs, paused: false,
    destroy() {
      for (const d of docs) { d.provider.destroy(); d.ydoc.destroy() }
      socket.destroy()
    },
  }
}

const isReady = (c: SimClient) => c.socket.status === 'connected'
  && c.docs.every(d => d.provider.isSynced && !d.provider.hasUnsyncedChanges)

/** Client state, for failure messages. */
const describeClients = (cs: SimClient[]) => cs.map((c, i) => `client ${i}: socket=${c.socket.status} paused=${c.paused} `
  + c.docs.map(d => `[synced=${d.provider.isSynced} unsynced=${d.provider.hasUnsyncedChanges} denied=${d.denied} `
    + `len=${d.ydoc.getText('content').length}]`).join(' ')).join('\n')

async function until(cond: () => boolean, what: string, clients: SimClient[] = [], timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${describeClients(clients)}`)
    await sleep(20)
  }
}

/* ------------------------------------------------------------------ tokens */

const TOKEN_RE = /«\d+»/g

function tokenSpans(text: string): { start: number; end: number; token: string }[] {
  return [...text.matchAll(TOKEN_RE)].map(m => ({ start: m.index, end: m.index + m[0].length, token: m[0] }))
}

/** A position never inside a token. */
function snapInsert(text: string, pos: number): number {
  for (const s of tokenSpans(text)) if (s.start < pos && pos < s.end) return s.end
  return pos
}

/** [start, end) widened to whole tokens, and the tokens it covers. */
function snapDelete(text: string, start: number, end: number): { start: number; end: number; tokens: string[] } {
  const tokens: string[] = []
  for (const s of tokenSpans(text)) {
    if (s.end <= start || s.start >= end) continue
    start = Math.min(start, s.start)
    end = Math.max(end, s.end)
    tokens.push(s.token)
  }
  return { start, end, tokens }
}

/* ------------------------------------------------------------------ the test */

describe('convergence under random edits, disconnects and server kills (property)', () => {
  const dataDir = tempDataDir()
  let server: RunningServer
  let cookie = ''
  let runNo = 0
  const durations: number[] = []
  /** What the runs exercised (printed at the end). */
  const stats = { kills: 0, pauses: 0, reconnects: 0, tokens: 0, deletedTokens: 0, twoDocs: 0 }

  async function ensureServer(): Promise<void> {
    if (server && server.proc.exitCode === null && server.proc.signalCode === null) return
    server = await startServer(dataDir, PORT)
  }

  /** REST call that retries once on a network error (a keep-alive socket of a killed server). */
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`${server.base}${path}`, {
          method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
        if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`)
        return await r.json() as T
      } catch (e) {
        if (attempt >= 2 || !(e instanceof TypeError)) throw e
        await sleep(50)
      }
    }
  }

  beforeAll(async () => {
    server = await startServer(dataDir, PORT)
    cookie = await login(server.base, 'alice')
  }, 60_000)

  afterAll(async () => {
    if (server) await killHard(server)
    if (durations.length > 0) {
      const total = durations.reduce((a, b) => a + b, 0)
      console.log(`[property] ${durations.length} runs, ${(total / 1000).toFixed(1)} s total, `
        + `slowest ${(Math.max(...durations) / 1000).toFixed(1)} s, mean ${(total / durations.length / 1000).toFixed(1)} s; `
        + `exercised ${JSON.stringify(stats)}`)
    }
  })

  async function runScenario(sc: Scenario): Promise<void> {
    const t0 = Date.now()
    await ensureServer()
    const n = ++runNo
    const p = await api<ProjectDetail>('POST', '/api/projects', { name: `Property run ${n}` })
    const main = p.tree.find(f => f.name === 'main.tex')!
    const names = [fileDocName(p.id, main.id, main.epoch!)]
    if (sc.twoDocs) {
      const b = await api<TreeEntry>('POST', `/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'b.tex', kind: 'text', content: 'second doc\n' })
      names.push(fileDocName(p.id, b.id, b.epoch!))
    }
    const clients: SimClient[] = [0, 1, 2].map(() => makeClient(server.base, cookie, names))
    const all: SimClient[] = [...clients]
    let seq = 0
    const inserted = names.map(() => new Set<string>())
    const deleted = new Set<string>()
    let lastDrop = 0
    let kills = 0
    const docOf = (c: SimClient, i: number) => c.docs[i % names.length]!
    const ytext = (d: SimDoc) => d.ydoc.getText('content')

    const insertToken = (c: SimClient, docIdx: number, frac: number, filler: string) => {
      const d = docOf(c, docIdx)
      const t = ytext(d)
      const pos = snapInsert(t.toString(), Math.round(t.length * frac / 1000))
      const token = `«${++seq}»`
      inserted[docIdx % names.length]!.add(token)
      t.insert(pos, token + filler)
    }

    try {
      await until(() => clients.every(isReady), 'initial sync', clients)
      for (const cmd of sc.cmds) {
        switch (cmd.t) {
          case 'insert': insertToken(clients[cmd.client]!, cmd.doc, cmd.at, cmd.filler); break
          case 'burst': for (const a of cmd.ats) insertToken(clients[cmd.client]!, cmd.doc, a, ''); break
          case 'delete': {
            const d = docOf(clients[cmd.client]!, cmd.doc)
            const t = ytext(d)
            if (t.length === 0) break
            const s0 = Math.min(Math.round(t.length * cmd.at / 1000), t.length - 1)
            const r = snapDelete(t.toString(), s0, Math.min(t.length, s0 + cmd.len))
            for (const tok of r.tokens) deleted.add(tok)
            t.delete(r.start, r.end - r.start)
            break
          }
          case 'same-spot': // all three clients edit the same spot before any of them hears from the others
            for (const c of clients) insertToken(c, cmd.doc, cmd.at, '')
            break
          case 'pause': {
            const c = clients[cmd.client]!
            if (c.paused) break
            c.paused = true
            stats.pauses++
            c.socket.disconnect()
            // The provider only notices the close asynchronously (and a connect() before that is a no-op).
            await until(() => c.socket.status !== 'connected', 'pause', [c])
            break
          }
          case 'resume': {
            const c = clients[cmd.client]!
            if (c.paused) { c.paused = false; void c.socket.connect().catch(() => undefined) }
            break
          }
          case 'reconnect': {
            // Drop the client once the server has acknowledged everything it holds, then join afresh.
            const old = clients[cmd.client]!
            if (old.paused) break
            await until(() => isReady(old), 'client acknowledged before reconnect', [old])
            old.destroy()
            stats.reconnects++
            lastDrop = Date.now()
            const fresh = makeClient(server.base, cookie, names)
            clients[cmd.client] = fresh
            all.push(fresh)
            await until(() => isReady(fresh), 'reconnected client sync', [fresh])
            break
          }
          case 'kill': {
            if (kills >= MAX_KILLS_PER_RUN) break
            kills++
            stats.kills++
            const since = Date.now() - lastDrop
            if (cmd.quiet) await sleep(450)
            else if (since < 450) await sleep(450 - since) // a dropped client's edits must have left the write buffer
            await killHard(server)
            server = await startServer(dataDir, PORT)
            break
          }
          case 'wait': await sleep(cmd.ms); break
        }
      }

      // Converge: everyone back online, synced, acknowledged, and holding the same texts.
      for (const c of clients) if (c.paused) { c.paused = false; void c.socket.connect().catch(() => undefined) }
      const textsOf = (cs: SimClient[]) => names.map((_, i) => cs.map(c => ytext(c.docs[i]!).toString()))
      await until(() => clients.every(isReady) && textsOf(clients).every(ts => ts.every(t => t === ts[0])), 'convergence', clients)
      const finals = textsOf(clients).map(ts => ts[0]!)
      for (const c of clients) for (const d of c.docs) expect(d.denied).toBeNull()

      if (sc.twoDocs) stats.twoDocs++
      stats.tokens += seq
      stats.deletedTokens += deleted.size
      // No acknowledged edit lost, nothing resurrected or duplicated.
      finals.forEach((text, i) => {
        const found = (text.match(TOKEN_RE) ?? []).sort()
        const want = [...inserted[i]!].filter(tok => !deleted.has(tok)).sort()
        expect(found).toEqual(want)
      })

      // A fresh client sees exactly that.
      const check = async (what: string) => {
        const f = makeClient(server.base, cookie, names)
        all.push(f)
        await until(() => isReady(f), `fresh client sync (${what})`, [f])
        expect(f.docs.map(d => ytext(d).toString()), what).toEqual(finals)
        f.destroy()
      }
      await check('fresh client')
      // Log-only recovery: SIGKILL while the docs are still loaded (no unload compaction) once the write
      // buffer surely reached the update log, with no client left to send its edits again.
      await sleep(450)
      await killHard(server)
      for (const c of all) c.destroy()
      server = await startServer(dataDir, PORT)
      await check('fresh client after kill -9 with no surviving client')
      // And after a graceful stop and restart, from disk alone.
      await stopGracefully(server)
      server = await startServer(dataDir, PORT)
      await check('fresh client after graceful restart')
    } finally {
      for (const c of all) c.destroy()
      durations.push(Date.now() - t0)
    }
  }

  it(`all clients converge and the persisted text equals theirs (${RUNS} runs)`, async () => {
    const seed = process.env.PROPERTY_SEED !== undefined ? Number(process.env.PROPERTY_SEED) : undefined
    const path = process.env.PROPERTY_PATH
    const details = await fc.check(fc.asyncProperty(scenarioArb, runScenario), {
      numRuns: RUNS,
      endOnFailure: true, // each run takes seconds against a real server: report the first failure as is
      ...(seed !== undefined ? { seed } : {}),
      ...(path !== undefined ? { path } : {}),
    })
    if (details.failed) {
      console.error(`[property] FAILED — replay with PROPERTY_SEED=${details.seed} PROPERTY_PATH=${details.counterexamplePath ?? ''}`)
      console.error(`[property] counterexample: ${fc.stringify(details.counterexample)}`)
      console.error('[property] error:', details.errorInstance)
    }
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false)
  }, RUNS * 60_000 * SCALE + 120_000)
})
