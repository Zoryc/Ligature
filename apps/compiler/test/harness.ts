import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWorker, type RunningWorker } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import type { Manifest } from '../src/contract.ts'

export const FAKE_LATEXMK = fileURLToPath(new URL('./fixtures/fake-latexmk.mjs', import.meta.url))
export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

export interface TestWorker { w: RunningWorker; base: string; buildsDir: string }

export async function startTestWorker(opts: { latexmk?: string[]; helperArgv?: string[]; env?: Record<string, string> } = {}): Promise<TestWorker> {
  const buildsDir = mkdtempSync(join(tmpdir(), 'ligature-builds-'))
  const cfg = loadConfig({ COMPILER_LISTEN: 'tcp:127.0.0.1:0', BUILDS_DIR: buildsDir, SANDBOX: 'none', ...opts.env })
  cfg.latexmk = opts.latexmk ?? [process.execPath, FAKE_LATEXMK]
  const w = await startWorker(cfg, { env: { ...process.env, NODE_ENV: 'test' }, helperArgv: opts.helperArgv })
  const port = Number(w.address.split(':').at(-1))
  return { w, base: `http://127.0.0.1:${port}`, buildsDir }
}

export const manifestOf = (files: Record<string, string>): Manifest =>
  Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha(c)]))

export async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, json: text ? JSON.parse(text) : null }
}

export async function putBlob(base: string, hash: string, data: string | Buffer): Promise<number> {
  const r = await fetch(`${base}/blobs/${hash}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: typeof data === 'string' ? data : new Uint8Array(data) })
  await r.arrayBuffer()
  return r.status
}

/** sync + upload the missing blobs; returns the manifest and which hashes were uploaded. */
export async function syncFiles(base: string, projectId: string, files: Record<string, string>): Promise<{ manifest: Manifest; uploaded: string[] }> {
  const manifest = manifestOf(files)
  const s = await postJson(base, `/projects/${projectId}/sync`, { manifest })
  if (s.status !== 200) throw new Error(`sync ${s.status} ${JSON.stringify(s.json)}`)
  const byHash = new Map(Object.values(files).map(c => [sha(c), c]))
  for (const h of s.json.missing as string[]) {
    const st = await putBlob(base, h, byHash.get(h)!)
    if (st !== 204) throw new Error(`put ${st}`)
  }
  return { manifest, uploaded: s.json.missing }
}

export async function compile(base: string, projectId: string, files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const { manifest, uploaded } = await syncFiles(base, projectId, files)
  const r = await postJson(base, `/projects/${projectId}/compile`, { manifest, mainFile: 'main.tex', engine: 'pdflatex', ...extra })
  return { ...r, uploaded }
}

/** Whether a process with this pid exists (signal 0 only checks). */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Wait until `cond` holds, up to `ms`. */
export async function eventually(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return cond()
}
