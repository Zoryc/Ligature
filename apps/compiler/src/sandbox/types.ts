/**
 * Pluggable sandbox. A sandbox decides WHO the per-compile helper process runs as and which limits apply;
 * the helper protocol (runner.ts <-> helper.ts) is the same for every sandbox.
 *
 * Implemented: 'none' (dev only) and 'uid' (Linux, worker runs as root, one uid per project).
 * Planned (PLAN section 6): 'gvisor' is the 'uid' sandbox under `runtime: runsc` (no code change needed);
 * 'bwrap' would wrap the helper command.
 */
export type SandboxKind = 'none' | 'uid'

export interface HelperIdentity { uid?: number; gid?: number }

export interface Sandbox {
  readonly kind: SandboxKind
  /** One-time startup checks and creation of BUILDS_DIR. Throws a clear error if this sandbox cannot run here. */
  init(buildsDir: string): Promise<void>
  /** Worker side (root for 'uid'): create the project directory and hand it to the project. Never opens anything inside it. */
  prepareProject(projectId: string, dir: string): Promise<void>
  /** spawn() identity of the helper for this project. */
  identity(projectId: string): HelperIdentity
  /** Environment the helper starts with (it adds the TeX-specific variables itself). */
  helperEnv(): Record<string, string>
  /** argv prefix applying OS resource limits to latexmk, e.g. ['prlimit', ..., '--'], or []. */
  limitPrefix(timeoutMs: number): string[]
  /** Kill anything the project may have left running (called after every compile). */
  reap(projectId: string): Promise<void>
  /** Delete the project's build directory (it is only a cache), working as the project's identity inside it. */
  removeProject(projectId: string, dir: string): Promise<void>
}
