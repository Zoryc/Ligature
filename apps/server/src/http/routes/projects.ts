import { createReadStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'
import { can, ENGINES, OUTPUT_NAMES, type ProjectDetail, type ProjectSummary } from '@ligature/shared'
import { ApiError, notFound } from '../../errors.ts'
import { listProjects, projectDetail } from '../../projects/repo.ts'
import { createProject, deleteProject, requireAccess, requireRole, updateProject } from '../../projects/service.ts'
import { isUuid } from '../../services.ts'
import { readJson, type Env, type RouteDeps } from '../context.ts'

const createSchema = z.strictObject({ name: z.string().max(1000) })
const updateSchema = z.strictObject({
  name: z.string().max(1000).optional(),
  engine: z.enum(ENGINES as [string, ...string[]]).optional(),
  mainFileId: z.string().max(64).optional(),
})

export function projectRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  app.get('/projects', c => c.json(listProjects(db, c.get('user').id) satisfies ProjectSummary[]))

  app.post('/projects', async c => {
    const { name } = await readJson(c, createSchema)
    return c.json(createProject(deps, c.get('user'), name) satisfies ProjectDetail)
  })

  app.get('/projects/:id', c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    const d = projectDetail(db, a.projectId, a.role)
    if (!d) throw notFound()
    return c.json(d satisfies ProjectDetail)
  })

  app.patch('/projects/:id', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    const body = await readJson(c, updateSchema)
    return c.json(updateProject(deps, a, body as Parameters<typeof updateProject>[2]) satisfies ProjectDetail)
  })

  app.delete('/projects/:id', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    await deleteProject(deps, c.get('user'), a)
    return c.json({ ok: true })
  })

  app.post('/projects/:id/compile', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    requireRole(a, can.compile)
    try {
      return c.json(await deps.compile.compile(a.projectId))
    } catch (e) {
      // Details (socket paths, internal addresses) go to the server log only.
      console.error('compile failed', e)
      throw new ApiError(503, 'compiler-unavailable', 'The compile service is unavailable; try again later')
    }
  })

  app.get('/projects/:id/builds/:buildId/:name', c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    const buildId = c.req.param('buildId')
    const name = c.req.param('name')
    if (!isUuid(buildId) || !(OUTPUT_NAMES as readonly string[]).includes(name)) throw notFound()
    const file = deps.compile.outputPath(a.projectId, buildId, name as (typeof OUTPUT_NAMES)[number])
    if (!existsSync(file)) throw notFound()
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

  return app
}
