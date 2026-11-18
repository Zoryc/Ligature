/**
 * Disk use of a project directory, for the per-project quota. Runs in the helper (project uid).
 * Never follows symlinks (a link counts as one entry of its own size).
 */
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Manifest } from './contract.ts'
import { errnoCode } from './fsSafe.ts'

export interface Usage {
  bytes: number
  entries: number
  /** the walk stopped early because a limit was already exceeded */
  over: boolean
}

export interface UsageLimits { maxBytes: number; maxEntries: number }

/** Sum the sizes of everything under `dir`, stopping as soon as `limits` are exceeded. */
export async function diskUsage(dir: string, limits: UsageLimits): Promise<Usage> {
  const u: Usage = { bytes: 0, entries: 0, over: false }
  const walk = async (abs: string): Promise<void> => {
    let names: string[]
    try { names = await readdir(abs) } catch (e) { if (errnoCode(e) === 'ENOENT') return; throw e }
    for (const name of names) {
      if (u.over) return
      const p = join(abs, name)
      let st
      try { st = await lstat(p) } catch (e) { if (errnoCode(e) === 'ENOENT') continue; throw e }
      u.entries++
      u.bytes += st.size
      if (u.bytes > limits.maxBytes || u.entries > limits.maxEntries) { u.over = true; return }
      if (st.isDirectory()) await walk(p)
    }
  }
  await walk(dir)
  return u
}

/** Bytes taken by the manifest's own files in `src` (they do not count against the quota). */
export async function sourceBytes(src: string, manifest: Manifest): Promise<number> {
  let total = 0
  for (const p of Object.keys(manifest)) {
    try {
      const st = await lstat(join(src, ...p.split('/')))
      if (st.isFile()) total += st.size
    } catch { /* missing: counts as 0 */ }
  }
  return total
}

export interface Quota { bytes: number; entries: number }

/**
 * Watches a project directory during a build: `check()` says whether the build has written more than
 * the quota allows (everything under the project root except the manifest's sources, which are
 * measured once before the run).
 */
export class QuotaWatch {
  private readonly root: string
  private readonly quota: Quota
  private readonly base: { bytes: number; entries: number }

  constructor(root: string, quota: Quota, base: { bytes: number; entries: number }) {
    this.root = root
    this.quota = quota
    this.base = base
  }

  static async start(root: string, src: string, manifest: Manifest, quota: Quota): Promise<QuotaWatch> {
    return new QuotaWatch(root, quota, { bytes: await sourceBytes(src, manifest), entries: Object.keys(manifest).length })
  }

  /** null if within the quota, else a sentence for the log. */
  async check(): Promise<string | null> {
    const u = await diskUsage(this.root, {
      maxBytes: this.base.bytes + this.quota.bytes,
      maxEntries: this.base.entries + this.quota.entries,
    })
    if (!u.over) return null
    return u.entries > this.base.entries + this.quota.entries
      ? `the build created more than ${this.quota.entries} files, over the per-project limit`
      : `the build wrote more than ${this.quota.bytes} bytes, over the per-project disk quota`
  }
}
