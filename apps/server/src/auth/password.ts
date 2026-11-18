import { hash, hashSync, verify, type Algorithm, type Options } from '@node-rs/argon2'

export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 256

/** argon2id with explicit parameters (docs/M1.md §2). `Algorithm` is a const enum; 2 = Argon2id. */
const OPTIONS: Options = { algorithm: 2 as Algorithm, memoryCost: 19456, timeCost: 2, parallelism: 1 }

export function isAcceptablePassword(pw: string): boolean {
  return pw.length >= PASSWORD_MIN && pw.length <= PASSWORD_MAX
}

export function hashPassword(pw: string): Promise<string> {
  return hash(pw, OPTIONS)
}

export function hashPasswordSync(pw: string): string {
  return hashSync(pw, OPTIONS)
}

let dummy: Promise<string> | null = null
/** Counts verifications against the dummy hash (lets tests prove the unknown-user path does the work). */
export const passwordStats = { dummyVerifications: 0 }

/**
 * Verify `pw` against `stored`. With `stored === null` (unknown user, or a user without a password)
 * a dummy hash is verified instead, so the response time does not reveal whether the account exists.
 */
export async function verifyPassword(stored: string | null, pw: string): Promise<boolean> {
  if (stored === null) {
    dummy ??= hashPassword('ligature-dummy-password-for-timing')
    passwordStats.dummyVerifications++
    await verify(await dummy, pw).catch(() => false)
    return false
  }
  try {
    return await verify(stored, pw)
  } catch {
    return false
  }
}
