import { Hono } from 'hono'
import { z } from 'zod'
import type { AcceptInviteResponse, CreatedInvite, Invite, InvitePreview } from '@ligature/shared'
import { ApiError } from '../../errors.ts'
import { acceptInvite, createInvite, INVITE_MAX_HOURS, listInvites, previewInvite, revokeInvite } from '../../projects/invites.ts'
import { requireAccess } from '../../projects/service.ts'
import { clientIp, readJson, requireUser, type Env, type RouteDeps } from '../context.ts'

const createSchema = z.strictObject({
  role: z.enum(['editor', 'viewer']),
  expiresInHours: z.number().positive().max(INVITE_MAX_HOURS).optional(),
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
})

export function inviteRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  // Owner management (requireUser is applied to /projects/* in app.ts).
  app.post('/projects/:id/invites', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    const body = await readJson(c, createSchema)
    return c.json(createInvite(deps, c.get('user'), a, body) satisfies CreatedInvite)
  })

  app.get('/projects/:id/invites', c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    return c.json(listInvites(deps, a) satisfies Invite[])
  })

  app.delete('/projects/:id/invites/:inviteId', c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    revokeInvite(deps, c.get('user'), a, c.req.param('inviteId'))
    return c.json({ ok: true })
  })

  // Public preview (rate limited per IP), and accept (logged in).
  app.get('/invites/:token', c => {
    if (!deps.limiters.invitePreview.consume(clientIp(c, deps.trustProxy))) {
      throw new ApiError(429, 'rate-limited', 'Too many attempts; try again later')
    }
    return c.json(previewInvite(db, c.req.param('token')) satisfies InvitePreview)
  })

  app.post('/invites/:token/accept', requireUser(deps), c =>
    c.json(acceptInvite(deps, c.get('user'), c.req.param('token')) satisfies AcceptInviteResponse))

  return app
}
