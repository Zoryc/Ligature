import { createHash, randomBytes } from 'node:crypto'
import type { DB } from '../db/index.ts'

export const SESSION_COOKIE = 'ligature_session'
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

export interface SessionUser { id: string; username: string; displayName: string }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function createSession(db: DB, userId: string): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now, expiresAt)
  return { token, expiresAt }
}

export function deleteSession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

export function userForToken(db: DB, token: string | undefined | null): SessionUser | null {
  if (!token) return null
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName, s.expires_at AS expiresAt
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token)) as (SessionUser & { expiresAt: number }) | undefined
  if (!row || row.expiresAt < Date.now()) return null
  return { id: row.id, username: row.username, displayName: row.displayName }
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
