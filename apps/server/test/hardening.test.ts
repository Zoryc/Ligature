import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { connect as netConnect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { fileDocName, type ProjectDetail } from '@ligature/shared'
import { auditEntries } from '../src/audit.ts'
import { sha256 } from '../src/auth/sessions.ts'
import { openDb, type DB } from '../src/db/index.ts'
import { BlobStore } from '../src/files/blobStore.ts'
import { deleteNode } from '../src/files/tree.ts'
import { versionBlobHashes } from '../src/history/store.ts'
import { uploadFile } from '../src/files/upload.ts'
import { isUploadRoute } from '../src/http/app.ts'
import { RateLimiter } from '../src/http/rateLimit.ts'
import { UploadGate } from '../src/http/uploadGate.ts'
import { requireAccess } from '../src/projects/service.ts'
import { connect, killHard, ORIGIN, sleep, startServer, tempDataDir, waitFor } from './harness.ts'
import { addMember, Client, me, newProject, openInstance, PASSWORD, signup, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'

/**
 * Regression tests for the M1 security/correctness review findings. Ports: 39230–39250.
 */
const servers: TestServer[] = []
const cleanups: (() => void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  cleanups.splice(0).forEach(f => f())
  for (const s of servers.splice(0)) await s.stop()
})

async function instance(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const r = await openInstance(port, opts); servers.push(r.ts); return r
}

function open(base: string, c: Client, docName: string) {
  const x = connect(base, c.cookie, docName)
  cleanups.push(() => x.destroy())
  return x
}

async function login(base: string, username: string): Promise<Client> {
  const c = new Client(base, username)
  const r = await c.post('/api/auth/login', { username, password: PASSWORD })
  if (r.status !== 200) throw new Error(`login ${r.status}`)
  return c
}

const count = (statuses: number[]) => statuses.reduce<Record<number, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {})

/** Blob files on disk, not counting the text snapshots of versions (M3: the first change takes a version). */
function blobFiles(dir: string, db?: DB): number {
  const versions = db ? versionBlobHashes(db) : new Set<string>()
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith('.tmp') && !versions.has(`${basename(d.parentPath)}${d.name}`)).length
}

/** A raw HTTP/1.1 upload whose body the test feeds by hand. */
function rawUpload(port: number, c: Client, path: string, declared: number) {
  const sock: Socket = netConnect(port, '127.0.0.1')
  let response = ''
  sock.on('data', d => { response += d.toString('latin1') })
  sock.on('error', () => { /* destroyed by the test */ })
  sock.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${ORIGIN}\r\nCookie: ${c.cookie}\r\n`
    + `Content-Type: application/octet-stream\r\nContent-Length: ${declared}\r\n\r\n`)
  cleanups.push(() => sock.destroy())
  return { sock, response: () => response }
}

describe('login rate limit under concurrency (review: sec 1 / correctness 1)', () => {
  it('concurrent wrong passwords for one user: at most loginPerUser are verified, the rest get 429', async () => {
    const { ts } = await instance(39230, { rateLimits: { loginPerUser: 5, loginPerIp: 1000 } })
    await signup(ts.base, 'victim')
    const attempts = await Promise.all(Array.from({ length: 30 }, () =>
      new Client(ts.base).post('/api/auth/login', { username: 'victim', password: 'wrong password!' })))
    const by = count(attempts.map(r => r.status))
    expect(by).toEqual({ 401: 5, 429: 25 })
    expect(auditEntries(ts.lig.db, 'login-failure')).toHaveLength(5)
  })

  it('concurrent wrong logins for many users from one IP: at most loginPerIp get through', async () => {
    const { ts } = await instance(39231, { rateLimits: { loginPerUser: 1000, loginPerIp: 7 } })
    const attempts = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      new Client(ts.base).post('/api/auth/login', { username: `ghost${i}`, password: 'wrong password!' })))
    expect(count(attempts.map(r => r.status))).toEqual({ 401: 7, 429: 23 })
  })

  it('successful logins are not counted against the IP budget', async () => {
    const { ts } = await instance(39232, { rateLimits: { loginPerUser: 2, loginPerIp: 3 } })
    await signup(ts.base, 'kim')
    for (let i = 0; i < 6; i++) expect((await new Client(ts.base).post('/api/auth/login', { username: 'kim', password: PASSWORD })).status).toBe(200)
    // failures still count: 3 failures (spread over users) exhaust the IP budget
    await new Client(ts.base).post('/api/auth/login', { username: 'kim', password: 'wrong password!' })
    await new Client(ts.base).post('/api/auth/login', { username: 'x1', password: 'wrong password!' })
    await new Client(ts.base).post('/api/auth/login', { username: 'x2', password: 'wrong password!' })
    expect((await new Client(ts.base).post('/api/auth/login', { username: 'kim', password: PASSWORD })).status).toBe(429)
  })

  it('POST /me/password: concurrent wrong current passwords are limited too; a right one is not counted', async () => {
    const { ts } = await instance(39233, { rateLimits: { loginPerUser: 3, loginPerIp: 1000 } })
    const u = await signup(ts.base, 'lee')
    // a correct change first: refunded, so it does not use the budget
    expect((await u.post('/api/me/password', { currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(200)
    const attempts = await Promise.all(Array.from({ length: 12 }, () =>
      u.post('/api/me/password', { currentPassword: 'wrong password!', newPassword: 'another long password' })))
    expect(count(attempts.map(r => r.status))).toEqual({ 403: 3, 429: 9 })
  })

  it('RateLimiter: cost and refund', () => {
    let t = 0
    const l = new RateLimiter(10, 1000, () => t)
    expect(l.consume('k', 6)).toBe(true)
    expect(l.consume('k', 5)).toBe(false) // 6 + 5 > 10: nothing counted
    expect(l.consume('k', 4)).toBe(true)
    expect(l.blocked('k')).toBe(true)
    l.refund('k', 3)
    expect(l.consume('k', 3)).toBe(true)
    l.refund('other') // unknown key: no-op
    t = 1000
    expect(l.consume('k', 10)).toBe(true) // new window
  })
})

describe('audit gaps (review: sec 8)', () => {
  it('correct password for a disabled account: 403 and a login-failure audit row', async () => {
    const { ts, admin } = await instance(39234)
    await signup(ts.base, 'dora')
    const users = (await admin.get('/api/admin/users')).body as { id: string; username: string }[]
    const dora = users.find(u => u.username === 'dora')!
    expect((await admin.patch(`/api/admin/users/${dora.id}`, { disabled: true })).status).toBe(200)
    const r = await new Client(ts.base).post('/api/auth/login', { username: 'dora', password: PASSWORD })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('account-disabled')
    const rows = auditEntries(ts.lig.db, 'login-failure')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actorId: dora.id, detail: { username: 'dora', reason: 'disabled' } })
  })

  it('an invite that upgrades an existing member is audited as invite-accept too', async () => {
    const { ts } = await instance(39235)
    const owner = await signup(ts.base, 'owner')
    const vic = await signup(ts.base, 'vic')
    const p = await newProject(owner)
    await addMember(owner, vic, p.id, 'viewer')
    await addMember(owner, vic, p.id, 'editor')
    const accepts = auditEntries(ts.lig.db, 'invite-accept')
    expect(accepts).toHaveLength(2)
    expect(accepts[1]!.detail).toMatchObject({ role: 'editor', upgrade: true })
    expect(auditEntries(ts.lig.db, 'member-role-change')).toHaveLength(1)
  })
})

describe('JSON body limit only skips the real upload route (review: sec 2)', () => {
  it('isUploadRoute', () => {
    expect(isUploadRoute('POST', '/api/projects/abc/upload')).toBe(true)
    expect(isUploadRoute('PATCH', '/api/projects/abc/upload')).toBe(false)
    expect(isUploadRoute('PATCH', '/api/projects/abc/files/upload')).toBe(false)
    expect(isUploadRoute('PATCH', '/api/projects/abc/members/upload')).toBe(false)
    expect(isUploadRoute('POST', '/api/projects/abc/files/upload')).toBe(false)
    expect(isUploadRoute('POST', '/api/x/upload')).toBe(false)
  })

  it('3 MB JSON to …/files/upload and …/members/upload is 413 (before any body byte); a 3 MB real upload still works', async () => {
    const { ts } = await instance(39236)
    const owner = await signup(ts.base, 'owner')
    const p = await newProject(owner)
    for (const path of [`/api/projects/${p.id}/files/upload`, `/api/projects/${p.id}/members/upload`]) {
      // Headers only: the limit must answer from Content-Length without waiting for (or reading) a body.
      const sock = netConnect(39236, '127.0.0.1')
      cleanups.push(() => sock.destroy())
      let res = ''
      sock.on('data', d => { res += d.toString('latin1') })
      sock.write(`PATCH ${path} HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nCookie: ${owner.cookie}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${3 * 1024 * 1024}\r\n\r\n`)
      await waitFor(() => res.includes('\r\n\r\n') && res.includes('}'), 5_000, `response for ${path}`)
      expect(res.split('\r\n')[0], path).toBe('HTTP/1.1 413 Payload Too Large')
      expect(res).toContain('"too-large"')
    }
    const bin = new Uint8Array(3 * 1024 * 1024).fill(7)
    expect((await owner.upload(p.id, p.rootId, 'big.bin', bin)).status).toBe(200)
  })
})

describe('blobs are written only for accepted uploads (review: sec 3)', () => {
  it('refused uploads leave no blob on disk; an accepted one leaves exactly one', async () => {
    const { ts } = await instance(39237, { limits: { maxBinaryBytes: 50_000 } })
    const owner = await signup(ts.base, 'owner')
    const p = await newProject(owner)
    const png = makePng(16, 16)
    const dir = ts.lig.blobs.dir
    expect((await owner.post(`/api/projects/${p.id}/files`, { parentId: p.rootId, name: 'figs', kind: 'folder' })).status).toBe(200)

    const refused = [
      await owner.upload(p.id, '00000000-0000-4000-8000-000000000000', 'a.png', png), // no such parent
      await owner.upload(p.id, p.rootId, 'figs', png), // a folder has that name
      await owner.upload(p.id, p.rootId, 'main.tex', new Uint8Array([0xff, 0xfe, 0x00])), // binary over a text file
      await owner.upload(p.id, p.rootId, 'huge.bin', new Uint8Array(60_000).fill(1)), // over the project quota
      await owner.upload(p.id, p.rootId, 'bad/name.png', png), // invalid name
    ]
    expect(refused.map(r => r.status)).toEqual([400, 409, 409, 413, 400])
    expect(blobFiles(dir, ts.lig.db)).toBe(0)
    expect(ts.lig.db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE hash NOT IN (SELECT blob_hash FROM version_files)').get()).toEqual({ n: 0 })

    expect((await owner.upload(p.id, p.rootId, 'a.png', png)).status).toBe(200)
    expect(blobFiles(dir, ts.lig.db)).toBe(1)
  })

  it('discardUnrecorded removes a blob whose recording rolled back, never a recorded one', () => {
    const db = openDb(`${tempDataDir()}/app.db`)
    try {
      const blobs = new BlobStore(db, `${tempDataDir()}/blobs`)
      const a = new Uint8Array([1, 2, 3])
      let hash = ''
      expect(() => db.transaction(() => { hash = blobs.put(a); throw new Error('rollback') })()).toThrow('rollback')
      expect(blobs.has(hash)).toBe(true)
      blobs.discardUnrecorded(hash)
      expect(blobs.has(hash)).toBe(false)

      const kept = blobs.put(a)
      blobs.discardUnrecorded(kept)
      expect(blobs.has(kept)).toBe(true)
      expect(blobs.sizeOf(kept)).toBe(3)
    } finally { db.close() }
  })

  it('per-user upload byte budget bounds disk growth from replace loops', async () => {
    const { ts } = await instance(39238, { rateLimits: { uploadBytesPerUser: 2500 } })
    const owner = await signup(ts.base, 'owner')
    const other = await signup(ts.base, 'other')
    const p = await newProject(owner)
    const q = await newProject(other)
    const blob = (n: number) => new Uint8Array(1000).fill(n)
    expect((await owner.upload(p.id, p.rootId, 'x.bin', blob(1))).status).toBe(200)
    expect((await owner.upload(p.id, p.rootId, 'x.bin', blob(2))).status).toBe(200)
    const third = await owner.upload(p.id, p.rootId, 'x.bin', blob(3))
    expect(third.status).toBe(429)
    expect(third.body.error).toBe('rate-limited')
    expect(blobFiles(ts.lig.blobs.dir, ts.lig.db)).toBe(2)
    expect((await other.upload(q.id, q.rootId, 'x.bin', blob(4))).status).toBe(200)
  })
})

describe('upload memory and concurrency (review: sec 4)', () => {
  it('the declared Content-Length is not pre-allocated; an aborted upload is not a server error', async () => {
    const { ts } = await instance(39239, { rateLimits: { uploadConcurrency: 50, uploadConcurrencyPerUser: 50 } })
    const owner = await signup(ts.base, 'owner')
    const p = await newProject(owner)
    const errors = vi.spyOn(console, 'error')
    const path = `/api/projects/${p.id}/upload?parentId=${p.rootId}&name=x.bin`
    const before = process.memoryUsage().arrayBuffers
    const socks = Array.from({ length: 10 }, () => rawUpload(39239, owner, path, 40 * 1024 * 1024))
    for (const s of socks) s.sock.write(Buffer.alloc(1024, 1))
    await waitFor(() => ts.lig.limiters.uploadGate.stats.active === 10, 5_000, 'all uploads reading')
    await sleep(100)
    // The old code allocated 10 × 40 MB here.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(100 * 1024 * 1024)
    for (const s of socks) s.sock.destroy()
    await waitFor(() => ts.lig.limiters.uploadGate.stats.active === 0, 5_000, 'slots released')
    await sleep(100)
    expect(errors.mock.calls.filter(c => String(c[0]).includes('unhandled'))).toEqual([])
    expect(blobFiles(ts.lig.blobs.dir, ts.lig.db)).toBe(0)
  })

  it('uploads beyond the per-user concurrency wait for a slot instead of being buffered', async () => {
    const { ts } = await instance(39240, { rateLimits: { uploadConcurrencyPerUser: 1 } })
    const owner = await signup(ts.base, 'owner')
    const p = await newProject(owner)
    const slow = rawUpload(39240, owner, `/api/projects/${p.id}/upload?parentId=${p.rootId}&name=slow.bin`, 2000)
    slow.sock.write(Buffer.alloc(1000, 1))
    await waitFor(() => ts.lig.limiters.uploadGate.stats.active === 1, 5_000, 'slow upload reading')
    const fast = owner.upload(p.id, p.rootId, 'fast.bin', new Uint8Array(10).fill(2))
    await waitFor(() => ts.lig.limiters.uploadGate.stats.waiting === 1, 5_000, 'fast upload queued')
    slow.sock.write(Buffer.alloc(1000, 1))
    await waitFor(() => slow.response().startsWith('HTTP/1.1 200'), 5_000, 'slow upload done')
    expect((await fast).status).toBe(200)
    expect(ts.lig.limiters.uploadGate.stats).toEqual({ active: 0, waiting: 0 })
  })

  it('UploadGate: per-user and total limits, FIFO hand-over', async () => {
    const g = new UploadGate(2, 1)
    const r1 = await g.acquire('u1')
    let second: (() => void) | null = null
    void g.acquire('u1').then(r => { second = r })
    const r2 = await g.acquire('u2') // u1's waiter does not block another user
    let third: (() => void) | null = null
    void g.acquire('u3').then(r => { third = r })
    await sleep(0)
    expect(g.stats).toEqual({ active: 2, waiting: 2 })
    r1(); r1() // idempotent
    await sleep(0)
    expect(second).not.toBeNull()
    expect(third).toBeNull()
    r2()
    await sleep(0)
    expect(third).not.toBeNull()
    expect(g.stats).toEqual({ active: 2, waiting: 0 })
  })

  it('binary downloads are streamed with the right length and bytes', async () => {
    const { ts } = await instance(39241)
    const owner = await signup(ts.base, 'owner')
    const p = await newProject(owner)
    const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => i * 31)
    const up = await owner.upload(p.id, p.rootId, 'data.bin', data)
    const r = await fetch(`${ts.base}/api/projects/${p.id}/files/${up.body.id}/raw`, { headers: { cookie: owner.cookie } })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-length')).toBe(String(data.byteLength))
    expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(data))).toBe(true)
  })
})

describe('WebSocket limits (review: sec 5)', () => {
  const url = (port: number) => `ws://127.0.0.1:${port}/collab`
  /** Resolves with the HTTP status of a refused upgrade, or 101 once open. */
  function upgrade(port: number, cookie: string | null): Promise<{ status: number; ws: WebSocket }> {
    const ws = new WebSocket(url(port), { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } })
    cleanups.push(() => ws.terminate())
    return new Promise(resolve => {
      ws.on('open', () => resolve({ status: 101, ws }))
      ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0, ws }))
      ws.on('error', () => { /* reported via unexpected-response */ })
    })
  }
  const closed = (ws: WebSocket) => new Promise<number>(resolve => ws.on('close', code => resolve(code)))

  it('sockets without a session: small frames, small byte budget, capped count', async () => {
    const { ts, admin } = await instance(39242, { wsLimits: { anonMaxPayload: 4096, anonMaxBytes: 2000, maxAnonSockets: 2 } })
    const a = await upgrade(39242, null)
    expect(a.status).toBe(101)
    const aClosed = closed(a.ws)
    a.ws.send(Buffer.alloc(3000, 0)) // under the frame limit, over the lifetime budget: terminated unread
    expect(await aClosed).toBe(1006)

    const b = await upgrade(39242, null)
    const bClosed = closed(b.ws)
    b.ws.send(Buffer.alloc(5000, 0)) // over the frame limit
    expect(await bClosed).toBe(1009)

    const c1 = await upgrade(39242, 'ligature_session=bogus')
    const c2 = await upgrade(39242, null)
    expect([c1.status, c2.status]).toEqual([101, 101])
    expect((await upgrade(39242, null)).status).toBe(503)
    // a logged-in user is not affected by the anonymous cap
    expect((await upgrade(39242, admin.cookie)).status).toBe(101)
    c1.ws.terminate()
    await sleep(200)
    expect((await upgrade(39242, null)).status).toBe(101)
    expect(ts.lig.server.listening).toBe(true)
  })

  it('sockets per user are capped', async () => {
    const { admin } = await instance(39243, { wsLimits: { maxSocketsPerUser: 2 } })
    const s1 = await upgrade(39243, admin.cookie)
    const s2 = await upgrade(39243, admin.cookie)
    expect([s1.status, s2.status]).toEqual([101, 101])
    expect((await upgrade(39243, admin.cookie)).status).toBe(429)
    s1.ws.close()
    await closed(s1.ws)
    await sleep(100)
    expect((await upgrade(39243, admin.cookie)).status).toBe(101)
  })

  it('an unauthenticated provider still gets the unauthenticated denial', async () => {
    const { ts } = await instance(39244)
    const owner = await signup(ts.base, 'owner')
    const p = await newProject(owner)
    const main = p.tree.find(f => f.name === 'main.tex')!
    const anon = open(ts.base, new Client(ts.base), fileDocName(p.id, main.id, main.epoch!))
    await waitFor(() => anon.denied() !== null, 5_000, 'denied')
    expect(anon.denied()).toBe('unauthenticated')
  })
})

async function editorSetup(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const { ts } = await instance(port, opts)
  const owner = await signup(ts.base, 'owner')
  const bob = await signup(ts.base, 'bob')
  const p: ProjectDetail = await newProject(owner)
  await addMember(owner, bob, p.id, 'editor')
  const main = p.tree.find(f => f.name === 'main.tex')!
  return { ts, owner, bob, p, main, docName: fileDocName(p.id, main.id, main.epoch!) }
}

describe('sessions ending close their sockets (review: sec 6 / correctness 2)', () => {
  it('logout closes only that session\'s connections, immediately', async () => {
    const { ts, owner, bob, docName } = await editorSetup(39245)
    const bob2 = await login(ts.base, 'bob')
    const o = open(ts.base, owner, docName)
    const b1 = open(ts.base, bob, docName)
    const b2 = open(ts.base, bob2, docName)
    await waitFor(() => [o, b1, b2].every(c => c.provider.isSynced), 10_000, 'sync')
    expect((await bob.post('/api/auth/logout')).status).toBe(200)
    await waitFor(() => b1.closes.includes('session-ended'), 2_000, 'b1 closed')
    b1.text().insert(0, 'AFTER LOGOUT ')
    b2.text().insert(0, 'still here ')
    await waitFor(() => o.text().toString().startsWith('still here'), 5_000, 'b2 edit')
    await sleep(200)
    expect(o.text().toString()).not.toContain('AFTER LOGOUT')
    expect(b2.closes).toEqual([])
    expect(o.closes).toEqual([])
    void ts
  })

  it('expired (or otherwise invalid) sessions are closed by the periodic check', async () => {
    const { ts, owner, bob, docName } = await editorSetup(39246, { sessionCheckMs: 150 })
    const o = open(ts.base, owner, docName)
    const b = open(ts.base, bob, docName)
    await waitFor(() => [o, b].every(c => c.provider.isSynced), 10_000, 'sync')
    const token = decodeURIComponent(bob.cookie.split('=')[1]!)
    ts.lig.db.prepare('UPDATE sessions SET expires_at = 1 WHERE token_hash = ?').run(sha256(token))
    await waitFor(() => b.closes.includes('session-ended'), 3_000, 'expired session closed')
    expect(o.closes).toEqual([])
    expect(ts.lig.collab.checkSessions()).toBe(0)
  })
})

describe('awareness: a connection only controls its own client (review: sec 7)', () => {
  it('a viewer cannot overwrite or remove another client\'s presence', async () => {
    const { ts, owner, bob, p, docName } = await editorSetup(39247)
    const eve = await signup(ts.base, 'eve')
    await addMember(owner, eve, p.id, 'viewer')
    const o = open(ts.base, owner, docName)
    const b = open(ts.base, bob, docName)
    const e = open(ts.base, eve, docName)
    await waitFor(() => [o, b, e].every(c => c.provider.isSynced), 10_000, 'sync')
    b.provider.awareness!.setLocalStateField('cursor', { pos: 1 })
    e.provider.awareness!.setLocalStateField('cursor', { pos: 2 })
    const bobCid = b.doc.clientID
    const eveCid = e.doc.clientID
    await waitFor(() => o.provider.awareness!.getStates().get(bobCid)?.['cursor']?.pos === 1, 5_000, 'bob at owner')
    await waitFor(() => e.provider.awareness!.getStates().has(bobCid), 5_000, 'bob at eve')
    await waitFor(() => o.provider.awareness!.getStates().has(eveCid), 5_000, 'eve at owner')

    const ea = e.provider.awareness!
    const forge = (state: Record<string, unknown> | null, sentinel: string) => {
      const meta = ea.meta.get(bobCid)!
      if (state) ea.states.set(bobCid, state)
      else ea.states.delete(bobCid)
      ea.meta.set(bobCid, { clock: meta.clock + 100, lastUpdated: Date.now() })
      ea.emit('update', [{ added: [], updated: state ? [bobCid] : [], removed: state ? [] : [bobCid] }, 'forge'])
      ea.setLocalStateField('sentinel', sentinel) // same socket, so processed after the forged update
    }
    const bobSeenByOwner = () => o.provider.awareness!.getStates().get(bobCid)

    forge({ cursor: { pos: 999 }, note: 'forged by eve' }, 's1')
    await waitFor(() => o.provider.awareness!.getStates().get(eveCid)?.['sentinel'] === 's1', 5_000, 'sentinel 1')
    expect(bobSeenByOwner()?.['note']).toBeUndefined()
    expect(bobSeenByOwner()?.['cursor']).toEqual({ pos: 1 })

    forge(null, 's2')
    await waitFor(() => o.provider.awareness!.getStates().get(eveCid)?.['sentinel'] === 's2', 5_000, 'sentinel 2')
    expect(bobSeenByOwner()?.['cursor']).toEqual({ pos: 1 })
    // eve's own presence still works and is stamped with her identity
    const eveMe = await me(eve)
    expect(o.provider.awareness!.getStates().get(eveCid)?.['user']).toMatchObject({ id: eveMe.id })
  })
})

describe('smaller fixes', () => {
  it('compile errors do not leak internal addresses', async () => {
    const { ts } = await instance(39248, { compilerUrl: 'http://127.0.0.1:1' })
    const owner = await signup(ts.base, 'owner')
    const p = await newProject(owner)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await owner.post(`/api/projects/${p.id}/compile`)
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('compiler-unavailable')
    expect(JSON.stringify(r.body)).not.toContain('127.0.0.1')
  })

  it('a text upload racing a delete of the same file reports 404, not success', async () => {
    const { ts, owner, p, main } = await editorSetup(39249)
    const user = { ...(await me(owner)), displayName: 'owner' }
    const a = requireAccess(ts.lig.db, p.id, user.id)
    const upload = uploadFile(ts.lig, user, a, p.rootId, 'main.tex', Buffer.from('new text\n'))
    const del = deleteNode(ts.lig, user, a, main.id) // its transaction commits before the upload's diff is applied
    await del
    await expect(upload).rejects.toMatchObject({ status: 404, code: 'not-found' })
  })

  it('dev login and seeding fail closed for an unknown NODE_ENV (e.g. staging)', async () => {
    const s = await startServer(tempDataDir(), 39250, { NODE_ENV: 'staging' })
    try {
      expect((await (await fetch(`${s.base}/api/instance`)).json())).toMatchObject({ devLogin: false, hasUsers: false })
      const r = await fetch(`${s.base}/api/dev/login`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice' }) })
      expect(r.status).toBe(404)
    } finally { await killHard(s) }
  }, 30_000)
})
