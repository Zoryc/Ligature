import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ApiError } from '../errors.ts'
import { requireAdmin, requireUser, type Env, type RouteDeps } from './context.ts'
import { authRoutes } from './routes/auth.ts'
import { adminRoutes } from './routes/admin.ts'
import { projectRoutes } from './routes/projects.ts'
import { memberRoutes } from './routes/members.ts'
import { inviteRoutes } from './routes/invites.ts'
import { fileRoutes } from './routes/files.ts'
import { trashRoutes } from './routes/trash.ts'
import { zipRoutes } from './routes/zip.ts'
import { synctexRoutes } from './routes/synctex.ts'
import { serveSpa } from './static.ts'

export interface AppDeps extends RouteDeps {
  isAllowedOrigin: (origin: string | null | undefined) => boolean
  /** Built SPA directory (apps/web/dist); null = do not serve it (dev uses Vite). */
  webDistDir: string | null
}

/** JSON bodies are small; uploads (raw bodies) have their own limit. */
const JSON_BODY_LIMIT = 2 * 1024 * 1024

const UPLOAD_PATH = /^\/api\/projects\/[^/]+\/upload$/
/**
 * `POST /api/projects/:id/upload` and `POST /api/projects/import` (raw bodies with their own limits and
 * streaming readers) and nothing else (not e.g. `PATCH …/files/upload`).
 */
export const isUploadRoute = (method: string, path: string) =>
  method === 'POST' && (UPLOAD_PATH.test(path) || path === '/api/projects/import')

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>()

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(err.hasMessage ? { error: err.code, message: err.message } : { error: err.code }, err.status)
    }
    console.error('[http] unhandled error', err)
    return c.json({ error: 'internal' }, 500)
  })

  // CSRF: state-changing requests must come from an allowed Origin (SameSite=Lax cookie is the second layer).
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin')
      if (!deps.isAllowedOrigin(origin)) return c.json({ error: 'bad-origin' }, 403)
    }
    await next()
  })

  const jsonLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: c => c.json({ error: 'too-large' }, 413) })
  // Only the real upload route (raw body, own limit and streaming reader) is exempt.
  app.use('/api/*', async (c, next) => isUploadRoute(c.req.method, c.req.path) ? next() : jsonLimit(c, next))

  // Authentication for whole route groups (individual public/authed routes elsewhere set their own).
  const authed = requireUser(deps)
  app.use('/api/projects', authed)
  app.use('/api/projects/*', authed)
  app.use('/api/admin/*', authed, requireAdmin())

  app.get('/api/health', c => c.json({ ok: true }))

  app.route('/api', authRoutes(deps))
  app.route('/api', adminRoutes(deps))
  app.route('/api', projectRoutes(deps))
  app.route('/api', memberRoutes(deps))
  app.route('/api', inviteRoutes(deps))
  app.route('/api', fileRoutes(deps))
  app.route('/api', trashRoutes(deps))
  app.route('/api', zipRoutes(deps))
  app.route('/api', synctexRoutes(deps))

  app.all('/api/*', c => c.json({ error: 'not-found' }, 404))

  if (deps.webDistDir) app.use('*', serveSpa(deps.webDistDir))

  return app
}
