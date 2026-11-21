import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'
import { fileDocName, type TreeEntry } from '@ligature/shared'
import { ApiError, notFound } from '../../errors.ts'
import { TEXT_KEY } from '../../collab/docStore.ts'
import { contentTypeOf, inlineImageType } from '../../files/classify.ts'
import { createNode, deleteNode, requireNode, treeRows, updateNode } from '../../files/tree.ts'
import { uploadFile } from '../../files/upload.ts'
import { requireAccess } from '../../projects/service.ts'
import { readJson, type Env, type RouteDeps } from '../context.ts'
import { contentDisposition, declaredLength, readRawBody } from '../body.ts'

const createSchema = z.strictObject({
  parentId: z.string().max(64),
  name: z.string().max(1024),
  kind: z.enum(['folder', 'text']),
  content: z.string().optional(),
})
const updateSchema = z.strictObject({ name: z.string().max(1024).optional(), parentId: z.string().max(64).optional() })

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
      // Lets the project page's text loader revalidate cheaply (Cache-Control: no-cache already makes the
      // browser ask every time): an unchanged file costs a 304 instead of its whole text.
      headers.etag = textEtag(f.name, body)
      if (etagMatches(c.req.header('if-none-match'), headers.etag)) return new Response(null, { status: 304, headers })
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

/**
 * Strong ETag of a text file's download. The name is hashed too because a 304 keeps the cached
 * Content-Disposition: after a rename the client must get the new filename, not the old one.
 */
function textEtag(name: string, body: Buffer): string {
  const h = createHash('sha256').update(name, 'utf8').update('\0').update(body).digest('hex')
  return `"${h.slice(0, 32)}"`
}

/**
 * If-None-Match uses the weak comparison (RFC 9110 13.1.2): `W/` prefixes are ignored and only the opaque
 * tags are compared. `*` matches any existing representation. Unparseable parts never match.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  const want = etag.replace(/^W\//, '')
  // Entity tags may themselves contain commas, so pick quoted tags out instead of splitting on ','.
  for (const m of header.matchAll(/(?:W\/)?("[^"]*")/g)) {
    if (m[1] === want) return true
  }
  return false
}
