import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiError } from '../errors.ts'

/**
 * First-admin setup token (production only). Without it, whoever reaches a fresh public instance first
 * becomes its administrator. The token lives in memory only: a new one is made at every start until the
 * first account exists, and it is printed to the server log, which only the operator can read.
 */
export function createSetupToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Hashing first gives equal-length buffers, so the compare is constant-time whatever was sent. */
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()

/** Throws `403 setup-token-required` unless `given` is the expected token. */
export function checkSetupToken(expected: string, given: string | undefined): void {
  if (given === undefined || given === '') {
    throw new ApiError(403, 'setup-token-required',
      'The first account needs the setup link printed in the server log (or create an admin with ligature create-admin)')
  }
  if (!timingSafeEqual(digest(expected), digest(given))) {
    throw new ApiError(403, 'setup-token-required',
      'This setup link is wrong or out of date: the server makes a new one at every start. Use the link from the latest server log')
  }
}

/** The one line main.ts logs while the instance has no accounts. */
export function setupLogLine(origin: string, token: string): string {
  return `[ligature] No accounts yet. Create the first (admin) account at ${origin}/#/signup?setup=${token}` +
    '  (or run: ligature create-admin <name>)'
}
