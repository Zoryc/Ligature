import { createHash, randomBytes } from 'node:crypto'
import type { DB } from '../db/index.ts'

export const SESSION_COOKIE = 'ligature_session'
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
/** Sliding expiry: `expires_at` is pushed forward at most once per this interval. */
export const SESSION_SLIDE_MS = 3600 * 1000

export interface SessionUser { id: string; username: string; displayName: string; isAdmin: boolean }
export interface Session { user: SessionUser; tokenHash: string; expiresAt: number; /** true if expiry was just extended */ renewed: boolean }

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function createSession(db: DB, userId: string): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, now, expiresAt, now)
  return { token, expiresAt }
}

export function deleteSession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

/** Delete every session of a user, except optionally the one with `exceptTokenHash`. Returns the count. */
export function deleteUserSessions(db: DB, userId: string, exceptTokenHash?: string): number {
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .run(userId, exceptTokenHash ?? '').changes
}

/**
 * Resolve a session token. Expired sessions and sessions of disabled users are invalid.
 * Sliding expiry: once per SESSION_SLIDE_MS of use, `expires_at` moves to now + TTL.
 */
export function sessionForToken(db: DB, token: string | undefined | null): Session | null {
  if (!token) return null
  const tokenHash = sha256(token)
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName, u.is_admin AS isAdmin, u.disabled_at AS disabledAt,
      s.expires_at AS expiresAt
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(tokenHash) as
    { id: string; username: string; displayName: string; isAdmin: number; disabledAt: number | null; expiresAt: number } | undefined
  const now = Date.now()
  if (!row || row.expiresAt <= now || row.disabledAt !== null) return null
  let expiresAt = row.expiresAt
  let renewed = false
  if (now + SESSION_TTL_MS - row.expiresAt >= SESSION_SLIDE_MS) {
    expiresAt = now + SESSION_TTL_MS
    renewed = true
    db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?').run(expiresAt, now, tokenHash)
  }
  return {
    user: { id: row.id, username: row.username, displayName: row.displayName, isAdmin: row.isAdmin === 1 },
    tokenHash, expiresAt, renewed,
  }
}

/** Of the given session hashes, those that are no longer valid (deleted, expired, or user disabled). Read-only. */
export function invalidSessionHashes(db: DB, hashes: Iterable<string>): Set<string> {
  const q = db.prepare(`SELECT s.expires_at AS expiresAt, u.disabled_at AS disabledAt
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
  const now = Date.now()
  const out = new Set<string>()
  for (const h of hashes) {
    const row = q.get(h) as { expiresAt: number; disabledAt: number | null } | undefined
    if (!row || row.expiresAt <= now || row.disabledAt !== null) out.add(h)
  }
  return out
}

export function userForToken(db: DB, token: string | undefined | null): SessionUser | null {
  return sessionForToken(db, token)?.user ?? null
}

/** Minimal RFC 6265 cookie-header parser (we only need one cookie). */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()) } catch { return null }
    }
  }
  return null
}
