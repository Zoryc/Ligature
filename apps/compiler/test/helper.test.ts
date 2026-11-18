// The helper process and the worker's distrust of it.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Channel } from '../src/protocol.ts'
import { defaultHelperArgv } from '../src/runner.ts'
import { alive, compile, eventually, FAKE_LATEXMK, sha, startTestWorker } from './harness.ts'

const EVIL = fileURLToPath(new URL('./fixtures/evil-helper.mjs', import.meta.url))

describe('helper process', () => {
  it('rejects content that does not match its hash and writes nothing usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ligature-helper-'))
    const [cmd, ...args] = defaultHelperArgv()
    const child = spawn(cmd!, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    const ch = new Channel(child.stdout, child.stdin)
    const H = sha('real content')
    await ch.send({
      t: 'job', dir, manifest: { 'main.tex': H }, mainFile: 'main.tex', engine: 'pdflatex', clean: false, timeoutMs: 5000,
      latexmk: [process.execPath, FAKE_LATEXMK], limitPrefix: [], quota: { bytes: 1 << 30, entries: 100_000 },
    })
    expect(await ch.recv()).toEqual({ t: 'need', hashes: [H] })
    await ch.send({ t: 'blob', hash: H, size: 5 })
    await ch.sendData(5, [Buffer.from('wrong')])
    const m = await ch.recv()
    expect(m?.t).toBe('error')
    expect(String(m?.message)).toMatch(/does not match its hash/)
    const code = await new Promise(r => child.on('close', r))
    expect(code).toBe(1)
    expect(readdirSync(join(dir, 'out'))).toEqual([])
  })
})

describe('worker distrusts the helper', () => {
  it.each(['badname', 'bigsize', 'foreign', 'crash'])('%s -> status error, nothing published', async mode => {
    const t = await startTestWorker({ helperArgv: [process.execPath, EVIL, mode] })
    try {
      const id = randomUUID()
      const r = await compile(t.base, id, { 'main.tex': 'x' })
      expect(r.status).toBe(200)
      expect(r.json.status).toBe('error')
      expect(r.json.outputs).toEqual([])
      expect(existsSync(join(t.buildsDir, 'escape'))).toBe(false)
      expect(readdirSync(join(t.buildsDir, '.outputs', id))).toEqual([])
    } finally {
      await t.w.close()
    }
  })

  it('a helper that stays alive after reporting success is killed', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'ligature-linger-')), 'pid')
    const t = await startTestWorker({ helperArgv: [process.execPath, EVIL, 'linger', pidFile] })
    try {
      const started = Date.now()
      const r = await compile(t.base, randomUUID(), { 'main.tex': 'x' })
      expect(r.json.status).toBe('success')
      expect(Date.now() - started).toBeLessThan(8000)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      expect(pid).toBeGreaterThan(0)
      // killed before the response was sent (allow the OS a moment to tear it down)
      expect(await eventually(() => !alive(pid), 3000)).toBe(true)
    } finally {
      await t.w.close()
    }
  })

  it('a missing latexmk binary is status error with a clear log', async () => {
    const t = await startTestWorker({ latexmk: [join(tmpdir(), 'definitely-not-latexmk-' + randomUUID())] })
    try {
      const r = await compile(t.base, randomUUID(), { 'main.tex': 'x' })
      expect(r.json.status).toBe('error')
      expect(r.json.log).toContain('could not run latexmk')
    } finally {
      await t.w.close()
    }
  })
})
