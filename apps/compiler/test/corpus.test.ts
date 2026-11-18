/**
 * The malicious-TeX corpus (docs/M1.md §8): every case runs through the real worker over HTTP with a
 * real latexmk, and must "fail safely": the worker stays up, nothing outside the project directory is
 * read or written, no command runs, the compile ends within its timeout, other projects are unaffected.
 *
 * Two modes, chosen by the SANDBOX environment variable:
 *   SANDBOX=uid   the real target (CI "sandbox" job): Linux, as root, one uid per project. Every check runs.
 *                 Missing prerequisites FAIL (they never skip).
 *     sudo -E env "PATH=$PATH" SANDBOX=uid npx vitest run test/corpus.test.ts      (in apps/compiler)
 *   SANDBOX=none  (default) anywhere, as a normal user: only TeX's own restrictions (openin_any/openout_any=p,
 *                 shell_escape=f, -norc) and the worker's limits apply. Checks that only the OS boundary can
 *                 guarantee are skipped, with the reason in the test name.
 * With CI=true a missing latexmk fails instead of skipping. CORPUS_STRICT=1 turns KNOWN GAPS into failures.
 * CORPUS_NO_WORLD_WRITABLE=1 (uid mode): the host has no world-writable /tmp, /var/tmp, /dev/shm, like production.
 * The worker listens on 127.0.0.1:${CORPUS_PORT:-39711}.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { deflateSync, gunzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startWorker, type RunningWorker } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import type { CompileResponse, Engine } from '../src/contract.ts'
import { HELPER_PATH } from '../src/runner.ts'
import { CORPUS_DIR, fwd, loadProject, pdfText, probes, strayProcesses, tjText } from './corpus/corpus.ts'
import { eventually, manifestOf, postJson, sha, syncFiles } from './harness.ts'

const MODE: 'uid' | 'none' = process.env.SANDBOX === 'uid' ? 'uid' : 'none'
const UID = MODE === 'uid'
const STRICT = process.env.CORPUS_STRICT === '1'
/** Set where the host was prepared like the production compiler container: no world-writable /tmp, /var/tmp, /dev/shm. */
const HOST_HARDENED = process.env.CORPUS_NO_WORLD_WRITABLE === '1'
const IN_CI = process.env.CI === 'true' || process.env.CI === '1'
const PORT = Number(process.env.CORPUS_PORT ?? 39711)
const FLOOD_LINES = Number(process.env.CORPUS_FLOOD_LINES ?? 2_000_000)
const MAX_FILES = 3000
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const TEX_TIMEOUT = 180_000
const MAX_REPORTED_LOG = 2 * 1024 * 1024 + 64 * 1024

const latexmkVersion = (() => {
  const r = process.platform === 'win32'
    ? spawnSync('latexmk -v', { encoding: 'utf8', shell: true })
    : spawnSync('latexmk', ['-v'], { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout.split('\n').find(l => /Latexmk/.test(l)) ?? 'latexmk').trim() : null
})()

function blocker(): string | null {
  if (UID) {
    if (process.platform !== 'linux') return `SANDBOX=uid needs Linux (this is ${process.platform})`
    if (!IS_ROOT) return 'SANDBOX=uid needs root: sudo -E env "PATH=$PATH" SANDBOX=uid npx vitest run test/corpus.test.ts'
  } else if (IS_ROOT) {
    return 'SANDBOX=none cannot run as root (the compile helper refuses to); run as a normal user, or use SANDBOX=uid'
  }
  if (latexmkVersion === null) return 'latexmk is not on PATH (install TeX Live)'
  return null
}

const WHY_NOT = blocker()
const NOT_UID = 'uid sandbox only: with SANDBOX=none TeX runs with the worker\'s own rights, and Lua\'s io library ignores openin_any'

/**
 * Does kpathsea apply openin_any=p to READING? TeX Live < 2026: yes (absolute and ../ paths are refused).
 * TeX Live 2026: no, reading is always allowed ("no one seems to have any requirement for restricted
 * reading", kpathsea tex-file.c), so only the OS boundary keeps a document from reading a file.
 */
const TEX_GUARDS_READS = (() => {
  const r = spawnSync('kpsewhich', ['-safe-in-name=/etc/passwd'], { env: { ...process.env, openin_any: 'p' }, stdio: 'ignore' })
  return r.status !== null && r.status !== 0 && !r.error
})()
const TEX_LIVE = (() => {
  const r = spawnSync('pdftex', ['--version'], { encoding: 'utf8' })
  return /\((TeX Live [^)]*)\)/.exec(r.stdout ?? '')?.[1] ?? 'TeX Live (unknown version)'
})()
/** Files a project must never read (other projects, root-only files): guarded by the uid sandbox, or by TeX itself before 2026. */
const PRIVATE_GUARDED = UID || TEX_GUARDS_READS
const NO_PRIVATE_GUARD = 'needs the uid sandbox here: this TeX Live\'s kpathsea does not apply openin_any to reading (TeX Live 2026 and later)'

if (WHY_NOT !== null && (UID || IN_CI)) {
  describe(`malicious-TeX corpus (SANDBOX=${MODE})`, () => {
    it('has its prerequisites', () => { throw new Error(`the corpus cannot run: ${WHY_NOT}`) })
  })
} else {
  describe.skipIf(WHY_NOT !== null)(`malicious-TeX corpus (SANDBOX=${MODE}${WHY_NOT ? `; skipped: ${WHY_NOT}` : ''})`, corpus)
}

describe('corpus helpers', () => {
  it('pdfText finds typeset text that kerning split into pieces (TJ arrays, escapes, Tj)', () => {
    const content = 'BT /F1 10 Tf [(ro)-27(ot:x:0:0:r)-28.5(oot\\050home\\051:/bin/b)-3(ash)]TJ 0 -12 Td (x\\)y) Tj ET'
    const pdf = Buffer.concat([Buffer.from('%PDF-1.5\n4 0 obj\n<< /Length 99 /Filter /FlateDecode >>\nstream\n'),
      deflateSync(content), Buffer.from('\nendstream\nendobj\n%%EOF\n')])
    const text = pdfText(pdf)
    expect(text).toContain('root:x:0:0:root(home):/bin/bash')
    expect(text).toContain('x)y')
    expect(tjText('[(a)1(b)]TJ [(c)] TJ')).toBe('abc')
  })
})

/* ------------------------------------------------------------------------------------------------ */

function corpus() {
  let w: RunningWorker
  let base: string
  let root: string, builds: string, outside: string, sink: string, ww: string, locked: string
  const tag = randomBytes(6).toString('hex')
  // Markers are digits only: Computer Modern has no kerns between digits, so a typeset marker stays one
  // contiguous string in the PDF and the leak check can find it (the victim's own PDF proves that).
  const digits = (prefix: string) => prefix + Array.from(randomBytes(20), b => String(b % 10)).join('')
  const markers = new Map<string, string>() // label -> text that must never appear in another project's outputs
  const vars: Record<string, string> = {}
  const known = new Set<string>(['.blobs', '.outputs'])
  const victim = randomUUID()
  let victimFiles: Record<string, string>
  const pwnedTmp = process.platform === 'win32' ? '' : `/tmp/ligature-corpus-pwned-${tag}`
  /** Name of what the climbing probes (cases 4 and 5) try to create; removed from every target afterwards. */
  const climbFile = `ligature-climb-${tag}`
  /** [label, directory] the Lua probes of case 4 try to reach with relative lfs.chdir("..") and write into. */
  const climbTargets: [string, string][] = []
  /** System directories a document could reach by climbing; production has none of them world-writable. */
  const SYSTEM_DIRS: [string, string][] = process.platform === 'linux' ? [['tmp', '/tmp'], ['var-tmp', '/var/tmp'], ['dev-shm', '/dev/shm']] : []
  const climbed = (dir: string) => [climbFile, `${climbFile}.d`, `${climbFile}-openout.tex`].filter(n => existsSync(join(dir, n)))

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ligature-corpus-'))
    chmodSync(root, 0o755) // project uids must traverse to BUILDS_DIR and to the world-readable secret
    builds = join(root, 'builds')
    outside = join(root, 'outside')
    sink = join(root, 'sink')
    mkdirSync(outside, { mode: 0o755 })
    mkdirSync(join(outside, 'decoydir'), { mode: 0o755 })
    mkdirSync(sink)
    chmodSync(sink, 0o1777) // world-writable like /tmp: only TeX's restrictions keep a project out of it
    ww = join(outside, 'ww')
    mkdirSync(ww)
    chmodSync(ww, 0o1777) // world-writable too, for the climbing probes (the sink must stay empty)
    locked = join(outside, 'locked')
    mkdirSync(locked, { mode: 0o755 }) // owned by the worker's user: project uids may enter it, not write
    chmodSync(locked, 0o755)
    chmodSync(outside, 0o755)

    const secret = digits('1')
    const priv = digits('2')
    const decoy1 = digits('3')
    const decoy2 = digits('4')
    writeFileSync(join(outside, 'secret.txt'), secret + '\n', { mode: 0o644 })
    writeFileSync(join(outside, 'private.txt'), priv + '\n', { mode: 0o600 })
    chmodSync(join(outside, 'private.txt'), 0o600)
    writeFileSync(join(outside, 'decoy1.txt'), decoy1 + '\n')
    writeFileSync(join(outside, 'decoy2.txt'), decoy2 + '\n')
    markers.set('world-readable secret', secret)
    markers.set('root-only secret', priv)
    markers.set('decoy 1', decoy1)
    markers.set('decoy 2', decoy2)
    if (existsSync('/etc/passwd')) markers.set('/etc/passwd', readFileSync('/etc/passwd', 'utf8').split('\n')[0]!)
    if (UID && existsSync('/etc/shadow')) {
      const first = readFileSync('/etc/shadow', 'utf8').split('\n')[0]!
      if (first.length >= 8) markers.set('/etc/shadow', first)
    }

    const env: Record<string, string> = {
      SANDBOX: MODE, COMPILER_LISTEN: `tcp:127.0.0.1:${PORT}`, BUILDS_DIR: builds,
      PROJECT_DISK_QUOTA_MB: '400', PROJECT_MAX_FILES: String(MAX_FILES), BUILDS_MIN_FREE_MB: '0',
    }
    const cfg = loadConfig(env)
    cfg.latexmk = ['latexmk']
    if (UID) preflightUid()
    w = await startWorker(cfg, { env: { ...process.env, NODE_ENV: 'test' } })
    base = `http://127.0.0.1:${PORT}`
    console.log(`[corpus] SANDBOX=${MODE} platform=${process.platform} uid=${process.getuid?.() ?? 'n/a'} ` +
      `${latexmkVersion} ${TEX_LIVE} openin_any-applies-to-reading=${TEX_GUARDS_READS} worker=${w.address} builds=${builds}${STRICT ? ' STRICT' : ''}`)

    // The victim: another project with a secret, compiled first, which the attackers try to reach.
    const victimMarker = digits('5')
    markers.set('victim project', victimMarker)
    Object.assign(vars, {
      SECRET: fwd(join(outside, 'secret.txt')),
      PRIVATE: fwd(join(outside, 'private.txt')),
      BUILDS: fwd(builds),
      OTHER: victim,
      VICTIM_MARKER: victimMarker,
      PWNED: fwd(join(sink, 'pwned')),
      PWNED_WRITE: fwd(join(sink, 'pwned-write')),
      PWNED_DOT: fwd(join(sink, 'pwned-dot')),
      PWNED_TMP: pwnedTmp || fwd(join(sink, 'pwned-tmp')),
      WORKER_PID: String(process.pid),
      FLOOD_LINES: String(FLOOD_LINES),
      PDF_MB: '110',
      MANY_FILES: '20000',
      PORT: String(PORT),
      CLIMB_FILE: climbFile,
      CLIMB_WW: fwd(ww),
      CLIMB_LOCKED: fwd(locked),
    })
    climbTargets.push(['world-writable', ww], ['locked', locked])
    // Not with SANDBOX=none: there the probe would really write into the victim's sources and /tmp.
    if (UID) climbTargets.push(['other-project', join(builds, victim, 'src')], ...SYSTEM_DIRS.filter(([, d]) => existsSync(d)))
    vars.CLIMB_TARGETS = `{ ${climbTargets.map(([n, d]) => `{ ${JSON.stringify(n)}, ${JSON.stringify(fwd(d))} }`).join(', ')} }`
    victimFiles = loadProject('02-other-project/victim', vars)
    const secretHash = sha(victimFiles['secret.tex']!)
    vars.BLOB = fwd(join(builds, '.blobs', secretHash.slice(0, 2), secretHash.slice(2)))
    const v = await build('victim', victim, victimFiles, 'main.tex', 'pdflatex', { allow: ['victim project'] })
    expect(v.status, v.log).toBe('success')
    expect(existsSync(vars.BLOB)).toBe(true)
    // Positive control of the leak check: the victim's own PDF does contain its marker.
    expect(pdfText(v.files['output.pdf']!).includes(victimMarker), 'leak check cannot find a typeset marker in a PDF').toBe(true)
  }, TEX_TIMEOUT + 60_000)

  afterAll(async () => {
    await w?.close()
    for (const [, d] of climbTargets) {
      for (const n of [climbFile, `${climbFile}.d`, `${climbFile}-openout.tex`]) rmSync(join(d, n), { recursive: true, force: true })
    }
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    if (pwnedTmp) rmSync(pwnedTmp, { force: true })
  })

  // After every case: the worker is healthy, nothing was written outside the project directories.
  afterEach(async () => {
    const h = await fetch(`${base}/healthz`)
    expect(h.status, 'worker /healthz after the case').toBe(200)
    expect(readdirSync(sink), 'files created in the world-writable sink directory').toEqual([])
    if (pwnedTmp) expect(existsSync(pwnedTmp), `${pwnedTmp} was created`).toBe(false)
    const strays = readdirSync(builds).filter(n => !known.has(n))
    expect(strays, 'unexpected entries in BUILDS_DIR (written outside a project directory?)').toEqual([])
  })

  interface Built extends CompileResponse { id: string; files: Partial<Record<string, Buffer>>; probes: Map<string, string> }

  /** sync + compile + fetch every output, and check that no marker leaks into any of it. */
  async function build(label: string, id: string, files: Record<string, string>, mainFile: string, engine: Engine,
    o: { timeoutMs?: number; allow?: string[] } = {}): Promise<Built> {
    known.add(id)
    await syncFiles(base, id, files)
    const started = Date.now()
    const r = await postJson(base, `/projects/${id}/compile`, { manifest: manifestOf(files), mainFile, engine, timeoutMs: o.timeoutMs ?? TEX_TIMEOUT })
    expect(r.status, `compile ${label}: HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 500)}`).toBe(200)
    const res = r.json as CompileResponse
    const fetched: Partial<Record<string, Buffer>> = {}
    for (const name of res.outputs) {
      const g = await fetch(`${base}/projects/${id}/output/${name}`)
      expect(g.status, `GET output ${name}`).toBe(200)
      fetched[name] = Buffer.from(await g.arrayBuffer())
    }
    const p = probes(res.log)
    console.log(`[corpus] ${label}: status=${res.status} ${Date.now() - started} ms outputs=[${res.outputs.join(',')}]` +
      (p.size ? ` probes={${[...p].map(([k, v]) => `${k}: ${v}`).join('; ')}}` : ''))
    const texts: [string, string][] = [['log', res.log]]
    if (fetched['output.pdf']) texts.push(['pdf', pdfText(fetched['output.pdf'])])
    if (fetched['output.log']) texts.push(['output.log', fetched['output.log'].toString('utf8')])
    if (fetched['output.synctex.gz']) {
      try { texts.push(['synctex', gunzipSync(fetched['output.synctex.gz']).toString('latin1')]) } catch { texts.push(['synctex', fetched['output.synctex.gz'].toString('latin1')]) }
    }
    for (const [what, text] of texts) {
      for (const [m, value] of markers) {
        if (o.allow?.includes(m)) continue
        expect(text.includes(value), `${label}: the ${m} leaked into the ${what}\n--- log tail ---\n${res.log.slice(-3000)}`).toBe(false)
      }
    }
    return { ...res, id, files: fetched, probes: p }
  }

  const expectProbe = (b: Built, label: string, allowed: string[]) =>
    expect(allowed, `probe "${label}" of ${b.id}: got ${b.probes.get(label) ?? '(missing)'}\n--- log tail ---\n${b.log.slice(-4000)}`)
      .toContain(b.probes.get(label) ?? '(missing)')

  const fileHash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

  /** Whether a marker shows up in a build's log or (inflated) PDF. */
  const leaks = (b: Built, marker: string) => {
    const value = markers.get(marker)
    if (value === undefined) return false
    return b.log.includes(value) || (b.files['output.pdf'] !== undefined && pdfText(b.files['output.pdf']).includes(value))
  }

  /** A documented limitation: a warning (and a GitHub annotation), or a failure with CORPUS_STRICT=1. */
  const knownGap = (msg: string) => {
    console.warn(`[corpus] KNOWN GAP: ${msg}`)
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=Malicious-TeX corpus: known gap::${msg}`)
    if (STRICT) throw new Error(`KNOWN GAP (CORPUS_STRICT=1): ${msg}`)
  }

  /* ---------------------------------------------------------------------------------------- 1 */
  describe('1. reading /etc/passwd and other files outside the project', () => {
    const files = () => loadProject('01-read-system-files', { ...vars, SECRET_REL: fwd(relative(join(builds, 'x', 'src'), join(outside, 'secret.txt'))) })

    it.skipIf(!PRIVATE_GUARDED)(`a file the project uid cannot read (root-only) is refused by \\openin and \\input; nothing leaks${PRIVATE_GUARDED ? '' : ` [${NO_PRIVATE_GUARD}]`}`, async () => {
      const b = await build('01 private', randomUUID(), files(), 'private.tex', 'pdflatex', { allow: ['world-readable secret', '/etc/passwd'] })
      for (const l of ['private-absolute', 'private-dotdot']) expectProbe(b, l, ['refused'])
      expect(b.status).toBe('failure')
    }, TEX_TIMEOUT)

    it(`world-readable files (/etc/passwd, a 0644 file outside the project): refused by openin_any=p before TeX Live 2026, a KNOWN GAP since (${TEX_LIVE})`, async () => {
      const allow = TEX_GUARDS_READS ? [] : ['world-readable secret', '/etc/passwd']
      const b = await build('01 world-readable', randomUUID(), files(), 'main.tex', 'pdflatex', { allow })
      const p = await build('01 passwd', randomUUID(), files(), 'passwd.tex', 'pdflatex', { allow })
      const labels = ['etc-passwd', 'secret-absolute', 'secret-relative', 'secret-dotdot']
      if (TEX_GUARDS_READS) {
        for (const l of labels) expectProbe(b, l, ['refused'])
        expect(b.status).toBe('failure')
        expect(p.status).toBe('failure')
        expect(p.outputs).not.toContain('output.pdf')
        return
      }
      const read = labels.filter(l => b.probes.get(l) === 'READ')
      const leaked = [...(leaks(b, 'world-readable secret') ? ['the 0644 secret'] : []), ...(leaks(p, '/etc/passwd') ? ['/etc/passwd'] : [])]
      if (read.length || leaked.length) {
        knownGap(`${TEX_LIVE} does not apply openin_any to reading, so \\openin/\\input read world-readable files outside the project ` +
          `(read: ${read.join(', ') || 'none'}; typeset into the PDF/log: ${leaked.join(', ') || 'none'}). Files of other projects, the blob cache ` +
          'and root-only files stay unreadable (uid sandbox). Closing this needs a mount namespace (gVisor, bwrap) or an image without anything world-readable worth reading.')
      }
    }, 2 * TEX_TIMEOUT)
  })

  /* ---------------------------------------------------------------------------------------- 2 */
  describe('2. reading another project\'s build directory', () => {
    it.skipIf(!PRIVATE_GUARDED)(`\\openin/\\input of ../<other>/src/... and absolute paths into BUILDS_DIR are refused${PRIVATE_GUARDED ? '' : ` [${NO_PRIVATE_GUARD}]`}`, async () => {
      const b = await build('02 attacker', randomUUID(), loadProject('02-other-project/attacker', vars), 'main.tex', 'pdflatex')
      for (const l of ['other-dotdot', 'other-absolute', 'other-out-aux', 'blob-cache']) expectProbe(b, l, ['refused'])
      expect(b.status).toBe('failure')
    }, TEX_TIMEOUT)
  })

  /* ---------------------------------------------------------------------------------------- 3 */
  describe('3. shell escape', () => {
    it('\\write18 does not run (shell_escape=f) and the document still builds', async () => {
      const files = loadProject('03-shell-escape', vars)
      const b = await build('03 write18', randomUUID(), files, 'main.tex', 'pdflatex')
      expect(b.status, b.log.slice(-3000)).toBe('success')
      expect(b.log).toMatch(/runsystem\(touch .*\)\.\.\.disabled/)
      const p = await build('03 pipe', randomUUID(), files, 'pipe.tex', 'pdflatex')
      expect(['failure', 'success']).toContain(p.status)
    }, 2 * TEX_TIMEOUT)
  })

  /* ---------------------------------------------------------------------------------------- 4 */
  describe('4. Lua (lualatex): os.execute, io.popen, io.open', () => {
    let b: Built
    beforeAll(async () => {
      b = await build('04 lua', randomUUID(), loadProject('04-lua-escape', vars), 'main.tex', 'lualatex')
      expect(b.status, b.log.slice(-3000)).toBe('success')
    }, TEX_TIMEOUT)

    it('os.execute, io.popen, os.spawn and os.exec run nothing', () => {
      for (const l of ['os.execute', 'io.popen', 'os.spawn', 'os.exec']) expectProbe(b, l, ['refused'])
    })

    it('io.open cannot write outside the project (absolute path, ..)', () => {
      for (const l of ['write-absolute', 'write-dotdot']) expectProbe(b, l, ['refused'])
    })

    it.skipIf(!UID)(`io.open cannot read root-only files, other projects, the blob cache or the worker's environment; cannot list BUILDS_DIR [${NOT_UID}]`, () => {
      for (const l of ['read-private-secret', 'read-other-project', 'read-blob-cache', 'read-worker-environ', 'list-builds-dir']) {
        expectProbe(b, l, ['refused'])
      }
    })

    it.skipIf(!UID)(`KNOWN GAP: io.open can read world-readable files of the compiler container (e.g. /etc/passwd) [${NOT_UID}]`, () => {
      const read = ['read-etc-passwd', 'read-world-readable-secret'].filter(l => b.probes.get(l) === 'READ')
      if (read.length > 0) {
        knownGap(`Lua io.open read world-readable files outside the project (${read.join(', ')}). ` +
          'kpathsea\'s openin_any does not restrict Lua, and the uid sandbox only protects files that are not world-readable. ' +
          'Nothing private leaked (checked above), but a document can read them. Mitigations: keep secrets out of the ' +
          'compiler image (it has none), gVisor/bwrap, or a Lua io.open wrapper.')
      }
    })

    it('LuaTeX\'s socket library is not available (no network from a document)', () => {
      expectProbe(b, 'socket', ['refused'])
    })

    it('the climbing probes return to the project directory', () => {
      expect(b.probes.get('climb-restore'), 'a probe left the cwd outside the project').toBeUndefined()
      expect(b.probes.get('climb-up'), b.log.slice(-4000)).toBeDefined()
    })

    it(`relative lfs.chdir("..") then io.open/lfs.mkdir: a world-writable directory outside the project is a KNOWN GAP of LuaTeX (${TEX_LIVE})`, () => {
      const got = ['climb-write world-writable', 'climb-mkdir world-writable'].filter(l => b.probes.get(l) !== 'refused')
      for (const l of got) expect(['WROTE', 'MKDIR'], `${l}: ${b.probes.get(l)}`).toContain(b.probes.get(l))
      if (got.length > 0) {
        expect(climbed(ww).length, 'the probe says it wrote, but nothing is there').toBeGreaterThan(0)
        knownGap('LuaTeX refuses absolute paths and "../" (openout_any=p), but not lfs.chdir("..") followed by relative names, so a ' +
          `document can create files and directories in ANY directory its uid may write (here: ${got.join(', ')}). ` +
          'Production depends on the OS boundary: the uid sandbox, and no world-writable directory in the compiler container ' +
          '(docker/compose.yaml: read-only root filesystem, /tmp mode 0700, ipc none). Closing it in TeX needs LuaTeX --safer or a Lua wrapper.')
      }
    })

    it.skipIf(!UID)(`relative lfs.chdir("..") cannot write where the project uid has no write permission (a directory of the worker, another project) [${NOT_UID}]`, () => {
      for (const t of ['locked', 'other-project']) {
        expectProbe(b, `climb-write ${t}`, ['refused'])
        expectProbe(b, `climb-mkdir ${t}`, ['refused'])
      }
      expect(climbed(locked)).toEqual([])
      expect(existsSync(join(builds, victim, 'src', climbFile))).toBe(false)
    })

    // CORPUS_NO_WORLD_WRITABLE=1: this host was prepared like the production container (CI job "sandbox"), so a write
    // into a system directory is a failure; elsewhere (a developer's machine with a normal /tmp) it is a warning.
    it.skipIf(!UID || SYSTEM_DIRS.length === 0)(`relative lfs.chdir("..") cannot write into /tmp, /var/tmp or /dev/shm when, as in production, they are not world-writable [${NOT_UID}]`, () => {
      for (const [name, dir] of SYSTEM_DIRS) {
        if (!existsSync(dir)) continue
        const worldWritable = (statSync(dir).mode & 0o002) !== 0
        if (HOST_HARDENED) expect(worldWritable, `${dir} is world-writable although CORPUS_NO_WORLD_WRITABLE=1`).toBe(false)
        const got = [b.probes.get(`climb-write ${name}`), b.probes.get(`climb-mkdir ${name}`)]
        if (!worldWritable) {
          expect(got, `${dir}: ${got.join(', ')}`).toEqual(['refused', 'refused'])
          expect(climbed(dir)).toEqual([])
        } else if (got.some(r => r !== 'refused')) {
          knownGap(`this host's ${dir} is world-writable, so a document wrote into it by climbing (${got.join(', ')}). The production ` +
            'compiler container has no world-writable directory (docker/compose.yaml); set CORPUS_NO_WORLD_WRITABLE=1 on a host prepared like it.')
        }
      }
    })
  })

  /* ---------------------------------------------------------------------------------------- 5 */
  describe('5. \\openout outside the project', () => {
    it('to ../../evil.tex, an absolute path in a world-writable directory, and another project\'s src: all refused (pdflatex and lualatex)', async () => {
      const files = loadProject('05-openout-escape', vars)
      const runs: [string, Engine][] = [['dotdot.tex', 'pdflatex'], ['absolute.tex', 'pdflatex'], ['other.tex', 'pdflatex'],
        ['dotdot.tex', 'lualatex'], ['absolute.tex', 'lualatex']]
      for (const [main, engine] of runs) {
        const b = await build(`05 ${main} ${engine}`, randomUUID(), files, main, engine)
        expect(['failure', 'success']).toContain(b.status)
        expect(b.log, `${main} (${engine}): no refusal in the log`).toMatch(/openout_any|I can't write on file|Not writing to/)
      }
      expect(existsSync(join(builds, 'evil.tex'))).toBe(false)
      expect(existsSync(join(root, 'evil.tex'))).toBe(false)
      expect(existsSync(join(builds, victim, 'src', 'evil.tex'))).toBe(false)
    }, 5 * TEX_TIMEOUT)

    it('lualatex: \\openout after lfs.chdir("..") out of the project writes nothing outside it', async () => {
      const b = await build('05 climb lualatex', randomUUID(), loadProject('05-openout-escape', vars), 'climb.tex', 'lualatex')
      expect(b.probes.get('climb ww'), b.log.slice(-3000)).toBeDefined()
      expect(b.probes.get('home'), 'the document did not get back to its own directory').toBe('ok')
      const openout = `${climbFile}-openout.tex`
      expect(existsSync(join(ww, openout)), 'written into a world-writable directory outside the project').toBe(false)
      expect(existsSync(join(locked, openout)), 'written into a directory of the worker').toBe(false)
    }, TEX_TIMEOUT)
  })

  /* ---------------------------------------------------------------------------------------- 6 */
  describe('6. infinite loop', () => {
    it('ends with status timeout, the process group is killed and no process is left over', async () => {
      const id = randomUUID()
      const started = Date.now()
      const b = await build('06 loop', id, loadProject('06-infinite-loop', vars), 'main.tex', 'pdflatex', { timeoutMs: 5000 })
      expect(b.status).toBe('timeout')
      expect(Date.now() - started).toBeLessThan(5000 + 30_000)
      const uid = UID ? statSync(join(builds, id)).uid : undefined
      const gone = await eventually(() => strayProcesses(id, uid).length === 0, 10_000)
      expect(gone, `stray processes: ${JSON.stringify(strayProcesses(id, uid))}`).toBe(true)
      // The project is usable again right away.
      const again = await build('06 after', id, loadProject('11-latexmkrc', vars), 'main.tex', 'pdflatex')
      expect(again.status).toBe('success')
    }, 2 * TEX_TIMEOUT)
  })

  /* ---------------------------------------------------------------------------------------- 7 */
  describe('7. log flood', () => {
    it(`${FLOOD_LINES} \\message lines: the reported log is capped and the worker stays healthy`, async () => {
      const b = await build('07 flood', randomUUID(), loadProject('07-log-flood', vars), 'main.tex', 'pdflatex')
      expect(['success', 'failure', 'timeout']).toContain(b.status)
      expect(Buffer.byteLength(b.log)).toBeLessThanOrEqual(MAX_REPORTED_LOG)
      expect(b.files['output.log']?.length ?? 0).toBeLessThanOrEqual(MAX_REPORTED_LOG)
    }, TEX_TIMEOUT + 60_000)
  })

  /* ---------------------------------------------------------------------------------------- 8 */
  describe('8. huge output', () => {
    it('a PDF over the 100 MB cap is discarded, not served, and the worker stays healthy', async () => {
      const id = randomUUID()
      const b = await build('08 huge pdf', id, loadProject('08-huge-pdf', vars), 'main.tex', 'lualatex')
      expect(b.probes.get('big-object'), b.log.slice(-3000)).toBe('written')
      expect(b.status).toBe('failure')
      expect(b.outputs).not.toContain('output.pdf')
      expect(b.log).toMatch(/output\.pdf is \d+ bytes, over the 104857600 byte limit; discarded/)
      expect((await fetch(`${base}/projects/${id}/output/output.pdf`)).status).toBe(404)
    }, TEX_TIMEOUT)
  })

  /* ---------------------------------------------------------------------------------------- 9 */
  describe('9. process and file bombs', () => {
    it('a Lua fork bomb (io.popen / os.execute / os.spawn loop) starts no process', async () => {
      const id = randomUUID()
      const b = await build('09 fork', id, loadProject('09-process-and-file-bombs', vars), 'fork.tex', 'lualatex')
      expect(b.status, b.log.slice(-3000)).toBe('success')
      expect(b.probes.get('fork-started')).toBe('0')
      const uid = UID ? statSync(join(builds, id)).uid : undefined
      expect(strayProcesses(id, uid)).toEqual([])
    }, TEX_TIMEOUT)

    it(`a \\loop writing 20000 files is stopped by the file limit (${MAX_FILES}) and its files are deleted`, async () => {
      const id = randomUUID()
      const b = await build('09 files', id, loadProject('09-process-and-file-bombs', vars), 'files.tex', 'pdflatex')
      expect(b.status).toBe('failure')
      expect(b.log).toMatch(new RegExp(`more than ${MAX_FILES} files`))
      const left = readdirSync(join(builds, id, 'out')).filter(n => n.startsWith('many-'))
      expect(left).toEqual([])
    }, TEX_TIMEOUT)
  })

  /* ---------------------------------------------------------------------------------------- 10 */
  describe('10. symlinks planted in out/', () => {
    const id = randomUUID()
    let planted: Built
    let targets: string[]
    const before = new Map<string, string>()

    beforeAll(async () => {
      targets = UID ? ['/etc/shadow', vars.BLOB!] : [join(outside, 'decoy1.txt'), join(outside, 'decoy2.txt')]
      const dir = UID ? join(builds, '.blobs') : join(outside, 'decoydir')
      for (const t of targets) before.set(t, fileHash(t))
      planted = await build('10 plant', id, loadProject('10-symlink-in-out/plant', {
        ...vars, LINK_TARGET_1: fwd(targets[0]!), LINK_TARGET_2: fwd(targets[1]!), LINK_TARGET_DIR: fwd(dir),
      }), 'main.tex', 'lualatex')
    }, TEX_TIMEOUT)

    /** Linux CI must exercise this case: a skip there would hide that it went untested. */
    const plantedOrSkip = (skip: (note?: string) => void) => {
      if (planted.probes.get('link output.pdf') === 'CREATED') return true
      const why = `could not create symlinks here: ${planted.probes.get('link output.pdf') ?? 'no probe output'}`
      if (IN_CI && process.platform === 'linux') throw new Error(`case 10 cannot run on Linux CI: ${why}\n--- log tail ---\n${planted.log.slice(-3000)}`)
      skip(why)
      return false
    }

    it('the build that planted them reports and serves none of them; the targets are unchanged', async ({ skip }) => {
      if (!plantedOrSkip(skip)) return
      expect(planted.outputs).not.toContain('output.pdf')
      expect(planted.outputs).not.toContain('output.synctex.gz')
      expect((await fetch(`${base}/projects/${id}/output/output.pdf`)).status).toBe(404)
      expect((await fetch(`${base}/projects/${id}/output/output.synctex.gz`)).status).toBe(404)
      for (const t of targets) expect(fileHash(t), `${t} changed`).toBe(before.get(t))
    })

    it.skipIf(!UID)('the next build neither writes through nor serves them [uid sandbox only: with SANDBOX=none pdflatex runs with the worker\'s own rights and would write through the link]', async ({ skip }) => {
      if (!plantedOrSkip(skip)) return
      const next = await build('10 next', id, loadProject('10-symlink-in-out/next', vars), 'main.tex', 'pdflatex')
      for (const t of targets) expect(fileHash(t), `${t} changed`).toBe(before.get(t))
      expect(existsSync(join(builds, '.blobs', 'one.aux'))).toBe(false)
      if (next.files['output.pdf']) expect(next.files['output.pdf'].subarray(0, 5).toString('latin1')).toBe('%PDF-')
      const g = await fetch(`${base}/projects/${id}/output/output.pdf`)
      if (g.status === 200) expect(Buffer.from(await g.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    }, TEX_TIMEOUT)
  })

  /* ---------------------------------------------------------------------------------------- 11 */
  describe('11. latexmkrc in the project', () => {
    it('latexmkrc and .latexmkrc are not executed (-norc)', async () => {
      const b = await build('11 latexmkrc', randomUUID(), loadProject('11-latexmkrc', vars), 'main.tex', 'pdflatex')
      expect(b.status, b.log.slice(-3000)).toBe('success')
    }, TEX_TIMEOUT)
  })

  /* ---------------------------------------------------------------------------------------- 12 */
  describe('12. hostile main-file names', () => {
    const names = JSON.parse(readFileSync(join(CORPUS_DIR, '12-main-file-names', 'names.json'), 'utf8')) as { unbuildable: string[]; invalid: string[] }
    const doc = readFileSync(join(CORPUS_DIR, '12-main-file-names', 'doc.tex'), 'utf8')

    it.each(names.unbuildable)('%j is refused before anything is spawned (200, status failure)', async name => {
      const id = randomUUID()
      const files = { [name]: doc }
      await syncFiles(base, id, files)
      const r = await postJson(base, `/projects/${id}/compile`, { manifest: manifestOf(files), mainFile: name, engine: 'pdflatex' })
      expect(r.status).toBe(200)
      expect(r.json.status).toBe('failure')
      expect(r.json.outputs).toEqual([])
      expect(r.json.durationMs).toBe(0)
      expect(r.json.log).toMatch(/main file/)
      expect(existsSync(join(builds, id)), 'the project directory was created, so something ran').toBe(false)
    })

    it.each(names.invalid)('%j is a malformed request (400)', async name => {
      const id = randomUUID()
      const r = await postJson(base, `/projects/${id}/compile`, { manifest: { [name]: sha(doc) }, mainFile: name, engine: 'pdflatex' })
      expect(r.status).toBe(400)
      expect(existsSync(join(builds, id))).toBe(false)
    })
  })

  /* ---------------------------------------------------------------------------------------- end */
  describe('afterwards', () => {
    it('other projects are unaffected: the victim still compiles, its sources are intact', async () => {
      const v = await build('victim again', victim, victimFiles, 'main.tex', 'pdflatex', { allow: ['victim project'] })
      expect(v.status).toBe('success')
      expect(v.files['output.pdf']?.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(existsSync(join(builds, victim, 'src', 'evil.tex'))).toBe(false)
    }, TEX_TIMEOUT)

    it.skipIf(!UID)('every project directory is 0700 and owned by its own uid', () => {
      const owners = new Map<number, string>()
      for (const id of known) {
        if (id.startsWith('.') || !existsSync(join(builds, id))) continue
        const st = statSync(join(builds, id))
        expect(st.mode & 0o777, `${id} mode`).toBe(0o700)
        expect(st.uid).toBeGreaterThanOrEqual(100_000)
        expect(owners.get(st.uid), `uid ${st.uid} shared by ${id} and ${owners.get(st.uid)}`).toBeUndefined()
        owners.set(st.uid, id)
      }
      expect(owners.size).toBeGreaterThan(5)
    })
  })

  /** uid mode: the helper (run as a project uid) must be able to read its own sources. */
  function preflightUid(): void {
    const r = spawnSync(process.execPath, ['-e', `require('node:fs').accessSync(${JSON.stringify(HELPER_PATH)}, 4)`],
      { uid: 65534, gid: 65534, encoding: 'utf8' })
    if (r.status === 0) return
    const chain: string[] = []
    for (let d = dirname(HELPER_PATH); ; d = dirname(d)) {
      try { chain.push(`${(statSync(d).mode & 0o7777).toString(8).padStart(4, '0')} ${d}`) } catch { chain.push(`? ${d}`) }
      if (dirname(d) === d) break
    }
    throw new Error(`SANDBOX=uid: an unprivileged uid cannot read the helper ${HELPER_PATH}, so every compile would fail.\n` +
      `Make the checkout world-readable (chmod o+rx on each directory below, a+r on the files):\n${chain.join('\n')}\n${r.stderr}`)
  }
}
