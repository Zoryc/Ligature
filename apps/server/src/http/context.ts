import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { z } from 'zod'
import { ApiError, badRequest } from '../errors.ts'
import { SESSION_COOKIE, sessionForToken, type Session, type SessionUser } from '../auth/sessions.ts'
import type { Services } from '../services.ts'
import type { Limiters } from './rateLimit.ts'
import type { CompileOrchestrator } from '../compile/orchestrator.ts'
import type { Maintenance } from '../maintenance/maintenance.ts'
import type { Rebuilder } from '../collab/rebuild.ts'

export type Env = { Variables: { user: SessionUser; session: Session } }

export interface RouteDeps extends Services {
  compile: CompileOrchestrator
  maintenance: Maintenance
  rebuilder: Rebuilder
  limiters: Limiters
  secureCookies: boolean
  trustProxy: boolean
  devLogin: boolean
}

/** Client address: the socket peer, or the first X-Forwarded-For hop when TRUST_PROXY=1. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for')
    const first = xff?.split(',')[0]?.trim()
    if (first) return first
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Parse a JSON body with a strict zod schema. Malformed JSON or schema failure → `400 bad-request`. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown
  try {
    raw = JSON.parse(await c.req.text())
  } catch {
    throw badRequest('Malformed JSON body')
  }
  const r = schema.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]
    throw badRequest(i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'Invalid request body')
  }
  return r.data
}

export function setSessionCookie(c: Context, token: string, expiresAt: number, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires: new Date(expiresAt) })
}

/** Require a valid session; refreshes the cookie when the sliding expiry moved. */
export function requireUser(deps: RouteDeps): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE)
    const session = sessionForToken(deps.db, token)
    if (!session || !token) return c.json({ error: 'unauthenticated' }, 401)
    if (session.renewed) setSessionCookie(c, token, session.expiresAt, deps.secureCookies)
    c.set('user', session.user)
    c.set('session', session)
    await next()
  }
}

export function requireAdmin(): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!c.get('user').isAdmin) throw new ApiError(403, 'forbidden')
    await next()
  }
}
