import type { VersionKind } from '@ligature/shared'

/*
 * Retention / thinning of automatic versions (docs/M3.md §1). `planThinning` is pure; the store applies
 * its result (history/store.ts `deleteVersions`), and the daily GC (part B) runs it for every project.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

export interface RetentionPolicy {
  /** Keep every auto/compile version younger than this (default 24 h). */
  keepAllMs: number
  /** Then the newest per hour, up to this age (default 7 days). */
  hourlyMs: number
  /** Then the newest per day, up to this age (default 90 days); older: the newest per week. */
  dailyMs: number
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepAllMs: DAY, hourlyMs: 7 * DAY, dailyMs: 90 * DAY }

export interface ThinCandidate {
  id: string
  kind: VersionKind
  label: string | null
  createdAt: number
  /** Insertion order, the tie-breaker for equal timestamps (larger = newer). */
  seq: number
}

const THINNABLE: ReadonlySet<VersionKind> = new Set(['auto', 'compile'])

const newer = (a: ThinCandidate, b: ThinCandidate) => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.seq > b.seq)

/**
 * The versions of ONE project to delete at `now`. Kept: every named, pre_restore and import version,
 * anything with a label, the project's latest version, and of the automatic (auto/compile) ones: all from
 * the last `keepAllMs`, the newest per hour up to `hourlyMs`, the newest per day up to `dailyMs`, the
 * newest per week after that. Buckets are aligned to the Unix epoch (UTC).
 */
export function planThinning(versions: readonly ThinCandidate[], now: number, policy: RetentionPolicy = DEFAULT_RETENTION): string[] {
  if (versions.length === 0) return []
  let latest = versions[0]!
  for (const v of versions) if (newer(v, latest)) latest = v
  const keepers = new Map<string, ThinCandidate>() // bucket key -> newest version in it
  const candidates: ThinCandidate[] = []
  for (const v of versions) {
    if (!THINNABLE.has(v.kind) || (v.label !== null && v.label !== '')) continue
    const age = now - v.createdAt
    if (age < policy.keepAllMs) continue
    const key = age < policy.hourlyMs ? `h${Math.floor(v.createdAt / HOUR)}`
      : age < policy.dailyMs ? `d${Math.floor(v.createdAt / DAY)}`
      : `w${Math.floor(v.createdAt / WEEK)}`
    // The latest version competes for its bucket (it is the newest there) but is never a candidate itself.
    if (v !== latest) candidates.push(v)
    const cur = keepers.get(key)
    if (!cur || newer(v, cur)) keepers.set(key, v)
  }
  const kept = new Set([...keepers.values()].map(v => v.id))
  return candidates.filter(v => !kept.has(v.id)).map(v => v.id)
}
