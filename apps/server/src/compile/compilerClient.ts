import { request } from 'node:http'
import type { CompileRequest, CompileResponse, OutputName, SyncResponse } from '@ligature/shared'

/**
 * HTTP client for the compiler worker.
 *  - production: `unix:/run/ligature/compiler.sock` (the compiler container has no network at all)
 *  - development: `http://127.0.0.1:7071` (dev-only TCP listener, e.g. app on Windows, compiler in Docker/WSL)
 */
export class CompilerClient {
  private readonly socketPath?: string
  private readonly host?: string
  private readonly port?: number

  constructor(url: string) {
    if (url.startsWith('unix:')) this.socketPath = url.slice('unix:'.length)
    else {
      const u = new URL(url)
      if (u.protocol !== 'http:') throw new Error(`unsupported compiler URL ${url}`)
      this.host = u.hostname
      this.port = Number(u.port || 80)
    }
  }

  private call(method: string, path: string, body?: Buffer | string, contentType = 'application/json',
    timeoutMs = 180_000): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request({
        method, path, socketPath: this.socketPath, host: this.host, port: this.port,
        headers: body !== undefined ? { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } : {},
        timeout: timeoutMs,
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('compiler request timed out')))
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  private async json<T>(method: string, path: string, payload: unknown): Promise<T> {
    const r = await this.call(method, path, JSON.stringify(payload))
    if (r.status < 200 || r.status >= 300) throw new Error(`compiler ${method} ${path}: ${r.status} ${r.body.toString().slice(0, 500)}`)
    return JSON.parse(r.body.toString()) as T
  }

  sync(projectId: string, manifest: Record<string, string>): Promise<SyncResponse> {
    return this.json('POST', `/projects/${projectId}/sync`, { manifest })
  }

  async putBlob(hash: string, data: Buffer): Promise<void> {
    const r = await this.call('PUT', `/blobs/${hash}`, data, 'application/octet-stream')
    if (r.status !== 204) throw new Error(`compiler PUT blob ${hash}: ${r.status} ${r.body.toString().slice(0, 200)}`)
  }

  compile(projectId: string, req: CompileRequest): Promise<CompileResponse> {
    return this.json('POST', `/projects/${projectId}/compile`, req)
  }

  async output(projectId: string, name: OutputName): Promise<Buffer | null> {
    const r = await this.call('GET', `/projects/${projectId}/output/${name}`)
    if (r.status === 404) return null
    if (r.status !== 200) throw new Error(`compiler GET output ${name}: ${r.status}`)
    return r.body
  }

  async health(): Promise<boolean> {
    try { return (await this.call('GET', '/healthz', undefined, undefined, 3000)).status === 200 } catch { return false }
  }
}
