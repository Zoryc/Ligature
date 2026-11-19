import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import type { HealthReport } from '@ligature/shared'
import { TEXT_KEY, type DocStore } from '../src/collab/docStore.ts'
import { HEALTH_PROBE_HEADER } from '../src/health/health.ts'
import { ORIGIN } from './harness.ts'
import { startTestServer, type TestServer } from './inproc.ts'

/** GET/HEAD /healthz on a real in-process server (docs/M4.md §1). Ports: 39600–39609 only. */

/** A stand-in compiler worker that answers its /healthz and counts the calls. */
async function fakeCompiler(port: number): Promise<{ server: Server; hits: () => number; url: string }> {
  let hits = 0
  const server = createServer((req, res) => {
    if (req.url === '/healthz') hits++
    res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()))
  return { server, hits: () => hits, url: `http://127.0.0.1:${port}` }
}

async function healthz(ts: TestServer, query = ''): Promise<{ status: number; body: HealthReport; text: string; headers: Headers }> {
  const r = await fetch(`${ts.base}/healthz${query}`)
  const text = await r.text()
  return { status: r.status, body: JSON.parse(text) as HealthReport, text, headers: r.headers }
}

/** An edit to a loaded doc, appended the way the collab layer does it (the batching timer writes it). */
function editor(store: DocStore, name: string) {
  const doc = new Y.Doc()
  store.load(name, doc)
  return (s: string) => {
    const before = Y.encodeStateVector(doc)
    doc.getText(TEXT_KEY).insert(0, s)
    store.append(name, Y.encodeStateAsUpdate(doc, before), null)
  }
}

/** Resolves with the HTTP status of a refused upgrade, or 101 once open (the socket is then left idle). */
function upgrade(port: number, headers: Record<string, string> = {}): Promise<{ status: number; ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/collab`, { headers: { origin: ORIGIN, ...headers } })
  return new Promise(resolve => {
    ws.on('open', () => resolve({ status: 101, ws }))
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0, ws }))
    ws.on('error', () => { /* reported via unexpected-response */ })
  })
}

/** The data path in every spelling it could leak in (raw, JSON-escaped, forward slashes). */
const expectNoDataPath = (text: string, dataDir: string) => {
  for (const p of [dataDir, JSON.stringify(dataDir).slice(1, -1), dataDir.replaceAll('\\', '/')]) expect(text).not.toContain(p)
}

describe('/healthz on a healthy instance', () => {
  let ts: TestServer
  let compiler: Awaited<ReturnType<typeof fakeCompiler>>
  beforeAll(async () => {
    compiler = await fakeCompiler(39601)
    ts = await startTestServer(39600, { compilerUrl: compiler.url, healthOrigin: ORIGIN })
  })
  afterAll(async () => {
    await ts.stop()
    await new Promise(r => compiler.server.close(r))
  })

  it('200, every check ok, no-store, no data path in the body', async () => {
    const r = await healthz(ts)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.body).toMatchObject({
      ok: true, status: 'ok',
      checks: { db: { status: 'ok' }, disk: { status: 'ok' }, store: { status: 'ok' }, collab: { status: 'ok' }, compiler: { status: 'ok' } },
    })
    for (const c of Object.values(r.body.checks)) expect(c.reason).toBeUndefined()
    expectNoDataPath(r.text, ts.dataDir)
    expect(compiler.hits()).toBe(1)
  })

  it('cached: a second call within 5 s runs no checks (same report, no compiler call)', async () => {
    const a = await healthz(ts)
    const b = await healthz(ts)
    expect(b.body).toEqual(a.body)
    expect(compiler.hits()).toBe(1)
  })

  it('HEAD answers the same status with no body', async () => {
    const r = await fetch(`${ts.base}/healthz`, { method: 'HEAD' })
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.text()).toBe('')
  })

  it('?scope=app leaves out the compiler', async () => {
    const r = await healthz(ts, '?scope=app')
    expect(r.status).toBe(200)
    expect(r.body.checks.compiler).toBeUndefined()
    expect(r.body.checks.collab.status).toBe('ok')
  })

  it('/api/health stays plain liveness', async () => {
    const r = await fetch(`${ts.base}/api/health`)
    expect(await r.json()).toEqual({ ok: true })
  })
})

describe('/healthz sees real failures', () => {
  const started: TestServer[] = []
  afterAll(async () => { for (const ts of started) await ts.stop() })
  const start = async (port: number, opts: Parameters<typeof startTestServer>[1]) => {
    const ts = await startTestServer(port, { health: { cacheMs: 0 }, ...opts })
    started.push(ts)
    return ts
  }

  it('compiler on a closed port: 503 with compiler fail, while ?scope=app is 200', async () => {
    const ts = await start(39602, { compilerUrl: 'http://127.0.0.1:39609', healthOrigin: ORIGIN })
    const full = await healthz(ts)
    expect(full.status).toBe(503)
    expect(full.headers.get('cache-control')).toBe('no-store')
    expect(full.body).toMatchObject({ ok: false, status: 'down', checks: { compiler: { status: 'fail', reason: 'unreachable' }, collab: { status: 'ok' } } })
    expectNoDataPath(full.text, ts.dataDir)
    const head = await fetch(`${ts.base}/healthz`, { method: 'HEAD' })
    expect(head.status).toBe(503)
    const app = await healthz(ts, '?scope=app')
    expect(app.status).toBe(200)
    expect(app.body.status).toBe('ok')
  })

  it('an origin list that rejects the loopback origin: collab fails with http-403', async () => {
    // No healthOrigin: the probe sends http://localhost:<port>, which this server's origin list refuses.
    const ts = await start(39603, {})
    const r = await healthz(ts, '?scope=app')
    expect(r.status).toBe(503)
    expect(r.body.checks.collab).toMatchObject({ status: 'fail', reason: 'http-403' })
    expect(r.body.checks.db.status).toBe('ok')
  })

  it('a failed flush of edits: store fails, and is ok again after a successful flush', async () => {
    const ts = await start(39604, { healthOrigin: ORIGIN })
    const { db, store } = ts.lig
    const edit = editor(store, 'health-probe-doc')
    db.exec("CREATE TRIGGER no_writes BEFORE INSERT ON doc_updates BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END")
    edit('x')
    expect(() => store.flush()).toThrow()
    const down = await healthz(ts, '?scope=app')
    expect(down.status).toBe(503)
    expect(down.body.checks.store).toMatchObject({ status: 'fail', reason: 'write-failed' })
    expect(down.text).not.toContain('disk is full')

    db.exec('DROP TRIGGER no_writes')
    edit('y')
    store.flush()
    const up = await healthz(ts, '?scope=app')
    expect(up.status).toBe(200)
    expect(up.body.checks.store.status).toBe('ok')
    store.release('health-probe-doc')
  })

  it('a failed write by the batching timer: the server stays up and reports store fail, then ok', async () => {
    const ts = await start(39606, { healthOrigin: ORIGIN })
    const { db, store } = ts.lig
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const edit = editor(store, 'health-timer-doc')
      db.exec("CREATE TRIGGER no_writes BEFORE INSERT ON doc_updates BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END")
      edit('x') // nobody calls flush(): the 200 ms timer writes it, as for a user typing
      await expect.poll(() => store.flushFailing).toBe(true)
      const down = await healthz(ts, '?scope=app')
      expect(down.status).toBe(503)
      expect(down.body.checks.store).toMatchObject({ status: 'fail', reason: 'write-failed' })
      expect(ts.lig.server.listening).toBe(true)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('[docStore]'), expect.anything())

      db.exec('DROP TRIGGER no_writes')
      edit('y')
      await expect.poll(() => store.flushFailing, { timeout: 5000 }).toBe(false) // the kept batch is retried every second
      expect((db.prepare("SELECT COUNT(*) AS n FROM doc_updates WHERE doc_name = 'health-timer-doc'").get() as { n: number }).n).toBe(2)
      const up = await healthz(ts, '?scope=app')
      expect(up.status).toBe(200)
      expect(up.body.checks.store.status).toBe('ok')
      store.release('health-timer-doc')
    } finally {
      logged.mockRestore()
    }
  })

  it('a full anonymous-socket cap does not make /healthz report down', async () => {
    const ts = await start(39607, { healthOrigin: ORIGIN, wsLimits: { maxAnonSockets: 2 } })
    const idle = [await upgrade(39607), await upgrade(39607)]
    try {
      expect(idle.map(s => s.status)).toEqual([101, 101])
      // The cap is full for everyone else, including a client that guesses at the probe header.
      expect((await upgrade(39607)).status).toBe(503)
      expect((await upgrade(39607, { [HEALTH_PROBE_HEADER]: 'guess' })).status).toBe(503)
      for (const scope of ['?scope=app', '']) {
        const r = await healthz(ts, scope)
        expect(r.body.checks.collab).toEqual(expect.objectContaining({ status: 'ok' }))
        if (scope) expect(r.status).toBe(200)
      }
      // The probe's socket did not take (or free) a slot: the cap still holds.
      expect((await upgrade(39607)).status).toBe(503)
    } finally {
      for (const s of idle) s.ws.terminate()
    }
  })

  it('the probe socket is closed again after each check', async () => {
    const ts = await start(39605, { healthOrigin: ORIGIN, wsLimits: { maxAnonSockets: 1 } })
    // Watch the probe's upgrades from the server side (the probe is not counted, so a leak would not show as a 503).
    let opened = 0
    let closed = 0
    ts.lig.server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      if (req.headers[HEALTH_PROBE_HEADER] === undefined) return
      opened++
      socket.once('close', () => closed++)
    })
    for (let i = 0; i < 3; i++) expect((await healthz(ts, '?scope=app')).body.checks.collab.status).toBe('ok')
    expect(opened).toBe(3)
    await expect.poll(() => closed).toBe(3)
    // And the one anonymous slot is still free for a real client.
    const a = await upgrade(39605)
    expect(a.status).toBe(101)
    a.ws.terminate()
  })
})
