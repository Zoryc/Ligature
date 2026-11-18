import { randomUUID } from 'node:crypto'
import type { AdminUser, Me } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import { ApiError, badRequest } from '../errors.ts'
import { hashPassword, isAcceptablePassword, PASSWORD_MAX, PASSWORD_MIN } from './password.ts'
import { deleteUserSessions } from './sessions.ts'
import { normalizeDisplayName, normalizeUsername } from './validation.ts'

export interface UserRow {
  id: string
  username: string
  displayName: string
  passwordHash: string | null
  isAdmin: boolean
  disabledAt: number | null
  createdAt: number
}

const COLS = `id, username, display_name AS displayName, password_hash AS passwordHash, is_admin AS isAdmin,
  disabled_at AS disabledAt, created_at AS createdAt`

type RawRow = Omit<UserRow, 'isAdmin'> & { isAdmin: number }
const fromRaw = (r: RawRow | undefined): UserRow | null => r ? { ...r, isAdmin: r.isAdmin === 1 } : null

export function getUserById(db: DB, id: string): UserRow | null {
  return fromRaw(db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id) as RawRow | undefined)
}

export function getUserByUsername(db: DB, username: string): UserRow | null {
  return fromRaw(db.prepare(`SELECT ${COLS} FROM users WHERE username = ?`).get(username.toLowerCase()) as RawRow | undefined)
}

export function listUsers(db: DB): UserRow[] {
  return (db.prepare(`SELECT ${COLS} FROM users ORDER BY created_at, username`).all() as RawRow[]).map(r => fromRaw(r)!)
}

export const toMe = (u: Pick<UserRow, 'id' | 'username' | 'displayName' | 'isAdmin'>): Me =>
  ({ id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin })

export const toAdminUser = (u: UserRow): AdminUser => ({
  id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin,
  disabled: u.disabledAt !== null, createdAt: u.createdAt,
})

export const weakPassword = () =>
  new ApiError(400, 'weak-password', `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`)

export interface NewUser { username: string; displayName: string; passwordHash: string | null; isAdmin: boolean }

/**
 * Insert a user row. Synchronous, so callers can run it inside a transaction together with
 * other checks (e.g. "is this the first account?"). Input must already be normalized.
 */
export function insertUser(db: DB, u: NewUser): UserRow {
  if (getUserByUsername(db, u.username)) throw new ApiError(409, 'username-taken')
  const id = randomUUID()
  const now = Date.now()
  try {
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, u.username, u.displayName, u.passwordHash, u.isAdmin ? 1 : 0, now)
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ApiError(409, 'username-taken')
    throw e
  }
  return { id, username: u.username, displayName: u.displayName, passwordHash: u.passwordHash, isAdmin: u.isAdmin, disabledAt: null, createdAt: now }
}

/** Validate raw input; throws `bad-request` / `weak-password`. */
export function validateNewUser(raw: { username: string; displayName: string; password: string }):
  { username: string; displayName: string; password: string } {
  const username = normalizeUsername(raw.username)
  if (!username) throw badRequest('Username: 3–32 characters, a–z 0–9 . _ -, starting with a letter or digit')
  const displayName = normalizeDisplayName(raw.displayName)
  if (!displayName) throw badRequest('Display name: 1–64 characters, no control characters')
  if (!isAcceptablePassword(raw.password)) throw weakPassword()
  return { username, displayName, password: raw.password }
}

/**
 * Create an account (admin route, CLI `create-admin`). Throws ApiError
 * `bad-request` | `weak-password` | `username-taken`.
 */
export async function createUser(db: DB, raw: { username: string; displayName: string; password: string; isAdmin?: boolean }): Promise<UserRow> {
  const v = validateNewUser(raw)
  const passwordHash = await hashPassword(v.password)
  return db.transaction(() => insertUser(db, { username: v.username, displayName: v.displayName, passwordHash, isAdmin: raw.isAdmin ?? false })).immediate()
}

/**
 * Set a user's password and delete their sessions (all, or all but `keepSessionHash`).
 * Returns the number of sessions deleted. Throws `weak-password` / `not-found`.
 * Closing live sockets is the caller's job (the CLI runs in another process; the server's
 * onAuthenticate re-checks the session on every reconnect).
 */
export async function setPassword(db: DB, userId: string, password: string, keepSessionHash?: string): Promise<number> {
  if (!isAcceptablePassword(password)) throw weakPassword()
  const passwordHash = await hashPassword(password)
  return db.transaction(() => {
    const r = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId)
    if (r.changes === 0) throw new ApiError(404, 'not-found')
    return deleteUserSessions(db, userId, keepSessionHash)
  }).immediate()
}

export function countActiveAdmins(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled_at IS NULL').get() as { n: number }).n
}
