import { request } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, me, newProject, openInstance, signup, type TestServer } from './inproc.ts'

function rawGet(base: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: 'GET' }, res => {
      let body = ''
      res.on('data', d => { body += d }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject); req.end()
  })
}

describe('static SPA serving', () => {
  let ts: TestServer
  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), 'ligature-dist-'))
    mkdirSync(join(dist, 'assets'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Ligature</title><script type="module" src="/assets/app-3f9a1c.js"></script>')
    writeFileSync(join(dist, 'assets', 'app-3f9a1c.js'), 'console.log(1)')
    writeFileSync(join(dist, 'assets', 'style-77aa.css'), 'body{}')
    writeFileSync(join(dist, 'pdf.worker.min.mjs'), 'export {}')
    writeFileSync(join(dist, 'favicon.svg'), '<svg/>')
    writeFileSync(join(tmpdir(), 'ligature-secret.txt'), 'SECRET')
    ;({ ts } = await openInstance(39190, { webDistDir: dist }))
  })
  afterAll(async () => { await ts.stop() })

  it('index.html: no-cache + strict CSP; SPA fallback for client routes', async () => {
    for (const path of ['/', '/index.html', '/projects/3f0e8a52-1c1b-4c3e-9d4a-0b9a0d6c1e2f', '/invite/abc']) {
      const r = await fetch(`${ts.base}${path}`)
      expect(r.status, path).toBe(200)
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(r.headers.get('cache-control')).toBe('no-cache')
      const csp = r.headers.get('content-security-policy')!
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
      expect(await r.text()).toContain('<title>Ligature</title>')
    }
    const head = await fetch(`${ts.base}/`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('hashed assets are immutable; .mjs is text/javascript; missing assets are 404', async () => {
    const js = await fetch(`${ts.base}/assets/app-3f9a1c.js`)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(js.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await fetch(`${ts.base}/assets/style-77aa.css`)).headers.get('content-type')).toBe('text/css; charset=utf-8')
    const mjs = await fetch(`${ts.base}/pdf.worker.min.mjs`)
    expect(mjs.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(mjs.headers.get('cache-control')).toBe('no-cache')
    expect((await fetch(`${ts.base}/assets/nope-123.js`)).status).toBe(404)
  })

  it('never escapes the dist dir; /api and non-GET are not the SPA', async () => {
    for (const p of ['/..%2fligature-secret.txt', '/%2e%2e/ligature-secret.txt', '/assets/..%2f..%2fligature-secret.txt', '/..\\ligature-secret.txt']) {
      const r = await rawGet(ts.base, p)
      expect(r.body, p).not.toContain('SECRET')
    }
    const api = await fetch(`${ts.base}/api/does-not-exist`)
    expect(api.status).toBe(404)
    expect(await api.json()).toEqual({ error: 'not-found' })
    expect((await fetch(`${ts.base}/`, { method: 'POST' })).status).toBe(404)
  })
})

describe('Origin check on every mutating route', () => {
  let ts: TestServer
  let owner: Client
  beforeAll(async () => { ({ ts } = await openInstance(39191)); owner = await signup(ts.base, 'owner') })
  afterAll(async () => { await ts.stop() })

  it('POST/PATCH/DELETE without an allowed Origin are 403 bad-origin (and change nothing)', async () => {
    const p = await newProject(owner)
    const uid = (await me(owner)).id
    const id = p.id
    const f = p.mainFileId!
    const routes: [string, string, unknown?][] = [
      ['POST', '/api/auth/signup', { username: 'evil', displayName: 'E', password: 'xxxxxxxxxxxx' }],
      ['POST', '/api/auth/login', { username: 'owner', password: 'correct horse battery' }],
      ['POST', '/api/auth/logout'], ['POST', '/api/logout'],
      ['PATCH', '/api/me', { displayName: 'Pwned' }],
      ['POST', '/api/me/password', { currentPassword: 'correct horse battery', newPassword: 'pwned pwned pwned' }],
      ['POST', '/api/admin/users', { username: 'evil2', displayName: 'E', password: 'xxxxxxxxxxxx' }],
      ['PATCH', `/api/admin/users/${uid}`, { displayName: 'x' }],
      ['PATCH', '/api/admin/settings', { registration: 'closed' }],
      ['POST', '/api/projects', { name: 'evil' }],
      ['PATCH', `/api/projects/${id}`, { name: 'evil' }],
      ['DELETE', `/api/projects/${id}`],
      ['POST', `/api/projects/${id}/compile`],
      ['PATCH', `/api/projects/${id}/members/${uid}`, { role: 'viewer' }],
      ['DELETE', `/api/projects/${id}/members/${uid}`],
      ['POST', `/api/projects/${id}/transfer`, { userId: uid }],
      ['POST', `/api/projects/${id}/invites`, { role: 'editor' }],
      ['DELETE', `/api/projects/${id}/invites/${uid}`],
      ['POST', `/api/invites/${'a'.repeat(43)}/accept`],
      ['POST', `/api/projects/${id}/files`, { parentId: p.rootId, name: 'evil.tex', kind: 'text' }],
      ['PATCH', `/api/projects/${id}/files/${f}`, { name: 'evil.tex' }],
      ['DELETE', `/api/projects/${id}/files/${f}`],
      ['POST', `/api/projects/${id}/upload?parentId=${p.rootId}&name=evil.bin`, 'raw'],
      ['POST', '/api/dev/login', { username: 'owner' }],
    ]
    for (const [method, path, body] of routes) {
      for (const origin of [null, 'https://evil.example', 'null', 'http://localhost:5173.evil.com']) {
        const r = body === 'raw'
          ? await owner.req(method, path, undefined, { origin, raw: new Uint8Array([1, 2, 3]) })
          : await owner.req(method, path, body, { origin })
        expect(r.status, `${method} ${path} origin=${origin}`).toBe(403)
        expect(r.body.error).toBe('bad-origin')
      }
    }
    // nothing changed
    const after = (await owner.get(`/api/projects/${id}`)).body
    expect(after.name).toBe(p.name)
    expect(after.tree).toHaveLength(p.tree.length)
    expect((await owner.get('/api/me')).body.displayName).toBe('owner')
    // GET needs no Origin
    expect((await owner.req('GET', '/api/me', undefined, { origin: null })).status).toBe(200)
  })

  it('WebSocket upgrade from a foreign Origin is refused', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${ts.base}/collab`, {
        headers: { connection: 'Upgrade', upgrade: 'websocket', origin: 'https://evil.example',
          'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      })
      req.on('response', res => resolve(res.statusCode ?? 0))
      req.on('upgrade', () => resolve(101))
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })

  it('JSON bodies over 2 MB are 413', async () => {
    const r = await owner.post('/api/projects', { name: 'x'.repeat(3 * 1024 * 1024) })
    expect(r.status).toBe(413)
  })
})
