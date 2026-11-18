/**
 * The 'uid' sandbox for real: Linux, worker running as root, real latexmk. These are the tests that
 * can only run there (the rest of the suite uses SANDBOX=none and must NOT run as root, because the
 * helper refuses to). CI "sandbox" job, from apps/compiler:
 *
 *   sudo -E env "PATH=$PATH" SANDBOX=uid ../../node_modules/.bin/vitest run test/uidSandbox.test.ts test/corpus.test.ts
 *
 * With SANDBOX=uid set, missing prerequisites (not Linux, not root, no latexmk/prlimit, helper not readable
 * by other uids) FAIL instead of skipping. Without it the file is skipped. Ports: 39720-39729 (unused: unix sockets).
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker, type RunningWorker } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { HELPER_PATH, defaultHelperArgv } from '../src/runner.ts'
import { UID_BASE } from '../src/sandbox/projectUid.ts'
import { compile, postJson } from './harness.ts'

const WANTED = process.env.SANDBOX === 'uid'
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const ok = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0
const PORT = 39720

function blocker(): string | null {
  if (process.platform !== 'linux') return `needs Linux (this is ${process.platform})`
  if (!IS_ROOT) return 'needs root'
  if (!ok('latexmk', ['-v'])) return 'latexmk not on PATH'
  if (!ok('prlimit', ['--version'])) return 'prlimit (util-linux) not on PATH'
  return null
}
const WHY_NOT = WANTED ? blocker() : 'set SANDBOX=uid (Linux, as root) to run these'

if (WANTED && WHY_NOT) {
  describe('uid sandbox (real, as root)', () => {
    it('has its prerequisites', () => { throw new Error(`SANDBOX=uid tests cannot run: ${WHY_NOT}`) })
  })
} else {
  describe.skipIf(WHY_NOT !== null)(`uid sandbox (real, as root)${WHY_NOT ? ` [skipped: ${WHY_NOT}]` : ''}`, suite)
}

const DOC = '\\documentclass{article}\n\\begin{document}\nHello from a sandbox.\n\\end{document}\n'

// Logs the identity and the resource limits of the TeX process itself (whitespace squeezed so lines stay short).
const ID_PROBE = [
  '\\documentclass{article}',
  '\\directlua{dofile("id.lua")}',
  '\\begin{document}', 'Identity.', '\\end{document}', '',
].join('\n')
const ID_LUA = [
  'for _, f in ipairs({ "/proc/self/status", "/proc/self/limits" }) do',
  '  local h = io.open(f, "r")',
  '  if h then',
  '    for line in h:lines() do',
  '      if line:match("^Uid:") or line:match("^Gid:") or line:match("^Groups:") or line:match("^Max ") then',
  '        texio.write_nl("term and log", "IDPROBE " .. string.gsub(line, "%s+", " "))',
  '      end',
  '    end',
  '    h:close()',
  '  end',
  'end',
  '',
].join('\n')

function suite() {
  let root: string
  let builds: string
  let w: RunningWorker
  let base: string

  const start = async () => {
    const cfg = loadConfig({ SANDBOX: 'uid', COMPILER_LISTEN: `tcp:127.0.0.1:${PORT}`, BUILDS_DIR: builds, BUILDS_MIN_FREE_MB: '0' })
    w = await startWorker(cfg, { env: { ...process.env, NODE_ENV: 'test' } })
    base = `http://127.0.0.1:${PORT}`
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ligature-uid-'))
    spawnSync('chmod', ['0755', root])
    builds = join(root, 'builds')
    const r = spawnSync(process.execPath, ['-e', `require('node:fs').accessSync(${JSON.stringify(HELPER_PATH)}, 4)`], { uid: 65534, gid: 65534 })
    if (r.status !== 0) {
      throw new Error(`an unprivileged uid cannot read ${HELPER_PATH}: make the checkout world-readable (chmod o+rx on its parent directories)`)
    }
    await start()
  })

  afterAll(async () => {
    await w?.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('init: BUILDS_DIR is root 0711, the blob cache and output store root 0700', () => {
    const mode = (p: string) => statSync(p).mode & 0o7777
    expect(statSync(builds).uid).toBe(0)
    expect(mode(builds)).toBe(0o711)
    for (const d of ['.blobs', '.outputs']) {
      expect(statSync(join(builds, d)).uid).toBe(0)
      expect(mode(join(builds, d))).toBe(0o700)
    }
  })

  it('compiles as the project uid (no groups, prlimit limits applied), in a 0700 directory it owns', async () => {
    const id = randomUUID()
    const r = await compile(base, id, { 'main.tex': ID_PROBE, 'id.lua': ID_LUA }, { engine: 'lualatex', timeoutMs: 180_000 })
    expect(r.json.status, r.json.log.slice(-3000)).toBe('success')
    const st = statSync(join(builds, id))
    expect(st.uid).toBeGreaterThanOrEqual(UID_BASE)
    expect(st.gid).toBe(st.uid)
    expect(st.mode & 0o7777).toBe(0o700)
    expect(statSync(join(builds, id, 'src', 'main.tex')).uid).toBe(st.uid)
    expect(statSync(join(builds, id, 'out', 'output.pdf')).uid).toBe(st.uid)

    const log: string = r.json.log
    const line = (re: RegExp) => re.exec(log)?.[1]?.trim()
    expect(line(/IDPROBE Uid: (\d+ \d+ \d+ \d+)/), log.slice(-3000)).toBe(`${st.uid} ${st.uid} ${st.uid} ${st.uid}`)
    expect(line(/IDPROBE Gid: (\d+ \d+ \d+ \d+)/)).toBe(`${st.uid} ${st.uid} ${st.uid} ${st.uid}`)
    expect(line(/IDPROBE Groups:([^\n]*)/) ?? '').toBe('')
    expect(line(/IDPROBE Max processes (\d+)/)).toBe('256')
    expect(line(/IDPROBE Max open files (\d+)/)).toBe('1024')
    expect(line(/IDPROBE Max file size (\d+)/)).toBe(String(200 * 1024 * 1024))
    expect(line(/IDPROBE Max address space (\d+)/)).toBe(String(2 * 1024 ** 3))
    expect(line(/IDPROBE Max core file size (\d+)/)).toBe('0')
    expect(line(/IDPROBE Max cpu time (\d+)/)).toBe('185')
  }, 240_000)

  it('two projects get different uids and cannot enter each other\'s directories', async () => {
    const a = randomUUID()
    const b = randomUUID()
    expect((await compile(base, a, { 'main.tex': DOC }, { timeoutMs: 120_000 })).json.status).toBe('success')
    expect((await compile(base, b, { 'main.tex': DOC }, { timeoutMs: 120_000 })).json.status).toBe('success')
    const ua = statSync(join(builds, a)).uid
    const ub = statSync(join(builds, b)).uid
    expect(ua).not.toBe(ub)
    const peek = spawnSync(process.execPath, ['-e', `require('node:fs').readdirSync(${JSON.stringify(join(builds, b))})`], { uid: ua, gid: ua })
    expect(peek.status).not.toBe(0)
    const list = spawnSync(process.execPath, ['-e', `require('node:fs').readdirSync(${JSON.stringify(builds)})`], { uid: ua, gid: ua })
    expect(list.status, 'a project uid can list BUILDS_DIR').not.toBe(0)
  }, 240_000)

  it('after a restart, existing build directories keep their uid', async () => {
    const id = randomUUID()
    expect((await compile(base, id, { 'main.tex': DOC }, { timeoutMs: 120_000 })).json.status).toBe('success')
    const before = statSync(join(builds, id)).uid
    await w.close()
    await start()
    expect((await compile(base, id, { 'main.tex': DOC + '% changed\n' }, { timeoutMs: 120_000 })).json.status).toBe('success')
    expect(statSync(join(builds, id)).uid).toBe(before)
  }, 240_000)

  it('a build dir owned by another project\'s uid is reset, not shared', async () => {
    const owner = randomUUID()
    expect((await compile(base, owner, { 'main.tex': DOC }, { timeoutMs: 120_000 })).json.status).toBe('success')
    const taken = statSync(join(builds, owner)).uid
    // A directory for a new project, owned by the first project's uid, with a file in it.
    const intruder = randomUUID()
    mkdirSync(join(builds, intruder), { mode: 0o700 })
    writeFileSync(join(builds, intruder, 'planted'), 'x')
    chownSync(join(builds, intruder, 'planted'), taken, taken)
    chownSync(join(builds, intruder), taken, taken)
    expect((await compile(base, intruder, { 'main.tex': DOC }, { timeoutMs: 120_000 })).json.status).toBe('success')
    const st = statSync(join(builds, intruder))
    expect(st.uid).not.toBe(taken)
    expect(st.uid).toBeGreaterThanOrEqual(UID_BASE)
    expect(existsSync(join(builds, intruder, 'planted'))).toBe(false)
    expect(statSync(join(builds, owner)).uid).toBe(taken)
  }, 240_000)

  it('a symlink or file in place of a build dir is refused and its target left alone', async () => {
    const target = join(root, 'link-target')
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'keep')
    const id = randomUUID()
    symlinkSync(target, join(builds, id))
    const r = await compile(base, id, { 'main.tex': DOC }, { timeoutMs: 60_000 })
    expect(r.status === 200 && r.json.status === 'success').toBe(false)
    expect(lstatSync(join(builds, id)).isSymbolicLink()).toBe(true)
    expect(readdirSync(target)).toEqual(['keep'])
    expect(statSync(target).uid).toBe(0)
    rmSync(join(builds, id))
  }, 120_000)

  it('no process of the project uid survives a compile', async () => {
    const id = randomUUID()
    const r = await compile(base, id, { 'main.tex': '\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}\n' }, { timeoutMs: 3000 })
    expect(r.json.status).toBe('timeout')
    const uid = statSync(join(builds, id)).uid
    const left = readdirSync('/proc').filter(n => /^\d+$/.test(n)).filter(n => {
      try { return statSync(`/proc/${n}`).uid === uid } catch { return false }
    })
    expect(left).toEqual([])
  }, 60_000)

  it('the helper refuses to run as root', () => {
    const [node, ...args] = defaultHelperArgv()
    const r = spawnSync(node!, args, { input: '', encoding: 'utf8' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/refuses to run as root/)
  })

  it('production entrypoint: unix socket in a root:<gid> 0710 dir, socket 0660, project uids cannot connect', async () => {
    const run = join(root, 'run')
    const sock = join(run, 'compiler.sock')
    const worker = fileURLToPath(new URL('../src/worker.ts', import.meta.url))
    const healthcheck = fileURLToPath(new URL('../src/healthcheck.ts', import.meta.url))
    const nodeArgs = defaultHelperArgv().slice(1, -1)
    const env = { PATH: process.env.PATH ?? '', NODE_ENV: 'production', SANDBOX: 'uid', COMPILER_LISTEN: `unix:${sock}`,
      COMPILER_SOCKET_GID: '4321', BUILDS_DIR: join(root, 'prod-builds'), BUILDS_MIN_FREE_MB: '0' }
    const p = spawn(process.execPath, [...nodeArgs, worker], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      let out = ''
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`worker did not start:\n${out}`)), 20_000)
        const on = (d: Buffer) => { out += d; if (out.includes('listening on unix:')) { clearTimeout(t); resolve() } }
        p.stdout.on('data', on)
        p.stderr.on('data', on)
        p.on('exit', code => { clearTimeout(t); reject(new Error(`worker exited ${code}:\n${out}`)) })
      })
      const d = statSync(run)
      expect([d.uid, d.gid, d.mode & 0o7777]).toEqual([0, 4321, 0o710])
      const s = statSync(sock)
      expect([s.uid, s.gid, s.mode & 0o777]).toEqual([0, 4321, 0o660])

      const health = await new Promise<string>((resolve, reject) => {
        request({ socketPath: sock, path: '/healthz' }, res => {
          let b = ''
          res.on('data', c => { b += c })
          res.on('end', () => resolve(b))
        }).on('error', reject).end()
      })
      expect(JSON.parse(health)).toEqual({ ok: true, sandbox: 'uid' })
      expect(spawnSync(process.execPath, [...nodeArgs, healthcheck], { env }).status).toBe(0)

      const probe = `require('node:net').connect(${JSON.stringify(sock)}).on('connect', () => process.exit(0)).on('error', () => process.exit(3))`
      expect(spawnSync(process.execPath, ['-e', probe], { uid: UID_BASE + 12345, gid: UID_BASE + 12345 }).status, 'a project uid reached the socket').toBe(3)
      expect(spawnSync(process.execPath, ['-e', probe], { uid: 65534, gid: 4321 }).status, 'the socket group cannot connect').toBe(0)
    } finally {
      p.kill('SIGTERM')
    }
  }, 60_000)

  it('rejects compile requests for invalid input exactly like SANDBOX=none', async () => {
    const r = await postJson(base, `/projects/${randomUUID()}/compile`, { manifest: { '../x.tex': 'a'.repeat(64) }, mainFile: '../x.tex', engine: 'pdflatex' })
    expect(r.status).toBe(400)
  })
}
