import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { fileDocName, type TreeEntry } from '@ligature/shared'
import { ApiError, notFound } from '../../errors.ts'
import { TEXT_KEY } from '../../collab/docStore.ts'
import { contentTypeOf, inlineImageType } from '../../files/classify.ts'
import { createNode, deleteNode, requireNode, treeRows, updateNode } from '../../files/tree.ts'
import { uploadFile } from '../../files/upload.ts'
import { requireAccess } from '../../projects/service.ts'
import { readJson, type Env, type RouteDeps } from '../context.ts'

const createSchema = z.strictObject({
  parentId: z.string().max(64),
  name: z.string().max(1024),
  kind: z.enum(['folder', 'text']),
  content: z.string().optional(),
})
const updateSchema = z.strictObject({ name: z.string().max(1024).optional(), parentId: z.string().max(64).optional() })

/** The declared Content-Length of an upload, checked against `max` (nothing is read yet). */
function declaredLength(c: Context, max: number): number {
  const lenHeader = c.req.header('content-length')
  if (lenHeader === undefined || !/^[0-9]+$/.test(lenHeader)) throw new ApiError(411, 'length-required', 'Content-Length is required')
  const len = Number(lenHeader)
  if (len > max) throw new ApiError(413, 'too-large', `Uploads are limited to ${Math.round(max / 1048576)} MB`)
  return len
}

/**
 * Read a raw request body of exactly `len` bytes. Memory grows with the bytes that actually arrive
 * (never pre-allocated from the declared length). A client abort is a 400, not a server error.
 */
async function readRawBody(c: Context, len: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let off = 0
  const body = c.req.raw.body
  if (body) {
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        if (off + chunk.byteLength > len) throw new ApiError(400, 'bad-request', 'Body longer than Content-Length')
        chunks.push(chunk)
        off += chunk.byteLength
      }
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw new ApiError(400, 'bad-request', 'Upload aborted')
    }
  }
  if (off !== len) throw new ApiError(400, 'bad-request', 'Body shorter than Content-Length')
  return Buffer.concat(chunks, len)
}

/** `attachment|inline; filename="ascii"; filename*=UTF-8''pct` (RFC 6266 / 5987). */
function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export function fileRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  app.post('/projects/:id/files', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    const body = await readJson(c, createSchema)
    return c.json(createNode(deps, a, body) satisfies TreeEntry)
  })

  app.patch('/projects/:id/files/:fileId', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    const body = await readJson(c, updateSchema)
    return c.json(updateNode(deps, a, c.req.param('fileId'), body) satisfies TreeEntry)
  })

  app.delete('/projects/:id/files/:fileId', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    await deleteNode(deps, c.get('user'), a, c.req.param('fileId'))
    return c.json({ ok: true })
  })

  app.post('/projects/:id/upload', async c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    if (a.role === 'viewer') throw new ApiError(403, 'forbidden')
    const user = c.get('user')
    const len = declaredLength(c, deps.limits.maxUploadBytes)
    // Per-user byte budget: blobs are never collected in M1, so this bounds how fast one account can
    // grow the disk (replace loops, delete + re-upload).
    if (!deps.limiters.uploadBytes.consume(user.id, len)) {
      throw new ApiError(429, 'rate-limited', 'Upload volume limit reached; try again later')
    }
    const release = await deps.limiters.uploadGate.acquire(user.id)
    let bytes: Uint8Array
    try {
      bytes = await readRawBody(c, len)
    } finally {
      release()
    }
    const entry = await uploadFile(deps, user, a, c.req.query('parentId'), c.req.query('name'), bytes)
    return c.json(entry satisfies TreeEntry)
  })

  app.get('/projects/:id/files/:fileId/raw', c => {
    const a = requireAccess(db, c.req.param('id'), c.get('user').id)
    const f = requireNode(treeRows(db, a.projectId), c.req.param('fileId'))
    if (f.kind === 'folder') throw notFound()
    const headers: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-cache',
    }
    if (f.kind === 'text') {
      const name = fileDocName(a.projectId, f.id, f.epoch)
      const live = deps.collab.liveDoc(name)
      const text = live ? live.getText(TEXT_KEY).toString() : deps.store.storedText(name)?.text ?? ''
      const body = Buffer.from(text, 'utf8')
      headers['content-type'] = 'text/plain; charset=utf-8'
      headers['content-disposition'] = contentDisposition('attachment', f.name)
      headers['content-length'] = String(body.byteLength)
      return new Response(body as Uint8Array<ArrayBuffer>, { headers })
    }
    // Binary: streamed from disk (blobs can be 50 MB; never load them whole per request).
    const size = f.blobHash ? deps.blobs.sizeOf(f.blobHash) : null
    if (size === null || !f.blobHash) throw notFound('blob missing')
    const image = inlineImageType(f.name)
    const inline = c.req.query('inline') === '1' && image !== null
    headers['content-type'] = image ?? contentTypeOf(f.name)
    headers['content-disposition'] = contentDisposition(inline ? 'inline' : 'attachment', f.name)
    headers['content-length'] = String(size)
    return new Response(Readable.toWeb(createReadStream(deps.blobs.pathOf(f.blobHash))) as ReadableStream, { headers })
  })

  return app
}
