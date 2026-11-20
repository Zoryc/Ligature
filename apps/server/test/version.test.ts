import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.ts'
import { VERSION } from '../src/version.ts'
import { Client, openInstance, signup } from './inproc.ts'

const rootVersion = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version

describe('version', () => {
  it('is the root package.json version, and every workspace package carries the same one', () => {
    expect(VERSION).toBe(rootVersion)
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    for (const p of ['apps/server', 'apps/web', 'apps/compiler', 'packages/shared', 'packages/latex-log-parser', 'packages/synctex']) {
      const v = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', p, 'package.json'), 'utf8')) as { version: string }).version
      expect(v, p).toBe(rootVersion)
    }
  })

  it('ligature --version prints it', async () => {
    let out = ''
    const io = { stdin: Readable.from([]), stdout: { write: (s: string) => { out += s } }, stderr: { write: () => {} }, env: {} }
    expect(await main(['--version'], io)).toBe(0)
    expect(out).toBe(`ligature ${rootVersion}\n`)
  })

  it('only admins can read it: GET /api/admin/about; never in the public instance info', async () => {
    const { ts, admin } = await openInstance(39720)
    try {
      expect((await admin.get('/api/admin/about')).body).toEqual({ version: rootVersion })
      const user = await signup(ts.base, 'someone')
      expect((await user.get('/api/admin/about')).status).toBe(403)
      expect((await new Client(ts.base).get('/api/admin/about')).status).toBe(401)
      const instance = JSON.stringify((await new Client(ts.base).get('/api/instance')).body)
      expect(instance).not.toContain(rootVersion)
      expect(instance).not.toContain('version')
    } finally {
      await ts.stop()
    }
  })

  it('CHANGELOG.md has an entry for it', () => {
    const changelog = readFileSync(join(import.meta.dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8')
    expect(changelog).toContain(`## ${rootVersion}`)
  })
})
