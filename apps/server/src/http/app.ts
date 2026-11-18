import { createReadStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { can } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import { createSession, deleteSession, SESSION_COOKIE, userForToken, type SessionUser } from '../auth/sessions.ts'
import { listProjects, projectDetail, roleOf } from '../projects/repo.ts'
import type { CompileOrchestrator } from '../compile/orchestrator.ts'

type Env = { Variables: { user: SessionUser } }

export interface AppDeps {
  db: DB
  compile: CompileOrchestrator
  isAllowedOrigin: (origin: string | null | undefined) => boolean
  devLogin: boolean
  secureCookies: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createApp(deps: AppDeps) {
  const { db } = deps
  const app = new Hono<Env>()

  // CSRF: state-changing requests must come from an allowed Origin (SameSite=Lax cookie is the second layer).
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin')
      if (!deps.isAllowedOrigin(origin)) return c.json({ error: 'bad-origin' }, 403)
    }
    await next()
  })

  app.get('/api/health', c => c.json({ ok: true }))

  if (deps.devLogin) {
    // DEV ONLY: log in as a seeded user without a password. Disabled in production (see main.ts).
    app.post('/api/dev/login', async c => {
      const body = z.object({ username: z.string().min(1).max(64) }).safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'bad-request' }, 400)
      const u = db.prepare('SELECT id FROM users WHERE username = ?').get(body.data.username) as { id: string } | undefined
      if (!u) return c.json({ error: 'no-such-user' }, 404)
      const s = createSession(db, u.id)
      setCookie(c, SESSION_COOKIE, s.token, {
        httpOnly: true, sameSite: 'Lax', secure: deps.secureCookies, path: '/', expires: new Date(s.expiresAt),
      })
      return c.json({ ok: true })
    })
  }

  // Everything below requires a session.
  const authed = new Hono<Env>()
  authed.use('*', async (c, next) => {
    const user = userForToken(db, getCookie(c, SESSION_COOKIE))
    if (!user) return c.json({ error: 'unauthenticated' }, 401)
    c.set('user', user)
    await next()
  })

  authed.post('/logout', c => {
    const t = getCookie(c, SESSION_COOKIE)
    if (t) deleteSession(db, t)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  authed.get('/me', c => c.json(c.get('user')))

  authed.get('/projects', c => c.json(listProjects(db, c.get('user').id)))

  const projectRole = (c: Context<Env>) => {
    const id = c.req.param('id')
    if (!id || !UUID.test(id)) return null
    const role = roleOf(db, id, c.get('user').id)
    return role ? { id, role } : null
  }

  authed.get('/projects/:id', c => {
    const p = projectRole(c)
    if (!p) return c.json({ error: 'not-found' }, 404)
    return c.json(projectDetail(db, p.id, p.role))
  })

  authed.post('/projects/:id/compile', async c => {
    const p = projectRole(c)
    if (!p) return c.json({ error: 'not-found' }, 404)
    if (!can.compile(p.role)) return c.json({ error: 'forbidden' }, 403)
    try {
      const r = await deps.compile.compile(p.id)
      return c.json(r)
    } catch (e) {
      console.error('compile failed', e)
      return c.json({ error: 'compiler-unavailable', message: String((e as Error).message ?? e) }, 503)
    }
  })

  authed.get('/projects/:id/builds/:buildId/:name', c => {
    const p = projectRole(c)
    if (!p) return c.json({ error: 'not-found' }, 404)
    const buildId = c.req.param('buildId')
    const name = c.req.param('name')
    if (!UUID.test(buildId) || (name !== 'output.pdf' && name !== 'output.log' && name !== 'output.synctex.gz')) {
      return c.json({ error: 'not-found' }, 404)
    }
    const file = deps.compile.outputPath(p.id, buildId, name)
    if (!existsSync(file)) return c.json({ error: 'not-found' }, 404)
    const type = name === 'output.pdf' ? 'application/pdf' : name === 'output.log' ? 'text/plain; charset=utf-8' : 'application/gzip'
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: {
        'content-type': type,
        'content-disposition': `inline; filename="${name}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=31536000, immutable',
      },
    })
  })

  app.route('/api', authed)
  return app
}
