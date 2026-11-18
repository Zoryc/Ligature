import { Hono } from 'hono'
import { z } from 'zod'
import type { Member } from '@ligature/shared'
import { listMembers } from '../../projects/repo.ts'
import { removeMember, transferOwnership, updateMemberRole } from '../../projects/members.ts'
import { requireAccess } from '../../projects/service.ts'
import { readJson, type Env, type RouteDeps } from '../context.ts'

const roleSchema = z.strictObject({ role: z.enum(['editor', 'viewer']) })
const transferSchema = z.strictObject({ userId: z.string().max(64) })

export function memberRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  app.get('/projects/:id/members', c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    return c.json(listMembers(db, a.projectId) satisfies Member[])
  })

  app.patch('/projects/:id/members/:userId', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    const { role } = await readJson(c, roleSchema)
    updateMemberRole(deps, c.get('user'), a, c.req.param('userId'), role)
    return c.json(listMembers(db, a.projectId) satisfies Member[])
  })

  app.delete('/projects/:id/members/:userId', c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    removeMember(deps, c.get('user'), a, c.req.param('userId'))
    return c.json({ ok: true })
  })

  app.post('/projects/:id/transfer', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    const { userId } = await readJson(c, transferSchema)
    transferOwnership(deps, c.get('user'), a, userId)
    return c.json(listMembers(db, a.projectId) satisfies Member[])
  })

  return app
}
