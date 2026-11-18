/** Turn API errors (and network failures) into short messages for people. */

/** Friendly text for the server's error codes (docs/M1.md + apps/server/src/http/routes). */
const MESSAGES: Record<string, string> = {
  'invalid-credentials': 'Wrong username or password.',
  'rate-limited': 'Too many attempts. Wait a few minutes and try again.',
  'registration-closed': 'Registration is closed on this server. Ask an administrator for an account.',
  'invite-required': 'You need an invite link to sign up on this server.',
  'invite-invalid': 'This invite link is invalid, has expired, or has been used up.',
  'username-taken': 'That username is already taken.',
  'weak-password': 'The password must be 10 to 256 characters long.',
  'account-disabled': 'This account has been disabled. Contact an administrator.',
  'last-admin': 'This would leave the server without an active administrator.',
  'owner-immutable': 'The owner’s role cannot be changed. Transfer ownership instead.',
  'owner-must-transfer': 'The owner cannot leave the project. Transfer ownership first.',
  'name-taken': 'A file or folder with that name already exists here (names are not case-sensitive).',
  'cycle': 'A folder cannot be moved into itself or one of its subfolders.',
  'kind-mismatch': 'A file with that name exists but is of a different type (text vs binary). Delete or rename it first.',
  'too-large': 'The file is too large.',
  'project-too-large': 'The project has reached its size limit (number of files or total size of binary files).',
  'length-required': 'The upload could not be sent (missing length). Try again.',
  'not-found': 'Not found. It may have been deleted, or you no longer have access.',
  'forbidden': 'You do not have permission to do that.',
  'unauthenticated': 'Your session has expired. Log in again.',
  'compiler-unavailable': 'The compiler is unavailable right now.',
  'compiler-busy': 'The compiler is busy with other builds. Try again in a moment.',
  'no-build': 'This project has not been compiled yet.',
  'bad-zip': 'This file is not a usable zip archive.',
  'content-missing': 'Some content of that version is missing on the server, so it cannot be restored.',
  'network': 'Cannot reach the server. Check your connection and try again.',
}

/**
 * Codes where the server's own message is more useful than a generic text. 'rate-limited' covers both
 * login/invite attempts and the upload byte budget ("Upload volume limit reached"); the generic text
 * is only used when the server sent no message.
 */
const PREFER_SERVER_MESSAGE = new Set(['bad-request', 'too-large', 'project-too-large', 'kind-mismatch', 'rate-limited', 'bad-zip'])

interface ErrorLike { code?: unknown; message?: unknown; status?: unknown }

export function errorCode(e: unknown): string {
  if (e && typeof e === 'object' && typeof (e as ErrorLike).code === 'string') return (e as { code: string }).code
  // fetch() rejects with a TypeError when the network is down; XHR uploads use the same code.
  if (e instanceof TypeError) return 'network'
  return 'unknown'
}

/**
 * A message for an error thrown by the API client.
 * `overrides` lets a page use its own wording for a code (e.g. 'not-found' on the invite page).
 */
export function errorMessage(e: unknown, overrides: Record<string, string> = {}): string {
  const code = errorCode(e)
  const override = overrides[code]
  if (override) return override
  const serverMsg = e && typeof e === 'object' && typeof (e as ErrorLike).message === 'string' ? (e as { message: string }).message : ''
  const hasServerMsg = serverMsg !== '' && serverMsg !== code
  if (PREFER_SERVER_MESSAGE.has(code) && hasServerMsg) return capitalize(serverMsg)
  const known = MESSAGES[code]
  if (known) return known
  if (code === 'bad-request') return 'The request was rejected as invalid.'
  if (hasServerMsg) return capitalize(serverMsg)
  return `Something went wrong (${code}).`
}

function capitalize(s: string): string {
  const t = s.trim()
  const out = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(out) ? out : `${out}.`
}
