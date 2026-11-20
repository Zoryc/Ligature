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

  /** For log lines: the socket path or host:port. */
  get address(): string {
    return this.socketPath ?? `${this.host}:${this.port}`
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
      req.on('error', e => reject(toUnreachable(e, this.address)))
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

  async health(timeoutMs = 3000): Promise<boolean> {
    try { return (await this.call('GET', '/healthz', undefined, undefined, timeoutMs)).status === 200 } catch { return false }
  }
}

/**
 * Socket-level failures to reach the compiler (container down, socket missing, connection dropped):
 * expected during an outage, so callers log them as one line and do not count them as a build.
 */
const UNREACHABLE_CODES = new Set([
  'ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EACCES', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
])

export class CompilerUnreachableError extends Error {
  // Plain fields, not constructor parameter properties: apps/compiler typechecks this file with
  // erasableSyntaxOnly (its test imports the client).
  readonly code: string
  readonly address: string

  constructor(code: string, address: string, options?: ErrorOptions) {
    super(`compiler unreachable (${code} ${address})`, options)
    this.name = 'CompilerUnreachableError'
    this.code = code
    this.address = address
  }
}

function toUnreachable(e: Error, address: string): Error {
  const code = (e as NodeJS.ErrnoException).code
  return code !== undefined && UNREACHABLE_CODES.has(code) ? new CompilerUnreachableError(code, address, { cause: e }) : e
}

/**
 * Logs "compiler unreachable" at most once per `intervalMs`: during an outage every compile fails the
 * same way, and a stack trace per request would bury everything else in the log. The next line logged
 * says how many were left out.
 */
export function unreachableLogger(intervalMs = 60_000, now: () => number = Date.now,
  log: (line: string) => void = line => console.error(line)): (e: CompilerUnreachableError) => void {
  let lastAt = -Infinity
  let suppressed = 0
  return e => {
    const t = now()
    if (t - lastAt < intervalMs) { suppressed++; return }
    const more = suppressed > 0 ? ` (${suppressed} more since the last report)` : ''
    log(`[compile] ${e.message}: compile refused${more}`)
    lastAt = t
    suppressed = 0
  }
}
