import type { Member, ProjectDetail, TreeEntry } from '@ligature/shared'
import { startLigature, type Ligature, type LigatureConfig } from '../src/server.ts'
import { originChecker } from '../src/http/origins.ts'
import { ORIGIN, tempDataDir } from './harness.ts'

/**
 * In-process server for API tests: same wiring as main.ts (HTTP + WebSocket on one port), but the
 * test can reach into its DB and collab state and use small limits. Ports: 39100–39299 only.
 */
export interface TestServer { lig: Ligature; base: string; dataDir: string; stop(): Promise<void> }

export async function startTestServer(port: number, opts: Partial<LigatureConfig> = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? tempDataDir()
  const lig = startLigature({
    dataDir, port, host: '127.0.0.1', compilerUrl: 'http://127.0.0.1:1',
    isAllowedOrigin: originChecker([ORIGIN], false),
    production: false, devLogin: true, seed: false, trustProxy: false, webDistDir: null,
    ...opts,
  })
  await lig.listening
  return { lig, base: `http://127.0.0.1:${port}`, dataDir, stop: () => lig.stop() }
}

export interface Res<T = any> { status: number; body: T & { error?: string; message?: string }; headers: Headers; raw: Response }

/** A cookie-jar HTTP client for one user. */
export class Client {
  cookie = ''
  constructor(readonly base: string, readonly name = 'client') {}

  async req<T = any>(method: string, path: string, body?: unknown,
    opts: { origin?: string | null; headers?: Record<string, string>; raw?: BodyInit } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { ...opts.headers }
    if (this.cookie) headers.cookie = this.cookie
    const origin = opts.origin === undefined ? ORIGIN : opts.origin
    if (origin !== null) headers.origin = origin
    let payload: BodyInit | undefined = opts.raw
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    const r = await fetch(`${this.base}${path}`, { method, headers, body: payload })
    const set = r.headers.get('set-cookie')
    if (set) {
      const first = set.split(';')[0]!
      this.cookie = first.endsWith('=') ? '' : first
    }
    const text = await r.clone().text()
    let parsed: unknown = text
    try { parsed = text ? JSON.parse(text) : null } catch { /* not JSON */ }
    return { status: r.status, body: parsed as Res<T>["body"], headers: r.headers, raw: r }
  }

  get = <T = any>(p: string) => this.req<T>('GET', p)
  post = <T = any>(p: string, b?: unknown) => this.req<T>('POST', p, b ?? {})
  patch = <T = any>(p: string, b: unknown) => this.req<T>('PATCH', p, b)
  del = <T = any>(p: string) => this.req<T>('DELETE', p)

  upload(projectId: string, parentId: string, name: string, data: Uint8Array | string): Promise<Res<TreeEntry>> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    return this.req('POST', `/api/projects/${projectId}/upload?parentId=${parentId}&name=${encodeURIComponent(name)}`, undefined,
      { raw: bytes as BodyInit, headers: { 'content-type': 'application/octet-stream' } })
  }
}

export const PASSWORD = 'correct horse battery'

/** Sign up a user (first one becomes admin). Throws unless 200. */
export async function signup(base: string, username: string, extra: { inviteToken?: string; displayName?: string } = {}): Promise<Client> {
  const c = new Client(base, username)
  const r = await c.post('/api/auth/signup', { username, displayName: extra.displayName ?? username, password: PASSWORD, ...(extra.inviteToken ? { inviteToken: extra.inviteToken } : {}) })
  if (r.status !== 200) throw new Error(`signup ${username}: ${r.status} ${JSON.stringify(r.body)}`)
  return c
}

/** Fresh server with an admin and registration open, so tests can create users freely. */
export async function openInstance(port: number, opts: Partial<LigatureConfig> = {}) {
  const ts = await startTestServer(port, opts)
  const admin = await signup(ts.base, 'admin')
  const s = await admin.patch('/api/admin/settings', { registration: 'open' })
  if (s.status !== 200) throw new Error('settings')
  return { ts, admin }
}

export async function newProject(c: Client, name = 'Paper'): Promise<ProjectDetail> {
  const r = await c.post<ProjectDetail>('/api/projects', { name })
  if (r.status !== 200) throw new Error(`create project: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}

export async function me(c: Client): Promise<{ id: string; username: string; isAdmin: boolean }> {
  return (await c.get('/api/me')).body
}

/** Owner invites, `user` accepts. */
export async function addMember(owner: Client, user: Client, projectId: string, role: 'editor' | 'viewer'): Promise<void> {
  const inv = await owner.post(`/api/projects/${projectId}/invites`, { role })
  if (inv.status !== 200) throw new Error(`invite ${inv.status}`)
  const acc = await user.post(`/api/invites/${inv.body.token}/accept`)
  if (acc.status !== 200) throw new Error(`accept ${acc.status} ${JSON.stringify(acc.body)}`)
}

export async function members(c: Client, projectId: string): Promise<Member[]> {
  return (await c.get(`/api/projects/${projectId}/members`)).body
}

export async function project(c: Client, projectId: string): Promise<ProjectDetail> {
  return (await c.get(`/api/projects/${projectId}`)).body
}
