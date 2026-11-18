import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { SynctexEditResponse, SynctexViewResponse } from '@ligature/shared'
import { ApiError, badRequest, notFound } from '../../errors.ts'
import { requireAccess } from '../../projects/service.ts'
import { isUuid } from '../../services.ts'
import type { Env, RouteDeps } from '../context.ts'

/** A decimal number as written in a query string (no exponent, no hex, no "Infinity"). */
const decimal = (max: number) => z.string().max(32).regex(/^-?\d+(\.\d+)?$/, 'expected a number')
  .transform(Number).pipe(z.number().min(-max).max(max))
const integer = (min: number, max: number) => z.string().max(16).regex(/^-?\d+$/, 'expected an integer')
  .transform(Number).pipe(z.number().int().min(min).max(max))

/** PDF pages are at most 14400 pt on a side; allow some slack for clicks just outside. */
const MAX_COORD = 1_000_000

const viewSchema = z.object({
  fileId: z.string().max(64).refine(isUuid, 'expected a file id'),
  line: integer(1, 10_000_000),
  column: integer(-1, 10_000_000).optional(),
})
const editSchema = z.object({
  page: integer(1, 1_000_000),
  x: decimal(MAX_COORD),
  y: decimal(MAX_COORD),
})

function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const r = schema.safeParse(c.req.query())
  if (!r.success) {
    const i = r.error.issues[0]
    throw badRequest(i ? `${i.path.join('.') || 'query'}: ${i.message}` : 'Invalid query')
  }
  return r.data
}

const NO_STORE = { 'cache-control': 'private, no-cache' }

/** SyncTeX routes (docs/M2.md §3): any member; build ids are scoped to the project in the URL. */
export function synctexRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  // A query that has to parse a build's synctex file (cache miss) counts against the user's parse budget.
  const admit = (userId: string) => () => {
    if (!deps.limiters.synctexParse.consume(userId)) throw new ApiError(429, 'rate-limited', 'Too many SyncTeX requests; try again later')
  }

  app.get('/projects/:id/builds/:buildId/synctex/view', async c => {
    const userId = c.get('user').id
    const a = requireAccess(db, c.req.param('id'), userId)
    const buildId = c.req.param('buildId')
    if (!isUuid(buildId)) throw notFound()
    const q = readQuery(c, viewSchema)
    const boxes = await deps.compile.synctex.view(a.projectId, buildId, {
      fileId: q.fileId, line: q.line, ...(q.column !== undefined ? { column: q.column } : {}),
    }, { admit: admit(userId) })
    return c.json({ boxes } satisfies SynctexViewResponse, 200, NO_STORE)
  })

  app.get('/projects/:id/builds/:buildId/synctex/edit', async c => {
    const userId = c.get('user').id
    const a = requireAccess(db, c.req.param('id'), userId)
    const buildId = c.req.param('buildId')
    if (!isUuid(buildId)) throw notFound()
    const q = readQuery(c, editSchema)
    const r = await deps.compile.synctex.edit(a.projectId, buildId, q, { admit: admit(userId) })
    if (!r) throw notFound('No project source at this point of the PDF')
    return c.json(r satisfies SynctexEditResponse, 200, NO_STORE)
  })

  return app
}
