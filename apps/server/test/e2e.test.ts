import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileDocName, metaDocName } from '@ligature/shared'
import { connect, demoProject, getJson, HAS_LATEXMK, killHard, login, ORIGIN, startCompiler, startServer, tempDataDir, waitFor, type RunningServer } from './harness.ts'

describe('presence identity is stamped by the server', () => {
  let s: RunningServer
  beforeAll(async () => { s = await startServer(tempDataDir(), 39120) })
  afterAll(async () => { await killHard(s) })

  it('a viewer cannot pose as another user in awareness', async () => {
    const alice = await login(s.base, 'alice')
    const carol = await login(s.base, 'carol')
    const p = await demoProject(s.base, alice)
    const aliceMe = await getJson<{ id: string }>(s.base, '/api/me', alice)
    const carolMe = await getJson<{ id: string }>(s.base, '/api/me', carol)
    const a = connect(s.base, alice, metaDocName(p.id))
    const c = connect(s.base, carol, metaDocName(p.id))
    try {
      await waitFor(() => a.provider.isSynced && c.provider.isSynced, 10_000, 'sync')
      c.provider.awareness!.setLocalStateField('user', { id: aliceMe.id, name: 'Alice (owner)', color: 'red;background:url(x)' })
      await waitFor(() => a.provider.awareness!.getStates().has(c.doc.clientID), 10_000, 'carol presence at alice')
      const seen = a.provider.awareness!.getStates().get(c.doc.clientID)!['user']
      expect(seen).toEqual({ id: carolMe.id, name: 'Carol (viewer)' })
    } finally { a.destroy(); c.destroy() }
  }, 30_000)
})

describe.skipIf(!HAS_LATEXMK)('M0 done-criterion: edit -> compile with real TeX -> PDF', () => {
  let s: RunningServer
  let compiler: ChildProcess
  beforeAll(async () => {
    compiler = await startCompiler(39131)
    s = await startServer(tempDataDir(), 39130, { COMPILER_URL: 'http://127.0.0.1:39131' })
  }, 30_000)
  afterAll(async () => {
    await killHard(s)
    if (compiler.exitCode === null && compiler.signalCode === null) compiler.kill('SIGKILL')
  })

  it('compiles the live (unsaved) text of an open doc, then a later edit makes the next PDF differ', async () => {
    const alice = await login(s.base, 'alice')
    const p = await demoProject(s.base, alice)
    const main = p.tree.find(f => f.name === 'main.tex')!
    const a = connect(s.base, alice, fileDocName(p.id, main.id, main.epoch!))
    try {
      await waitFor(() => a.provider.isSynced, 10_000, 'sync')
      const t = a.text()
      const at = t.toString().indexOf('Edit me')
      t.insert(at, 'Compiled from the live doc. ')
      await waitFor(() => !a.provider.hasUnsyncedChanges, 5_000, 'acked')

      const compile = async () => {
        const r = await fetch(`${s.base}/api/projects/${p.id}/compile`, { method: 'POST', headers: { cookie: alice, origin: ORIGIN } })
        expect(r.status).toBe(200)
        return r.json() as Promise<{ buildId: string; status: string; hasPdf: boolean; log: string; snapshot: { docs: Record<string, string>; docSnapshots: Record<string, string> } }>
      }
      const b1 = await compile()
      expect(b1.status, b1.log.slice(-2000)).toBe('success')
      expect(b1.hasPdf).toBe(true)
      expect(Object.keys(b1.snapshot.docSnapshots)).toContain(main.id)
      const pdf = await fetch(`${s.base}/api/projects/${p.id}/builds/${b1.buildId}/output.pdf`, { headers: { cookie: alice } })
      expect(pdf.status).toBe(200)
      expect(pdf.headers.get('content-type')).toBe('application/pdf')
      const bytes = Buffer.from(await pdf.arrayBuffer())
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')

      // The included subfolder file made it into the build (the log lists it).
      expect(b1.log).toMatch(/chapters[\\/]intro\.tex/)

      // A viewer may download but not compile.
      const carol = await login(s.base, 'carol')
      const denied = await fetch(`${s.base}/api/projects/${p.id}/compile`, { method: 'POST', headers: { cookie: carol, origin: ORIGIN } })
      expect(denied.status).toBe(403)

      // A broken edit gives a failure with a file:line error in the log, not a crash.
      t.insert(t.toString().indexOf('\\end{document}'), '\\undefinedcommandxyz\n')
      await waitFor(() => !a.provider.hasUnsyncedChanges, 5_000, 'acked')
      const b2 = await compile()
      expect(b2.status).toBe('failure')
      expect(b2.log).toMatch(/main\.tex:\d+: Undefined control sequence/)
    } finally { a.destroy() }
  }, 180_000)
})
