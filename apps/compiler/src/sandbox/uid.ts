/**
 * 'uid' sandbox (production default, Linux only). The worker runs as root inside a container with
 * cap_drop ALL + SETUID/SETGID/CHOWN/KILL. For each compile it:
 *   - creates BUILDS_DIR/<projectId> (mode 0700) and chowns it to the project's own uid, which no other
 *     project shares (see projectUid.ts); this mkdir/chown/chmod is the ONLY thing root does with
 *     project paths;
 *   - spawns the helper with {uid, gid} = project uid (libuv also drops supplementary groups), so every
 *     read/write inside the project directory happens as that uid;
 *   - wraps latexmk in `prlimit` (address space, file size, open files, processes, CPU time);
 *   - after every compile, kills every process of that uid.
 * BUILDS_DIR is root-owned 0711 (project uids may traverse to their own directory but not list others);
 * the blob cache and output store under it are root-owned 0700.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmod, chown, lstat, mkdir, readdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isUuid } from '../contract.ts'
import { errnoCode } from '../fsSafe.ts'
import { isSandboxUid, UidAllocator } from './projectUid.ts'
import type { Sandbox } from './types.ts'

const GB = 1024 ** 3
const MB = 1024 ** 2

export interface UidSandboxOptions {
  /** wrap latexmk in prlimit (default true) */
  prlimit?: boolean
  /** latexmk argv prefix; init() checks that `<latexmk> -v` runs */
  latexmk?: string[]
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  getuid?: () => number
}

/** Run a tiny Node script as `uid` (gid = uid, cwd /, empty environment). Resolves with its exit code. */
function runAs(uid: number, script: string, args: string[] = []): Promise<number | null> {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['-e', script, ...args], { uid, gid: uid, env: {}, stdio: 'ignore', cwd: '/' })
    p.on('error', () => resolve(null))
    p.on('exit', code => resolve(code))
  })
}

// kill(-1) from a process running as the project uid signals every process of that uid
// (except itself), wherever it is in the process tree.
const killAllOf = (uid: number) => runAs(uid, "try { process.kill(-1, 'SIGKILL') } catch {}")

const EMPTY_DIR = "const fs = require('node:fs'); const d = process.argv[1];" +
  " for (const e of fs.readdirSync(d)) fs.rmSync(d + '/' + e, { recursive: true, force: true })"

async function lstatOrNull(path: string) {
  try { return await lstat(path) } catch (e) { if (errnoCode(e) === 'ENOENT') return null; throw e }
}

export function createUidSandbox(o: UidSandboxOptions = {}): Sandbox {
  const env = o.env ?? process.env
  const platform = o.platform ?? process.platform
  const getuid = o.getuid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : -1))
  const usePrlimit = o.prlimit ?? true
  const uids = new UidAllocator()
  const ident = (projectId: string) => {
    const id = uids.get(projectId)
    if (id === undefined) throw new Error(`project ${projectId} has no sandbox uid (prepareProject first)`)
    return { uid: id, gid: id }
  }

  /** Empty `dir` as its owner `uid`, then remove the empty directory as root (root owns BUILDS_DIR). */
  const removeDirAs = async (uid: number, dir: string) => {
    await runAs(uid, EMPTY_DIR, [dir])
    await rmdir(dir)
  }

  return {
    kind: 'uid',
    async init(buildsDir) {
      if (platform !== 'linux') {
        throw new Error(`SANDBOX=uid needs Linux (setuid per project); this is ${platform}. Use SANDBOX=none for local development.`)
      }
      if (getuid() !== 0) throw new Error('SANDBOX=uid needs the worker to run as root (with only SETUID/SETGID/CHOWN/KILL capabilities)')
      if (usePrlimit && spawnSync('prlimit', ['--version'], { stdio: 'ignore' }).status !== 0) {
        throw new Error('SANDBOX=uid: `prlimit` (util-linux) not found on PATH; install it or set LIGATURE_PRLIMIT=0')
      }
      // In this sandbox latexmk runs behind prlimit, so a missing latexmk would only show up as a failed
      // build ("prlimit: failed to execute"). Check it here instead.
      const [lm, ...lmArgs] = o.latexmk ?? ['latexmk']
      if (!lm || spawnSync(lm, [...lmArgs, '-v'], { stdio: 'ignore' }).status !== 0) {
        throw new Error(`SANDBOX=uid: \`${(o.latexmk ?? ['latexmk']).join(' ')} -v\` failed; is TeX Live installed? (LIGATURE_LATEXMK)`)
      }
      await mkdir(buildsDir, { recursive: true })
      const st = await lstat(buildsDir)
      if (!st.isDirectory()) throw new Error(`BUILDS_DIR ${buildsDir} is not a directory`)
      await chown(buildsDir, 0, 0)
      await chmod(buildsDir, 0o711)
      // The owners of the existing build directories are the uid assignments.
      for (const name of await readdir(buildsDir)) {
        if (!isUuid(name)) continue
        const dir = join(buildsDir, name)
        const d = await lstat(dir)
        if (!d.isDirectory() || !isSandboxUid(d.uid)) continue // prepareProject sorts these out
        if (!uids.adopt(name, d.uid)) {
          // Shares its uid with another project (directories of an older worker version). It is only a
          // cache: delete it, and the project gets a uid of its own at its next compile.
          console.warn(`[compiler] build dir of ${name} shares uid ${d.uid} with another project; deleting it`)
          // If that fails, prepareProject retries before the project's next compile.
          await removeDirAs(d.uid, dir).catch(e => console.error(`[compiler] could not delete ${dir}`, e))
        }
      }
    },
    async prepareProject(projectId, dir) {
      let st = await lstatOrNull(dir)
      // Only root creates entries in BUILDS_DIR, so anything but a directory here means tampering.
      if (st && !st.isDirectory()) throw new Error(`build dir ${dir} is not a directory`)
      let uid = uids.get(projectId)
      if (uid === undefined && st && uids.adopt(projectId, st.uid)) uid = st.uid
      uid ??= uids.allocate(projectId)
      if (st) {
        if (st.uid === uid && st.gid === uid && (st.mode & 0o7777) === 0o700) return
        if (st.uid !== uid && isSandboxUid(st.uid)) {
          // Owned by a uid that is not this project's: its files are unusable to this project. Start afresh
          // (without killing processes of that uid, which may now be another project's).
          await removeDirAs(st.uid, dir)
          st = null
        } else {
          // Order matters: without CAP_FOWNER root may only chmod what it owns, so chmod happens while the
          // directory is root's and the chown to the project comes last.
          await chown(dir, 0, 0)
        }
      }
      if (!st) await mkdir(dir, { mode: 0o700 })
      await chmod(dir, 0o700)
      await chown(dir, uid, uid)
    },
    identity: ident,
    helperEnv() {
      // Minimal environment: nothing of the worker's leaks into the sandbox.
      return { PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }
    },
    limitPrefix(timeoutMs) {
      if (!usePrlimit) return []
      const cpuSeconds = Math.ceil(timeoutMs / 1000) + 5
      return ['prlimit', `--as=${2 * GB}`, `--fsize=${200 * MB}`, '--nofile=1024', '--nproc=256',
        `--cpu=${cpuSeconds}`, '--core=0', '--']
    },
    async reap(projectId) {
      const uid = uids.get(projectId)
      if (uid !== undefined) await killAllOf(uid)
    },
    async removeProject(projectId, dir) {
      const st = await lstatOrNull(dir)
      if (st) {
        if (!st.isDirectory()) throw new Error(`build dir ${dir} is not a directory`)
        if (isSandboxUid(st.uid)) {
          if (uids.get(projectId) === st.uid) await killAllOf(st.uid)
          await removeDirAs(st.uid, dir)
        } else {
          await rmdir(dir) // root-owned: never handed over, so empty
        }
      }
      uids.release(projectId)
    },
  }
}
