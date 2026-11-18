/** Client-side checks mirroring the server's rules (docs/M1.md §2), for early feedback only. */

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*$/
export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 256
// C0 controls, DEL and C1 controls.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

export function usernameProblem(raw: string): string | null {
  const u = raw.trim().toLowerCase()
  if (u.length < 3 || u.length > 32) return 'Username must be 3 to 32 characters.'
  if (!USERNAME_RE.test(u)) return 'Use lowercase letters, digits, dot, dash and underscore; start with a letter or digit.'
  return null
}

export function displayNameProblem(raw: string): string | null {
  const d = raw.trim()
  if (d.length < 1) return 'Enter a display name.'
  if (d.length > 64) return 'Display name must be at most 64 characters.'
  if (CONTROL_RE.test(d)) return 'Display name cannot contain control characters.'
  return null
}

export function passwordProblem(pw: string, confirm?: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`
  if (pw.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`
  if (confirm !== undefined && pw !== confirm) return 'The passwords do not match.'
  return null
}

/** Who may sign up right now, given the instance state and whether we hold an invite token. */
export type SignupMode = 'first-user' | 'open' | 'with-invite' | 'needs-invite' | 'closed'

export function signupMode(info: { registration: 'open' | 'invite-only' | 'closed'; hasUsers: boolean }, hasInvite: boolean): SignupMode {
  if (!info.hasUsers) return 'first-user'
  if (info.registration === 'closed') return 'closed'
  if (hasInvite) return 'with-invite'
  return info.registration === 'open' ? 'open' : 'needs-invite'
}
