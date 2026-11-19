import { createServer, type Server, type Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { openDb } from '../src/db/index.ts'
import { DocStore, TEXT_KEY } from '../src/collab/docStore.ts'
import {
  collabProbe, createHealth, createProbeToken, diskProbe, isProbeToken, loopbackUrl, MB, storeProbe, type Probe, type ProbeResult,
  type Probes,
} from '../src/health/health.ts'

/** Unit tests for the /healthz runner and its probes (docs/M4.md §1). Ports: 39610–39619 only. */

const ok: Probe = () => ({ status: 'ok' })

function counting(result: ProbeResult = { status: 'ok' }) {
  const p = Object.assign(async () => { p.calls++; return result }, { calls: 0 })
  return p
}

function probes(over: Partial<Probes> = {}): Probes {
  return { db: ok, disk: ok, store: ok, collab: ok, compiler: ok, ...over }
}

describe('createHealth', () => {
  it('caches a report for 5 s per scope, then runs again', async () => {
    let now = 1_000_000
    const compiler = counting()
    const db = counting()
    const h = createHealth(probes({ db, compiler }), { clock: () => now })

    const a = await h.report('full')
    expect(a).toMatchObject({ ok: true, status: 'ok', at: 1_000_000 })
    now += 4_999
    expect(await h.report('full')).toBe(a)
    expect(compiler.calls).toBe(1)
    expect(db.calls).toBe(1)

    // The app scope has its own cache entry and never asks the compiler.
    const app = await h.report('app')
    expect(app.checks.compiler).toBeUndefined()
    expect(compiler.calls).toBe(1)
    expect(db.calls).toBe(2)

    now += 1
    const b = await h.report('full')
    expect(b).not.toBe(a)
    expect(b.at).toBe(1_005_000)
    expect(compiler.calls).toBe(2)
  })

  it('concurrent callers share one run (single flight)', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let calls = 0
    const collab: Probe = async () => { calls++; await gate; return { status: 'ok' } }
    const h = createHealth(probes({ collab }), { cacheMs: 0 })
    const all = Promise.all([h.report('full'), h.report('full'), h.report('full')])
    await new Promise(r => setTimeout(r, 10))
    release()
    const [a, b, c] = await all
    expect(calls).toBe(1)
    expect(b).toBe(a)
    expect(c).toBe(a)
    // With no cache, the next call after the run finished starts a new one.
    await h.report('full')
    expect(calls).toBe(2)
  })

  it('a check over its timeout fails with `timeout` and is told to stop', async () => {
    let aborted = false
    const collab: Probe = signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true }) })
    const h = createHealth(probes({ collab }), { timeoutMs: 50 })
    const r = await h.report('app')
    expect(r.checks.collab).toMatchObject({ status: 'fail', reason: 'timeout' })
    expect(r.checks.collab.ms).toBeGreaterThanOrEqual(40)
    expect(aborted).toBe(true)
    expect(r).toMatchObject({ ok: false, status: 'down' })
  })

  it('an exception is `fail` / `error`, without its message', async () => {
    const db: Probe = () => { throw new Error('SQLITE_CORRUPT at C:/secret/data/app.db') }
    const h = createHealth(probes({ db }))
    const r = await h.report('full')
    expect(r.checks.db).toEqual({ status: 'fail', reason: 'error', ms: expect.any(Number) })
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('warnings only: degraded but ok; checks run in parallel', async () => {
    const slow = (res: ProbeResult): Probe => () => new Promise(r => setTimeout(() => r(res), 150))
    const h = createHealth(probes({ disk: slow({ status: 'warn', reason: 'low-disk', freeBytes: 5 }), collab: slow({ status: 'ok' }),
      compiler: slow({ status: 'ok' }) }))
    const t = performance.now()
    const r = await h.report('full')
    expect(performance.now() - t).toBeLessThan(400)
    expect(r).toMatchObject({ ok: true, status: 'degraded', checks: { disk: { status: 'warn', reason: 'low-disk', freeBytes: 5 } } })
  })
})

describe('diskProbe', () => {
  const fake = (bytes: number) => async () => ({ bavail: BigInt(bytes / 4096), bsize: 4096n })
  const ac = new AbortController()

  it('fails below 100 MB, warns below 1 GB, ok above; reports free bytes', async () => {
    expect(await diskProbe('/d', fake(50 * MB))(ac.signal)).toEqual({ status: 'fail', reason: 'low-disk', freeBytes: 50 * MB })
    expect(await diskProbe('/d', fake(500 * MB))(ac.signal)).toEqual({ status: 'warn', reason: 'low-disk', freeBytes: 500 * MB })
    expect(await diskProbe('/d', fake(10 * 1024 * MB))(ac.signal)).toEqual({ status: 'ok', freeBytes: 10 * 1024 * MB })
  })

  it('without statfs: ok, no number', async () => {
    expect(await diskProbe('/d', null)(ac.signal)).toEqual({ status: 'ok' })
    const nosys = async () => { throw Object.assign(new Error('nope'), { code: 'ENOSYS' }) }
    expect(await diskProbe('/d', nosys)(ac.signal)).toEqual({ status: 'ok' })
  })

  it('the real statfs on a real directory', async () => {
    const r = await diskProbe(process.cwd())(ac.signal)
    expect(r.status === 'ok' || r.freeBytes !== undefined).toBe(true)
    if (r.freeBytes !== undefined) expect(r.freeBytes).toBeGreaterThan(0)
  })
})

describe('loopbackUrl', () => {
  it('maps wildcard binds to loopback of the same family, keeps specific addresses', () => {
    expect(loopbackUrl({ address: '0.0.0.0', family: 'IPv4', port: 3000 }, '/collab')).toBe('ws://127.0.0.1:3000/collab')
    expect(loopbackUrl({ address: '::', family: 'IPv6', port: 3000 }, '/collab')).toBe('ws://[::1]:3000/collab')
    expect(loopbackUrl({ address: '127.0.0.1', family: 'IPv4', port: 8 }, '/collab')).toBe('ws://127.0.0.1:8/collab')
    expect(loopbackUrl({ address: '10.1.2.3', family: 'IPv4', port: 8 }, '/collab')).toBe('ws://10.1.2.3:8/collab')
    expect(loopbackUrl({ address: 'fd00::5', family: 'IPv6', port: 8 }, '/collab')).toBe('ws://[fd00::5]:8/collab')
  })
})

describe('collabProbe', () => {
  it('nothing listening: refused', async () => {
    const p = collabProbe(() => ({ url: 'ws://127.0.0.1:39619/collab', origin: 'http://localhost' }))
    expect(await p(new AbortController().signal)).toEqual({ status: 'fail', reason: 'refused' })
  })

  it('a listener that never answers: timeout, and the socket is closed', async () => {
    const sockets: Socket[] = []
    let closed = 0
    const server: Server = createServer(s => { sockets.push(s); s.resume(); s.on('close', () => closed++) })
    await new Promise<void>(r => server.listen(39618, '127.0.0.1', () => r()))
    try {
      const h = createHealth(probes({ collab: collabProbe(() => ({ url: 'ws://127.0.0.1:39618/collab', origin: 'http://localhost' })) }),
        { timeoutMs: 200 })
      const r = await h.report('app')
      expect(r.checks.collab).toMatchObject({ status: 'fail', reason: 'timeout' })
      await expect.poll(() => closed).toBe(1)
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise(r => server.close(r))
    }
  })
})

describe('probe token', () => {
  it('random per call; only the exact token matches', () => {
    const t = createProbeToken()
    expect(t.length).toBeGreaterThanOrEqual(32)
    expect(createProbeToken()).not.toBe(t)
    expect(isProbeToken(t, t)).toBe(true)
    expect(isProbeToken(t, undefined)).toBe(false)
    expect(isProbeToken(t, '')).toBe(false)
    expect(isProbeToken(t, t.slice(1))).toBe(false)
    expect(isProbeToken(t, `${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`)).toBe(false)
    expect(isProbeToken(t, [t, t])).toBe(false)
  })
})

describe('DocStore.flushFailing', () => {
  it('set by a failed flush (which still throws), cleared by the next successful one', () => {
    const db = openDb(':memory:')
    const store = new DocStore(db)
    const probe = storeProbe(store)
    const signal = new AbortController().signal
    const doc = new Y.Doc()
    store.load('d', doc)
    const edit = (s: string) => {
      const before = Y.encodeStateVector(doc)
      doc.getText(TEXT_KEY).insert(0, s)
      store.append('d', Y.encodeStateAsUpdate(doc, before), null)
    }
    expect(store.flushFailing).toBe(false)
    db.exec("CREATE TRIGGER no_writes BEFORE INSERT ON doc_updates BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END")
    edit('a')
    expect(() => store.flush()).toThrow(/disk I\/O error/)
    expect(store.flushFailing).toBe(true)
    expect(probe(signal)).toEqual({ status: 'fail', reason: 'write-failed' })
    // Flushing again retries the kept batch: still failing.
    expect(() => store.flush()).toThrow(/disk I\/O error/)
    expect(store.flushFailing).toBe(true)
    db.exec('DROP TRIGGER no_writes')
    edit('b')
    store.flush()
    expect(store.flushFailing).toBe(false)
    expect(probe(signal)).toEqual({ status: 'ok' })
    // The batch that failed was kept and written with the next one, in order.
    expect((db.prepare('SELECT seq FROM doc_updates ORDER BY seq').all() as { seq: number }[]).map(r => r.seq)).toEqual([1, 2])
  })

  it('a failed write by the batching timer is logged once, not thrown (the process stays up)', async () => {
    const db = openDb(':memory:')
    const store = new DocStore(db)
    const doc = new Y.Doc()
    store.load('d', doc)
    const edit = (s: string) => {
      const before = Y.encodeStateVector(doc)
      doc.getText(TEXT_KEY).insert(0, s)
      store.append('d', Y.encodeStateAsUpdate(doc, before), null)
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      db.exec("CREATE TRIGGER no_writes BEFORE INSERT ON doc_updates BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END")
      edit('a') // no flush() here: the timer writes it (an uncaught throw would fail this test run)
      await expect.poll(() => store.flushFailing).toBe(true)
      edit('b')
      await new Promise(r => setTimeout(r, 400)) // the timer has tried the second batch by now
      expect(store.flushFailing).toBe(true)
      expect(logged).toHaveBeenCalledTimes(1) // still the same failure: not logged again
      db.exec('DROP TRIGGER no_writes')
      edit('c')
      await expect.poll(() => store.flushFailing, { timeout: 5000 }).toBe(false)
      expect(logged).toHaveBeenCalledTimes(2) // the failure, then "works again"
      // Nothing written while failing is lost: the kept batches are written once the disk accepts them.
      expect((db.prepare('SELECT COUNT(*) AS n FROM doc_updates').get() as { n: number }).n).toBe(3)
      const reloaded = new Y.Doc()
      store.load('d', reloaded)
      expect(reloaded.getText(TEXT_KEY).toString()).toBe('cba')
    } finally {
      logged.mockRestore()
      store.abandonForTest()
      db.close()
    }
  })
})
