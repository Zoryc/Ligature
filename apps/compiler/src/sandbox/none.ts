/**
 * 'none' sandbox: DEVELOPMENT ONLY. The helper and latexmk run as the worker's own user, with only
 * TeX's own restrictions (openin_any/openout_any=p, shell_escape=f). Refuses to start in production.
 */
import { mkdir, rm } from 'node:fs/promises'
import type { Sandbox } from './types.ts'

export function createNoneSandbox(env: NodeJS.ProcessEnv = process.env): Sandbox {
  return {
    kind: 'none',
    async init(buildsDir) {
      if (env.NODE_ENV === 'production') {
        throw new Error("SANDBOX=none is for development only and refuses to start when NODE_ENV=production (use SANDBOX=uid)")
      }
      await mkdir(buildsDir, { recursive: true })
    },
    async prepareProject(_projectId, dir) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
    },
    identity: () => ({}),
    helperEnv() {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
      return out
    },
    limitPrefix: () => [],
    async reap() { /* nothing: no per-project identity to sweep */ },
    async removeProject(_projectId, dir) {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
