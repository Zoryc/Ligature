import { Hono } from 'hono'
import { z } from 'zod'
import type { RestoreResponse, TrashEntry } from '@ligature/shared'
import { emptyTrash, listTrash, purgeFromTrash, restoreFromTrash } from '../../files/trash.ts'
import { requireAccess } from '../../projects/service.ts'
import { readJson, type Env, type RouteDeps } from '../context.ts'

const restoreSchema = z.strictObject({ parentId: z.string().max(64).optional() })

/** Trash can routes (docs/M2.md §1). */
export function trashRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  app.get('/projects/:id/trash', c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    return c.json(listTrash(deps, a) satisfies TrashEntry[])
  })

  app.post('/projects/:id/trash/:fileId/restore', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    // An empty body means "restore to the default place".
    const body = (await c.req.text()).trim() === '' ? {} : await readJson(c, restoreSchema)
    return c.json(restoreFromTrash(deps, c.get('user'), a, c.req.param('fileId'), body) satisfies RestoreResponse)
  })

  app.delete('/projects/:id/trash/:fileId', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    await purgeFromTrash(deps, c.get('user'), a, c.req.param('fileId'))
    return c.json({ ok: true })
  })

  app.delete('/projects/:id/trash', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    await emptyTrash(deps, c.get('user'), a)
    return c.json({ ok: true })
  })

  return app
}
