/** Running latexmk: argv, environment, timeout that kills the whole process group. */
import { spawn, spawnSync } from 'node:child_process'
import { ENGINE_FLAG, type Engine } from './contract.ts'
import type { Layout } from './materialize.ts'
import { MAX_CONSOLE_BYTES } from './limits.ts'
import { TailBuffer } from './logTail.ts'

const WIN = process.platform === 'win32'

/**
 * latexmk -norc -<pdf|pdfxe|pdflua> -interaction=nonstopmode -file-line-error -synctex=1 -jobname=output -outdir=<abs out> <mainFile>
 *
 * -norc (must be the first option) stops latexmk from executing Perl rc files from the project or from $HOME:
 * a `latexmkrc` in the project would otherwise be arbitrary code execution, i.e. shell-escape by the back door.
 * The out dir is passed as an absolute path so that sources may contain a folder called "out".
 */
export function latexmkArgs(engine: Engine, mainFile: string, outDir: string): string[] {
  return ['-norc', ENGINE_FLAG[engine], '-interaction=nonstopmode', '-file-line-error', '-synctex=1',
    '-jobname=output', `-outdir=${outDir}`, mainFile]
}

/** Environment for the TeX run: private HOME/TMPDIR/TEXMFVAR, and kpathsea's paranoid settings. */
export function texEnv(base: NodeJS.ProcessEnv, l: Layout): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v
  Object.assign(env, {
    HOME: l.home,
    TMPDIR: l.tmp,
    TEXMFVAR: l.texmfVar,
    TEXMFCONFIG: l.texmfConfig,
    // openout_any=p refuses absolute paths unless they lie under TEXMFOUTPUT. -outdir is absolute, so this
    // is the backstop for tools that are handed absolute paths in out/ (bibtex, makeindex, ...).
    TEXMFOUTPUT: l.out,
    TEXMFHOME: WIN ? l.home : '/nonexistent', // no per-user tree: packages come from TeX Live only
    openin_any: 'p',
    openout_any: 'p',
    shell_escape: 'f',
    // Don't wrap log lines at 79 characters (TeX Live's default): wrapped file names and `file:line:` errors
    // can't be parsed or matched (e.g. an `out/output.bbl` path split across two lines).
    max_print_line: '10000',
    error_line: '254',
    half_error_line: '238',
  })
  if (WIN) { env.TEMP = l.tmp; env.TMP = l.tmp }
  return env
}

export interface RunResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  /** set when the process could not be started at all (e.g. latexmk not installed) */
  spawnError: string | null
  /** killed because the `signal` option was aborted (e.g. the disk quota was exceeded) */
  aborted: boolean
  /** tail of stdout+stderr */
  console: string
  durationMs: number
}

export interface RunOptions {
  argv: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  /** aborting kills the whole process group, like the timeout */
  signal?: AbortSignal
}

function killTree(pid: number): void {
  if (WIN) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { /* group already gone */ }
}

/** Run a command in its own process group; on timeout SIGKILL the whole group. Never rejects. */
export function runCommand(o: RunOptions): Promise<RunResult> {
  const started = Date.now()
  const out = new TailBuffer(MAX_CONSOLE_BYTES)
  const [cmd, ...args] = o.argv
  return new Promise(resolve => {
    if (!cmd) { resolve({ exitCode: null, signal: null, timedOut: false, aborted: false, spawnError: 'empty command', console: '', durationMs: 0 }); return }
    let settled = false
    let timedOut = false
    let aborted = false
    const child = spawn(cmd, args, {
      cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'],
      detached: !WIN, // POSIX: new process group (pgid = pid), so the timeout can kill every descendant
      windowsHide: true,
    })
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => out.push(c))
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) killTree(child.pid)
    }, o.timeoutMs)
    const onAbort = () => {
      if (settled || timedOut) return
      aborted = true
      if (child.pid !== undefined) killTree(child.pid)
    }
    if (o.signal?.aborted) onAbort()
    else o.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (r: Omit<RunResult, 'console' | 'durationMs' | 'timedOut' | 'aborted'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      // POSIX: kill stragglers left in the group even after a normal exit, and stop waiting on their pipes.
      if (!WIN && child.pid !== undefined) killTree(child.pid)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ ...r, timedOut, aborted, console: out.text(), durationMs: Date.now() - started })
    }
    child.on('error', e => finish({ exitCode: null, signal: null, spawnError: e.message }))
    // 'close' fires once the pipes are drained too; a background grandchild could hold them open,
    // so after 'exit' wait at most a moment for it.
    child.on('close', (code, signal) => finish({ exitCode: code, signal, spawnError: null }))
    child.on('exit', (code, signal) => {
      setTimeout(() => finish({ exitCode: code, signal, spawnError: null }), 500).unref()
    })
  })
}
