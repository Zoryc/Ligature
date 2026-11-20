import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkSetupToken, createSetupToken, setupLogLine } from '../src/auth/setup.ts'
import { CompilerUnreachableError, unreachableLogger } from '../src/compile/compilerClient.ts'
import { killHard, ORIGIN, startServer, tempDataDir } from './harness.ts'
import { Client, newProject, openInstance, PASSWORD, startTestServer, type TestServer } from './inproc.ts'

// Ports: 39660–39679 only (deployment findings: first admin, configuration checks, compile outages).

const servers: TestServer[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const s of servers.splice(0)) await s.stop()
})
async function server(port: number, opts: Parameters<typeof startTestServer>[1] = {}) {
  const s = await startTestServer(port, opts); servers.push(s); return s
}

const signupBody = (username: string, extra: object = {}) => ({ username, displayName: username, password: PASSWORD, ...extra })

describe('first-admin setup token', () => {
  it('createSetupToken: 32 random bytes, base64url; checkSetupToken: missing and wrong get different messages', () => {
    const t = createSetupToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createSetupToken()).not.toBe(t)
    expect(() => checkSetupToken(t, t)).not.toThrow()
    const err = (given: string | undefined) => { try { checkSetupToken(t, given); return null } catch (e) { return e as { status: number; code: string; message: string } } }
    const missing = err(undefined)!
    const wrong = err(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'))!
    expect(missing).toMatchObject({ status: 403, code: 'setup-token-required' })
    expect(wrong).toMatchObject({ status: 403, code: 'setup-token-required' })
    expect(err('')!.message).toBe(missing.message)
    expect(wrong.message).not.toBe(missing.message)
    expect(err('short')!.code).toBe('setup-token-required') // other lengths are compared safely too
  })

  it('production, no accounts: the first signup needs the token; afterwards it is not asked for', async () => {
    const s = await server(39660, { production: true, devLogin: false })
    const token = s.lig.setupToken!
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const anon = new Client(s.base)
    expect((await anon.get('/api/instance')).body).toEqual({ registration: 'invite-only', hasUsers: false, devLogin: false, setupRequired: true })

    const none = await anon.post('/api/auth/signup', signupBody('mallory'))
    expect(none.status).toBe(403)
    expect(none.body.error).toBe('setup-token-required')
    const wrong = await anon.post('/api/auth/signup', signupBody('mallory', { setupToken: 'x'.repeat(43) }))
    expect(wrong.status).toBe(403)
    expect(wrong.body.error).toBe('setup-token-required')
    expect(wrong.body.message).not.toBe(none.body.message)
    expect(s.lig.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })

    const root = new Client(s.base)
    const ok = await root.post('/api/auth/signup', signupBody('root', { setupToken: token }))
    expect(ok.status).toBe(200)
    expect(ok.body.isAdmin).toBe(true)
    expect((await anon.get('/api/instance')).body).toMatchObject({ hasUsers: true, setupRequired: false })

    // The token does not matter any more: the normal registration rules apply.
    const second = await anon.post('/api/auth/signup', signupBody('bob', { setupToken: token }))
    expect(second.body.error).toBe('invite-required')
    await root.patch('/api/admin/settings', { registration: 'open' })
    expect((await anon.post('/api/auth/signup', signupBody('bob'))).status).toBe(200)
  })

  it('production restarted with accounts: no token; development: never a token', async () => {
    const first = await startTestServer(39661, { production: true, devLogin: false })
    await new Client(first.base).post('/api/auth/signup', signupBody('root', { setupToken: first.lig.setupToken }))
    await first.stop()
    const again = await server(39661, { production: true, devLogin: false, dataDir: first.dataDir })
    expect(again.lig.setupToken).toBeNull()
    expect((await new Client(again.base).get('/api/instance')).body.setupRequired).toBe(false)

    const dev = await server(39662)
    expect(dev.lig.setupToken).toBeNull()
    expect((await new Client(dev.base).get('/api/instance')).body).toMatchObject({ hasUsers: false, setupRequired: false })
    expect((await new Client(dev.base).post('/api/auth/signup', signupBody('root'))).body.isAdmin).toBe(true)
  })

  it('a token makes no difference when another first signup won the race', async () => {
    const s = await server(39663, { production: true, devLogin: false })
    const token = s.lig.setupToken!
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      new Client(s.base).post('/api/auth/signup', signupBody(`racer${i}`, { setupToken: token }))))
    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    expect(s.lig.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get()).toEqual({ n: 1 })
  })

  it('setupLogLine: one line with the signup link and the CLI alternative', () => {
    const line = setupLogLine('https://latex.example.org', 'TOKEN')
    expect(line).toBe('[ligature] No accounts yet. Create the first (admin) account at https://latex.example.org/#/signup?setup=TOKEN' +
      '  (or run: ligature create-admin <name>)')
    expect(line).not.toContain('\n')
  })

  it('main.ts (production) logs the setup link once, and the link works', async () => {
    const s = await startServer(tempDataDir(), 39664, {
      NODE_ENV: 'production', HOST: '127.0.0.1', ALLOWED_ORIGINS: ORIGIN, COMPILER_URL: 'unix:/nonexistent/compiler.sock',
    })
    try {
      const lines = s.output().split(/\r?\n/).filter(l => l.includes('No accounts yet'))
      expect(lines).toHaveLength(1)
      const token = new RegExp(`at ${ORIGIN}/#/signup\\?setup=([A-Za-z0-9_-]{43})  \\(or run: ligature create-admin <name>\\)$`).exec(lines[0]!)?.[1]
      expect(token).toBeDefined()
      const c = new Client(s.base)
      expect((await c.post('/api/auth/signup', signupBody('root'))).body.error).toBe('setup-token-required')
      expect((await c.post('/api/auth/signup', signupBody('root', { setupToken: token }))).body.isAdmin).toBe(true)
    } finally { await killHard(s) }
  }, 30_000)
})

describe('ALLOWED_ORIGINS at startup', () => {
  it('main.ts exits 1 naming the bad entry and its corrected form', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production', PORT: '39665', HOST: '127.0.0.1', DATA_DIR: tempDataDir(),
        ALLOWED_ORIGINS: 'https://ok.example.org, https://Latex.Example.org/', COMPILER_URL: 'unix:/nonexistent/compiler.sock' },
      encoding: 'utf8', timeout: 20_000,
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ALLOWED_ORIGINS entry "https://Latex.Example.org/" is not an origin')
    expect(r.stderr).toContain('use "https://latex.example.org"')
    expect(r.stderr).not.toMatch(/\n\s+at /) // a message, not a stack trace
  }, 30_000)
})

describe('compiler outage', () => {
  it('unreachable compiles are refunded (no 429 afterwards) and logged as one line', async () => {
    // The default test compiler URL (127.0.0.1:1) refuses connections.
    const { ts, admin } = await openInstance(39666, { rateLimits: { compilePerUser: 2 } }); servers.push(ts)
    const errors: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    const p = await newProject(admin)
    for (let i = 0; i < 5; i++) {
      const r = await admin.post(`/api/projects/${p.id}/compile`)
      expect(r.status).toBe(503)
      expect(r.body.error).toBe('compiler-unavailable')
    }
    const compileLines = errors.filter(a => String(a[0]).includes('compile'))
    expect(compileLines).toHaveLength(1)
    expect(compileLines[0]).toEqual(['[compile] compiler unreachable (ECONNREFUSED 127.0.0.1:1): compile refused'])

    // The compiler is back: the budget is intact.
    const c = ts.lig.compiler
    c.sync = async () => ({ missing: [] })
    c.compile = async () => ({ status: 'success', durationMs: 1, outputs: ['output.log'], log: 'ok\n' })
    c.output = async () => null
    expect((await admin.post(`/api/projects/${p.id}/compile`)).status).toBe(200)
    expect((await admin.post(`/api/projects/${p.id}/compile`)).status).toBe(200)
    expect((await admin.post(`/api/projects/${p.id}/compile`)).status).toBe(429)
  })

  it('other compile errors still count and keep their full error in the log', async () => {
    const { ts, admin } = await openInstance(39667, { rateLimits: { compilePerUser: 2 } }); servers.push(ts)
    const errors: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    ts.lig.compiler.sync = async () => { throw new Error('compiler POST /sync: 500 boom') }
    const p = await newProject(admin)
    expect((await admin.post(`/api/projects/${p.id}/compile`)).status).toBe(503)
    expect((await admin.post(`/api/projects/${p.id}/compile`)).status).toBe(503)
    expect((await admin.post(`/api/projects/${p.id}/compile`)).status).toBe(429)
    expect(errors.filter(a => a[0] === 'compile failed' && a[1] instanceof Error)).toHaveLength(2)
  })

  it('a missing unix socket is an unreachable error with its code', async () => {
    const { CompilerClient } = await import('../src/compile/compilerClient.ts')
    const path = process.platform === 'win32' ? '\\\\.\\pipe\\ligature-test-missing-39668' : '/nonexistent/ligature/compiler.sock'
    const c = new CompilerClient(`unix:${path}`)
    const e = await c.sync('p', {}).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CompilerUnreachableError)
    expect(e).toMatchObject({ code: 'ENOENT', address: path })
  })

  it('unreachableLogger: at most one line per interval, with the number left out', () => {
    let t = 0
    const lines: string[] = []
    const log = unreachableLogger(60_000, () => t, l => lines.push(l))
    const e = new CompilerUnreachableError('ENOENT', '/run/ligature/compiler.sock')
    log(e)
    t = 1_000; log(e)
    t = 59_999; log(e)
    expect(lines).toEqual(['[compile] compiler unreachable (ENOENT /run/ligature/compiler.sock): compile refused'])
    t = 61_000; log(e)
    t = 62_000; log(e)
    t = 200_000; log(e)
    expect(lines.slice(1)).toEqual([
      '[compile] compiler unreachable (ENOENT /run/ligature/compiler.sock): compile refused (2 more since the last report)',
      '[compile] compiler unreachable (ENOENT /run/ligature/compiler.sock): compile refused (1 more since the last report)',
    ])
  })
})
