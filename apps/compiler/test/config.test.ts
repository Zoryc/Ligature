import { describe, expect, it } from 'vitest'
import { loadConfig, parseLatexmk, parseListen } from '../src/config.ts'
import { isSandboxUid, preferredUid, UID_BASE, UID_RANGE, UidAllocator } from '../src/sandbox/projectUid.ts'
import { createNoneSandbox } from '../src/sandbox/none.ts'
import { createUidSandbox } from '../src/sandbox/uid.ts'

describe('config', () => {
  it('parses listeners', () => {
    expect(parseListen('unix:/run/ligature/compiler.sock')).toEqual({ kind: 'unix', path: '/run/ligature/compiler.sock' })
    expect(parseListen('tcp:127.0.0.1:7071')).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 7071 })
    expect(parseListen('tcp:[::1]:0')).toEqual({ kind: 'tcp', host: '::1', port: 0 })
    for (const bad of ['unix:relative.sock', 'tcp:127.0.0.1', 'tcp:host:99999', 'http://127.0.0.1:7071', '']) {
      expect(() => parseListen(bad)).toThrow()
    }
  })

  it('dev defaults', () => {
    const c = loadConfig({})
    expect(c.listen).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 7071 })
    expect(c.sandbox).toBe('none')
    expect(c.latexmk).toEqual(['latexmk'])
    expect(c.buildsDir.endsWith('builds')).toBe(true)
  })

  it('production defaults and the TCP refusal', () => {
    const c = loadConfig({ NODE_ENV: 'production' })
    expect(c.listen).toEqual({ kind: 'unix', path: '/run/ligature/compiler.sock' })
    expect(c.sandbox).toBe('uid')
    expect(() => loadConfig({ NODE_ENV: 'production', COMPILER_LISTEN: 'tcp:127.0.0.1:7071' })).toThrow(/TCP/)
    expect(loadConfig({ NODE_ENV: 'production', COMPILER_LISTEN: 'tcp:127.0.0.1:7071', ALLOW_TCP: '1' }).listen.kind).toBe('tcp')
  })

  it('refuses a non-loopback TCP listener without ALLOW_TCP=1, in development too', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '[::]', 'example.org']) {
      expect(() => loadConfig({ COMPILER_LISTEN: `tcp:${host}:7071` }), host).toThrow(/non-loopback/)
      expect(loadConfig({ COMPILER_LISTEN: `tcp:${host}:7071`, ALLOW_TCP: '1' }).listen.kind).toBe('tcp')
    }
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '[::1]']) {
      expect(loadConfig({ COMPILER_LISTEN: `tcp:${host}:7071` }).listen.kind, host).toBe('tcp')
    }
  })

  it('disk and cache limits', () => {
    const d = loadConfig({})
    expect(d.quota).toEqual({ bytes: 1024 * 1024 * 1024, entries: 100_000 })
    expect(d.blobCache).toEqual({ maxBytes: 2048 * 1024 * 1024, maxAgeMs: 72 * 3600_000 })
    expect(d.buildDirMaxIdleMs).toBe(7 * 24 * 3600_000)
    expect(d.minFreeBytes).toBe(1024 * 1024 * 1024)
    const c = loadConfig({ PROJECT_DISK_QUOTA_MB: '5', PROJECT_MAX_FILES: '10', BLOB_CACHE_MAX_MB: '0', BUILDS_MIN_FREE_MB: '0' })
    expect(c.quota).toEqual({ bytes: 5 * 1024 * 1024, entries: 10 })
    expect(c.blobCache.maxBytes).toBe(0)
    expect(c.minFreeBytes).toBe(0)
    for (const bad of [{ PROJECT_DISK_QUOTA_MB: '0' }, { PROJECT_DISK_QUOTA_MB: '-1' }, { BLOB_CACHE_MAX_MB: '1.5' }, { BUILD_DIR_MAX_IDLE_DAYS: 'x' }]) {
      expect(() => loadConfig(bad), JSON.stringify(bad)).toThrow()
    }
  })

  it('validates the rest', () => {
    expect(() => loadConfig({ SANDBOX: 'docker' })).toThrow(/SANDBOX/)
    expect(() => loadConfig({ COMPILER_SOCKET_GID: '100001' })).toThrow()
    expect(loadConfig({ COMPILER_SOCKET_GID: '1000' }).socketGid).toBe(1000)
    expect(parseLatexmk('/usr/bin/latexmk')).toEqual(['/usr/bin/latexmk'])
    expect(parseLatexmk('["node","C:\\\\x\\\\fake.mjs"]')).toEqual(['node', 'C:\\x\\fake.mjs'])
    expect(() => parseLatexmk('[]')).toThrow()
    expect(() => parseLatexmk('[1]')).toThrow()
  })
})

describe('sandboxes', () => {
  const P1 = '85043672-fc4b-4a10-81fd-34afaeb30e00'
  const P2 = 'e4efee72-09bf-4ff6-b4d5-737872cee5af'
  const P3 = '0f9ae8a4-7a43-4c42-9d3a-1c4b1c9c6a11'

  it('preferred project uid is stable, in range, and differs between projects', () => {
    const a = preferredUid(P1)
    expect(preferredUid(P1)).toBe(a)
    expect(a).toBeGreaterThanOrEqual(UID_BASE)
    expect(a).toBeLessThan(UID_BASE + UID_RANGE)
    expect(preferredUid(P2)).not.toBe(a)
    // Documented formula: 100000 + first 4 bytes of sha256 (big-endian) mod 2^20.
    expect(preferredUid('')).toBe(100_000 + (0xe3b0c442 % 2 ** 20))
  })

  it('uid allocation never gives two projects the same uid', () => {
    const u = new UidAllocator()
    // P2's directory already exists and is owned by the uid P1 would prefer (a collision)
    expect(u.adopt(P2, preferredUid(P1))).toBe(true)
    const a = u.allocate(P1)
    expect(a).not.toBe(preferredUid(P1))
    expect(a).toBe(UID_BASE + ((preferredUid(P1) - UID_BASE + 1) % UID_RANGE))
    expect(u.allocate(P1)).toBe(a) // stable
    expect(u.get(P2)).toBe(preferredUid(P1))
    // a uid that belongs to another project is not adopted; nor is one outside the range
    expect(u.adopt(P3, a)).toBe(false)
    expect(u.adopt(P3, 0)).toBe(false)
    expect(u.adopt(P3, 1000)).toBe(false)
    expect(u.get(P3)).toBeUndefined()
    const c = u.allocate(P3)
    expect(new Set([a, c, u.get(P2)]).size).toBe(3)
    // released uids can be reused
    u.release(P2)
    expect(u.get(P2)).toBeUndefined()
    expect(u.adopt(P3, preferredUid(P1))).toBe(true)
    expect(u.get(P3)).toBe(preferredUid(P1))
    expect(isSandboxUid(UID_BASE)).toBe(true)
    expect(isSandboxUid(UID_BASE + UID_RANGE)).toBe(false)
  })

  it("'uid' refuses to start when latexmk does not run (it would only show up behind prlimit)", async () => {
    const s = createUidSandbox({ platform: 'linux', getuid: () => 0, prlimit: false, latexmk: ['definitely-not-latexmk-ligature'] })
    await expect(s.init('unused')).rejects.toThrow(/latexmk-ligature -v` failed/)
  })

  it("'none' refuses production", async () => {
    await expect(createNoneSandbox({ NODE_ENV: 'production' }).init('unused')).rejects.toThrow(/development only/)
  })

  it("'uid' refuses non-Linux and non-root, with clear errors", async () => {
    await expect(createUidSandbox({ platform: 'win32' }).init('unused')).rejects.toThrow(/needs Linux/)
    await expect(createUidSandbox({ platform: 'darwin' }).init('unused')).rejects.toThrow(/needs Linux/)
    await expect(createUidSandbox({ platform: 'linux', getuid: () => 1000 }).init('unused')).rejects.toThrow(/root/)
  })

  it("'uid' identity and limits", () => {
    const s = createUidSandbox({ platform: 'linux', env: { PATH: '/usr/bin', SECRET: 'x' } })
    // the uid is assigned by prepareProject (Linux + root only); never guessed
    expect(() => s.identity(P1)).toThrow(/prepareProject first/)
    expect(s.helperEnv()).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' })
    const p = s.limitPrefix(90_000)
    expect(p[0]).toBe('prlimit')
    expect(p.at(-1)).toBe('--')
    expect(p).toContain('--cpu=95')
    expect(createUidSandbox({ prlimit: false }).limitPrefix(1000)).toEqual([])
  })
})
