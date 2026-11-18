// End-to-end: the app's real client (apps/server/src/compile/compilerClient.ts) against this worker.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CompilerClient } from '../../server/src/compile/compilerClient.ts'
import { manifestOf, sha, startTestWorker, type TestWorker } from './harness.ts'

let t: TestWorker
beforeAll(async () => { t = await startTestWorker() })
afterAll(async () => { await t.w.close() })

describe('CompilerClient from apps/server', () => {
  it('health, sync, putBlob, compile, output', async () => {
    const client = new CompilerClient(t.base)
    expect(await client.health()).toBe(true)

    const id = randomUUID()
    const files: Record<string, string> = { 'main.tex': 'Hello \\input{body}', 'body.tex': 'body' }
    const manifest = manifestOf(files)
    const { missing } = await client.sync(id, manifest)
    expect(missing.length).toBe(2)
    for (const h of missing) await client.putBlob(h, Buffer.from(Object.values(files).find(c => sha(c) === h)!))
    expect((await client.sync(id, manifest)).missing).toEqual([])

    const res = await client.compile(id, { manifest, mainFile: 'main.tex', engine: 'pdflatex', timeoutMs: 90_000 })
    expect(res.status).toBe('success')
    expect(res.outputs).toContain('output.pdf')
    const pdf = await client.output(id, 'output.pdf')
    expect(pdf?.subarray(0, 8).toString()).toBe('%PDF-1.5')
    expect(await client.output(randomUUID(), 'output.pdf')).toBeNull()
    await expect(client.putBlob(sha('a'), Buffer.from('b'))).rejects.toThrow(/400/)
  })

  it('health is false when nothing listens', async () => {
    expect(await new CompilerClient('http://127.0.0.1:1').health()).toBe(false)
  })
})
