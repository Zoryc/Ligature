import { createNoneSandbox } from './none.ts'
import { createUidSandbox } from './uid.ts'
import type { Sandbox, SandboxKind } from './types.ts'

export type { Sandbox, SandboxKind } from './types.ts'

export const SANDBOX_KINDS: readonly SandboxKind[] = ['none', 'uid']

export function createSandbox(kind: SandboxKind, opts: { prlimit?: boolean; latexmk?: string[]; env?: NodeJS.ProcessEnv } = {}): Sandbox {
  switch (kind) {
    case 'none': return createNoneSandbox(opts.env)
    case 'uid': return createUidSandbox({ prlimit: opts.prlimit, latexmk: opts.latexmk, env: opts.env })
  }
}
