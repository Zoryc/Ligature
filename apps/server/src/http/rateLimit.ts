import { UploadGate } from './uploadGate.ts'

/**
 * In-memory fixed-window counters (docs/M1.md §2: "in memory is fine for M1").
 * One limiter holds many keys; each key allows `max` hits per `windowMs`.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()
  private lastSweep = 0

  constructor(readonly max: number, readonly windowMs: number, private readonly now: () => number = Date.now) {}

  private entry(key: string): { count: number; resetAt: number } | null {
    const t = this.now()
    this.sweep(t)
    const e = this.hits.get(key)
    if (!e || e.resetAt <= t) return null
    return e
  }

  /** True if `cost` more hits would exceed the budget of `key` (does not count anything). */
  blocked(key: string, cost = 1): boolean {
    return (this.entry(key)?.count ?? 0) + cost > this.max
  }

  /** Count `n` hits. */
  hit(key: string, n = 1): void {
    const e = this.entry(key)
    if (e) e.count += n
    else this.hits.set(key, { count: n, resetAt: this.now() + this.windowMs })
  }

  /**
   * Check and count in one synchronous step, and report whether the request is allowed (true) or over
   * the limit (false). Use this *before* any await, so concurrent requests cannot all pass the check.
   */
  consume(key: string, cost = 1): boolean {
    if (this.blocked(key, cost)) return false
    this.hit(key, cost)
    return true
  }

  /** Give back `n` hits counted by `consume`/`hit` (e.g. the attempt turned out not to be a failure). */
  refund(key: string, n = 1): void {
    const e = this.entry(key)
    if (e) e.count = Math.max(0, e.count - n)
  }

  reset(key: string): void {
    this.hits.delete(key)
  }

  /** Drop expired windows at most once per window, so memory stays bounded. */
  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return
    this.lastSweep = t
    for (const [k, e] of this.hits) if (e.resetAt <= t) this.hits.delete(k)
  }
}

export interface RateLimitConfig {
  windowMs: number
  /** failed logins per (IP, username) */
  loginPerUser: number
  /** failed logins per IP */
  loginPerIp: number
  /** signups and invite previews per IP (each its own budget) */
  signupPerIp: number
  /** upload request bytes per user per `uploadWindowMs` (bounds disk growth from replace/delete loops; blob GC is M3) */
  uploadBytesPerUser: number
  uploadWindowMs: number
  /** upload bodies buffered at once, per process and per user (the rest wait for a slot) */
  uploadConcurrency: number
  uploadConcurrencyPerUser: number
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  loginPerUser: 10,
  loginPerIp: 50,
  signupPerIp: 20,
  uploadBytesPerUser: 2 * 1024 * 1024 * 1024,
  uploadWindowMs: 60 * 60 * 1000,
  uploadConcurrency: 8,
  uploadConcurrencyPerUser: 3,
}

export function createLimiters(cfg: RateLimitConfig) {
  return {
    loginUser: new RateLimiter(cfg.loginPerUser, cfg.windowMs),
    loginIp: new RateLimiter(cfg.loginPerIp, cfg.windowMs),
    signup: new RateLimiter(cfg.signupPerIp, cfg.windowMs),
    invitePreview: new RateLimiter(cfg.signupPerIp, cfg.windowMs),
    uploadBytes: new RateLimiter(cfg.uploadBytesPerUser, cfg.uploadWindowMs),
    uploadGate: new UploadGate(cfg.uploadConcurrency, cfg.uploadConcurrencyPerUser),
  }
}
export type Limiters = ReturnType<typeof createLimiters>
