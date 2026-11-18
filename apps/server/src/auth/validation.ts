import { z } from 'zod'

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*$/
// C0 controls, DEL and C1 controls.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

/** Lowercased, 3–32 chars, `^[a-z0-9][a-z0-9._-]*$`. */
export const usernameSchema = z.string().max(64).transform(s => s.toLowerCase())
  .pipe(z.string().min(3).max(32).regex(USERNAME_RE, 'invalid username'))

/** Trimmed, 1–64 chars, no control characters. */
export const displayNameSchema = z.string().max(256).transform(s => s.trim())
  .pipe(z.string().min(1).max(64).refine(s => !CONTROL_RE.test(s), 'control characters are not allowed'))

/** Length is checked separately (so a short password is `weak-password`, not `bad-request`). */
export const passwordFieldSchema = z.string().max(4096)

export function normalizeUsername(raw: string): string | null {
  const r = usernameSchema.safeParse(raw)
  return r.success ? r.data : null
}

export function normalizeDisplayName(raw: string): string | null {
  const r = displayNameSchema.safeParse(raw)
  return r.success ? r.data : null
}
