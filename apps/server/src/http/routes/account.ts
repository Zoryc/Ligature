import { Hono } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AccountDeletionPreview, AccountDeletionResult } from '@ligature/shared'
import { ApiError } from '../../errors.ts'
import { deleteAccount, deletionPreview } from '../../auth/deleteAccount.ts'
import { verifyPassword } from '../../auth/password.ts'
import { SESSION_COOKIE } from '../../auth/sessions.ts'
import { getUserById } from '../../auth/users.ts'
import { passwordFieldSchema } from '../../auth/validation.ts'
import { clientIp, readJson, requireUser, type Env, type RouteDeps } from '../context.ts'

/* Deleting your own account (docs/ACCOUNT-DELETION.md). The admin side is in admin.ts. */

const deleteMeSchema = z.strictObject({ password: passwordFieldSchema })

export function accountRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()
  const authed = requireUser(deps)

  app.get('/me/deletion', authed, c =>
    c.json(deletionPreview(db, c.get('user').id, 'self') satisfies AccountDeletionPreview, 200, { 'cache-control': 'no-store' }))

  app.delete('/me', authed, async c => {
    const { password } = await readJson(c, deleteMeSchema)
    const me = c.get('user')
    const userKey = `${clientIp(c, deps.trustProxy)}\n${me.username}`
    // The login limiter, counted before the (slow) verify and given back when the password is right (see login).
    if (!deps.limiters.loginUser.consume(userKey)) throw new ApiError(429, 'rate-limited', 'Too many attempts; try again later')
    const hash = getUserById(db, me.id)?.passwordHash ?? null
    if (!(await verifyPassword(hash, password))) throw new ApiError(403, 'wrong-password', 'Wrong password')
    deps.limiters.loginUser.refund(userKey)
    const result = await deleteAccount(deps, { userId: me.id, by: 'self', actorId: me.id, verifiedHash: hash })
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json(result satisfies AccountDeletionResult)
  })

  return app
}
