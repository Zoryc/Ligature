/**
 * Auto-compile (docs/M2.md §4): compile 2.5 s after the last local edit, never two at once, and
 * back off when the server says it is busy or rate-limited. Ctrl/Cmd+S compiles at once.
 * Pure (timers can be faked); Project.svelte wires it to the editor and the compile request.
 */

export const AUTO_COMPILE_DELAY_MS = 2500

export type CompileTrigger = 'auto' | 'manual'

/** What a compile attempt says about the next one. */
export type CompileOutcome =
  | { kind: 'done' }
  /** Not compiled because the server is overloaded or we hit a limit: wait before trying again. */
  | { kind: 'retry-later'; afterMs: number; reason: string }

export interface AutoCompileState {
  enabled: boolean
  running: boolean
  /** Unix ms until which auto-compile waits (rate limit / busy compiler), or null. */
  pausedUntil: number | null
  pauseReason: string | null
}

export interface AutoCompilerOptions {
  compile: (trigger: CompileTrigger) => Promise<CompileOutcome>
  enabled: boolean
  delayMs?: number
  onState?: (s: AutoCompileState) => void
  now?: () => number
}

export class AutoCompiler {
  private readonly compileFn: (trigger: CompileTrigger) => Promise<CompileOutcome>
  private readonly delayMs: number
  private readonly onState: (s: AutoCompileState) => void
  private readonly now: () => number
  private enabled: boolean
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** Local edits that no started build contains yet. */
  private dirty = false
  /** A compile asked for while one was running. */
  private again: CompileTrigger | null = null
  private pausedUntil = 0
  private pauseReason: string | null = null
  private disposed = false

  constructor(opts: AutoCompilerOptions) {
    this.compileFn = opts.compile
    this.enabled = opts.enabled
    this.delayMs = opts.delayMs ?? AUTO_COMPILE_DELAY_MS
    this.onState = opts.onState ?? (() => {})
    this.now = opts.now ?? Date.now
  }

  get state(): AutoCompileState {
    const paused = this.pausedUntil > this.now()
    return {
      enabled: this.enabled,
      running: this.running,
      pausedUntil: paused ? this.pausedUntil : null,
      pauseReason: paused ? this.pauseReason : null,
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Is an automatic compile waiting for its timer? (for tests and the UI) */
  get scheduled(): boolean {
    return this.timer !== null
  }

  setEnabled(on: boolean): void {
    if (this.disposed || on === this.enabled) return
    this.enabled = on
    if (!on) {
      this.clearTimer()
      if (this.again === 'auto') this.again = null
    } else if (this.dirty && !this.running) {
      this.schedule(this.delayMs)
    }
    this.emit()
  }

  /** The user edited the text (local edits only; collaborators' edits do not trigger a compile). */
  localEdit(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.enabled) this.schedule(this.delayMs)
  }

  /** Ctrl/Cmd+S or the Recompile button: compile now, or right after the running compile. */
  compileNow(): void {
    if (this.disposed) return
    this.clearTimer()
    if (this.running) this.again = 'manual'
    else void this.run('manual')
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private emit(): void {
    if (!this.disposed) this.onState(this.state)
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.clearTimer()
    const wait = Math.max(ms, this.pausedUntil - this.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.fire()
    }, wait)
  }

  private fire(): void {
    if (this.disposed || !this.enabled) return
    if (this.running) {
      this.again ??= 'auto'
      return
    }
    void this.run('auto')
  }

  private async run(trigger: CompileTrigger): Promise<void> {
    this.running = true
    this.dirty = false
    this.emit()
    let outcome: CompileOutcome
    try {
      outcome = await this.compileFn(trigger)
    } catch {
      outcome = { kind: 'done' }
    }
    this.running = false
    if (this.disposed) return
    if (outcome.kind === 'retry-later') {
      this.pausedUntil = this.now() + outcome.afterMs
      this.pauseReason = outcome.reason
      this.dirty = true // nothing was built
    } else if (this.pausedUntil <= this.now()) {
      this.pauseReason = null
    }
    const again = this.again
    this.again = null
    if (again === 'manual') {
      void this.run('manual')
      return
    }
    if (this.enabled && this.dirty) {
      // Edits arrived while compiling: if their timer already fired (again === 'auto') go now, else let it run.
      if (again === 'auto' || this.timer === null) this.schedule(again === 'auto' ? 0 : this.delayMs)
    }
    this.emit()
  }
}

/** How long to wait after a failed compile request, by error code; null when retrying soon is pointless or fine. */
export function backoffFor(code: string): { afterMs: number; reason: string } | null {
  switch (code) {
    case 'rate-limited': return { afterMs: 60_000, reason: 'too many compiles' }
    case 'compiler-busy': return { afterMs: 10_000, reason: 'the compiler is busy' }
    case 'compiler-unavailable': return { afterMs: 30_000, reason: 'the compiler is unavailable' }
    default: return null
  }
}

/* ---------- the per-project preference ---------- */

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function autoCompileKey(projectId: string): string {
  return `ligature:auto-compile:${projectId}`
}

/** Default on for owners/editors; viewers never compile. */
export function loadAutoCompile(store: Store | null, projectId: string, canCompile: boolean): boolean {
  if (!canCompile) return false
  try {
    const v = store?.getItem(autoCompileKey(projectId))
    return v === null || v === undefined ? true : v === '1'
  } catch {
    return true // storage disabled
  }
}

export function saveAutoCompile(store: Store | null, projectId: string, on: boolean): void {
  try {
    store?.setItem(autoCompileKey(projectId), on ? '1' : '0')
  } catch {
    // storage full or disabled: the toggle still works for this page
  }
}
