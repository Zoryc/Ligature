// The real entrypoint (src/worker.ts) under plain Node type stripping, as it runs in the container.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultHelperArgv } from '../src/runner.ts'

const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url))
const HEALTHCHECK = fileURLToPath(new URL('../src/healthcheck.ts', import.meta.url))
const nodeArgs = defaultHelperArgv().slice(1, -1) // type-stripping flags, if this Node needs them

function run(env: Record<string, string>, untilListening = false): Promise<{ code: number | null; out: string; port?: number; kill?: () => void }> {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [...nodeArgs, WORKER], {
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', BUILDS_DIR: mkdtempSync(join(tmpdir(), 'ligature-ep-')), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const onData = (d: Buffer) => {
      out += d
      const m = /listening on tcp:[^ ]+:(\d+)/.exec(out)
      if (untilListening && m) resolve({ code: null, out, port: Number(m[1]), kill: () => p.kill() })
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.on('close', code => resolve({ code, out }))
  })
}

describe('worker entrypoint', () => {
  it('starts in dev mode and answers /healthz', async () => {
    const r = await run({ COMPILER_LISTEN: 'tcp:127.0.0.1:0' }, true)
    try {
      expect(r.port).toBeGreaterThan(0)
      const h = await fetch(`http://127.0.0.1:${r.port}/healthz`)
      expect(await h.json()).toEqual({ ok: true, sandbox: 'none' })
    } finally {
      r.kill?.()
    }
  })

  it('the container healthcheck probes the listener named by COMPILER_LISTEN', async () => {
    const r = await run({ COMPILER_LISTEN: 'tcp:127.0.0.1:0' }, true)
    try {
      const check = (listen: string) => new Promise<number | null>(resolve => {
        const p = spawn(process.execPath, [...nodeArgs, HEALTHCHECK], {
          env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', COMPILER_LISTEN: listen }, stdio: 'ignore',
        })
        p.on('close', resolve)
      })
      expect(await check(`tcp:127.0.0.1:${r.port}`)).toBe(0)
      r.kill?.()
      await new Promise(res => setTimeout(res, 300))
      expect(await check(`tcp:127.0.0.1:${r.port}`)).toBe(1)
      expect(await check('nonsense')).toBe(1)
    } finally {
      r.kill?.()
    }
  })

  it('refuses a non-loopback TCP listener without ALLOW_TCP=1 (development too)', async () => {
    const r = await run({ COMPILER_LISTEN: 'tcp:0.0.0.0:0' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/non-loopback/)
  })

  it('refuses SANDBOX=none in production', async () => {
    const r = await run({ NODE_ENV: 'production', SANDBOX: 'none', COMPILER_LISTEN: 'tcp:127.0.0.1:0', ALLOW_TCP: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/development only/)
  })

  it('refuses a TCP listener in production without ALLOW_TCP=1', async () => {
    const r = await run({ NODE_ENV: 'production', COMPILER_LISTEN: 'tcp:127.0.0.1:0' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/Refusing a TCP listener/)
  })

  it.skipIf(process.platform === 'linux')('SANDBOX=uid fails clearly off Linux', async () => {
    const r = await run({ SANDBOX: 'uid', COMPILER_LISTEN: 'tcp:127.0.0.1:0' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/needs Linux/)
  })
})
