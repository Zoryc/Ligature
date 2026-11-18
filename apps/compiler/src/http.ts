/**
 * HTTP transport for the contract in packages/shared/src/compile.ts. Plain node:http, no framework.
 *
 *   GET  /healthz                         -> 200 { ok, sandbox }
 *   POST /projects/:id/sync               SyncRequest    -> SyncResponse
 *   PUT  /blobs/:sha256                   raw bytes      -> 204 (sha256 verified)
 *   POST /projects/:id/compile            CompileRequest -> CompileResponse   (409 { missing } if blobs are absent)
 *   GET  /projects/:id/output/:name       -> raw bytes | 404
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { isHash, isOutputName, isUuid } from './contract.ts'
import { BlobError } from './blobStore.ts'
import { MAX_BLOB_BYTES, MAX_JSON_BYTES } from './limits.ts'

const DRAIN_LIMIT = 2 * MAX_BLOB_BYTES
import { MissingBlobsError, type CompilerService } from './service.ts'
import { parseCompileRequest, parseSyncRequest } from './validate.ts'

class HttpError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>
  constructor(status: number, error: string, message?: string, extra: Record<string, unknown> = {}) {
    super(message ?? error)
    this.status = status
    this.body = { error, ...(message ? { message } : {}), ...extra }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length })
  res.end(data)
}

function declaredLength(req: IncomingMessage, max: number): void {
  const cl = req.headers['content-length']
  if (cl !== undefined && (!/^\d+$/.test(cl) || Number(cl) > max)) throw new HttpError(413, 'too-large', `body larger than ${max} bytes`)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const ct = req.headers['content-type'] ?? ''
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'unsupported-media-type', 'expected application/json')
  declaredLength(req, MAX_JSON_BYTES)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_JSON_BYTES) throw new HttpError(413, 'too-large', `body larger than ${MAX_JSON_BYTES} bytes`)
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad-request', 'body is not valid JSON')
  }
}

const CONTENT_TYPES: Record<string, string> = {
  'output.pdf': 'application/pdf',
  'output.log': 'text/plain; charset=utf-8',
  'output.synctex.gz': 'application/gzip',
}

export function createHandler(svc: CompilerService): (req: IncomingMessage, res: ServerResponse) => void {
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    // Path only; query strings are ignored. Segments are compared raw (no percent-decoding), so an
    // encoded "../" simply fails validation.
    const path = (req.url ?? '/').split('?')[0]!
    const seg = path.split('/').slice(1)
    const only = (m: string) => { if (method !== m) throw new HttpError(405, 'method-not-allowed') }

    if (path === '/healthz') {
      only('GET')
      return sendJson(res, 200, { ok: true, sandbox: svc.sandboxKind })
    }

    if (seg[0] === 'blobs' && seg.length === 2) {
      only('PUT')
      const hash = seg[1]!
      if (!isHash(hash)) throw new HttpError(400, 'bad-request', 'invalid hash')
      declaredLength(req, MAX_BLOB_BYTES)
      await svc.putBlob(hash, req)
      res.writeHead(204)
      res.end()
      return
    }

    if (seg[0] === 'projects' && seg.length >= 3) {
      const id = seg[1]!
      if (!isUuid(id)) throw new HttpError(400, 'bad-request', 'invalid project id')

      if (seg.length === 3 && seg[2] === 'sync') {
        only('POST')
        const body = parseSyncRequest(await readJson(req))
        if (!body.ok) throw new HttpError(400, 'bad-request', body.error)
        return sendJson(res, 200, { missing: await svc.sync(body.value.manifest) })
      }

      if (seg.length === 3 && seg[2] === 'compile') {
        only('POST')
        const body = parseCompileRequest(await readJson(req), svc.maxTimeoutMs)
        if (body.ok === false) throw new HttpError(400, 'bad-request', body.error)
        // A main file that cannot be built is the user's mistake: a normal failure result that says why.
        if (body.ok === 'unbuildable') return sendJson(res, 200, await svc.rejectMainFile(id, body.value.problem))
        return sendJson(res, 200, await svc.compile(id, body.value))
      }

      if (seg.length === 4 && seg[2] === 'output') {
        only('GET')
        const name = seg[3]!
        if (!isOutputName(name)) throw new HttpError(404, 'not-found', 'unknown output')
        const f = await svc.output(id, name)
        if (!f) throw new HttpError(404, 'not-found', 'no such output')
        try {
          res.writeHead(200, {
            'content-type': CONTENT_TYPES[name] ?? 'application/octet-stream',
            'content-length': f.size,
            'x-content-type-options': 'nosniff',
          })
          if (f.size > 0) await pipeline(f.fh.createReadStream({ start: 0, end: f.size - 1, autoClose: false }), res)
          else res.end()
        } finally {
          await f.fh.close()
        }
        return
      }
    }

    throw new HttpError(404, 'not-found')
  }

  return (req, res) => {
    route(req, res).catch((e: unknown) => {
      let status = 500
      let body: Record<string, unknown> = { error: 'internal' }
      if (e instanceof HttpError) { status = e.status; body = e.body }
      else if (e instanceof BlobError) {
        status = e.code === 'too-large' ? 413 : 400
        body = { error: e.code === 'too-large' ? 'too-large' : 'hash-mismatch', message: e.message }
      } else if (e instanceof MissingBlobsError) {
        status = 409
        body = { error: 'missing-blobs', missing: e.missing }
      } else {
        console.error('[compiler] internal error', e)
      }
      if (res.headersSent) { res.destroy(); return }
      if (!req.complete && !req.destroyed) {
        // Rejected before the body was read (e.g. Content-Length too large): discard the rest so the client
        // can read our answer instead of getting a connection reset, but never more than a bounded amount.
        let drained = 0
        req.on('data', (c: Buffer) => { drained += c.length; if (drained > DRAIN_LIMIT) req.destroy() })
        req.resume()
      }
      sendJson(res, status, body)
    })
  }
}

export function createHttpServer(svc: CompilerService): Server {
  const server = createServer(createHandler(svc))
  // A compile response can take minutes; the request itself is small. Keep the defaults for receiving
  // requests but never time out an idle socket while a compile runs.
  server.timeout = 0
  return server
}
