import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'
import { can, type RestoreVersionResponse, type VersionDetail, type VersionDiff, type VersionPage, type VersionSummary } from '@ligature/shared'
import { ApiError, badRequest, notFound } from '../../errors.ts'
import { contentTypeOf, inlineImageType } from '../../files/classify.ts'
import { requireAccess, requireRole } from '../../projects/service.ts'
import { restoreVersion } from '../../history/restore.ts'
import {
  createNamedVersion, DEFAULT_PAGE, labelVersion, listVersions, MAX_PAGE, versionDetail, versionDiff, versionExport,
  versionFile,
} from '../../history/service.ts'
import { zipItemsStream } from '../../zip/exporter.ts'
import { contentDisposition } from '../body.ts'
import { readJson, type Env, type RouteDeps } from '../context.ts'

const createSchema = z.strictObject({ label: z.string().max(1000) })
const updateSchema = z.strictObject({ label: z.string().max(1000).nullable() })
const restoreSchema = z.strictObject({ paths: z.array(z.string().max(1024)).min(1).max(5000).optional() })

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PAGE
  if (!/^[0-9]{1,4}$/.test(raw)) throw badRequest(`limit: 1–${MAX_PAGE}`)
  const n = Number(raw)
  if (n < 1 || n > MAX_PAGE) throw badRequest(`limit: 1–${MAX_PAGE}`)
  return n
}

/** Throws 429 when `key` is over its budget (counts the request otherwise). */
function limit(limiter: { consume(key: string): boolean }, key: string, what: string): void {
  if (!limiter.consume(key)) throw new ApiError(429, 'rate-limited', `Too many ${what}; try again in a few minutes`)
}

/** Version history routes (docs/M3.md §2). */
export function versionRoutes(deps: RouteDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()
  const access = (id: string | undefined, userId: string) => requireAccess(db, id, userId)

  app.get('/projects/:id/versions', c => {
    const a = access(c.req.param('id'), c.get('user').id)
    return c.json(listVersions(deps, a, c.req.query('before'), parseLimit(c.req.query('limit'))) satisfies VersionPage,
      200, { 'cache-control': 'private, no-cache' })
  })

  app.post('/projects/:id/versions', async c => {
    const a = access(c.req.param('id'), c.get('user').id)
    const { label } = await readJson(c, createSchema)
    requireRole(a, can.edit)
    limit(deps.limiters.versionWrite, a.userId, 'new versions and restores')
    return c.json(createNamedVersion(deps, c.get('user'), a, label) satisfies VersionSummary)
  })

  app.patch('/projects/:id/versions/:versionId', async c => {
    const a = access(c.req.param('id'), c.get('user').id)
    const { label } = await readJson(c, updateSchema)
    return c.json(labelVersion(deps, c.get('user'), a, c.req.param('versionId'), label) satisfies VersionSummary)
  })

  app.get('/projects/:id/versions/:versionId', c => {
    const a = access(c.req.param('id'), c.get('user').id)
    return c.json(versionDetail(deps, a, c.req.param('versionId')) satisfies VersionDetail)
  })

  /** A file's content in a version: same safe headers as the M1 raw route, streamed from the blob store. */
  app.get('/projects/:id/versions/:versionId/file', c => {
    const a = access(c.req.param('id'), c.get('user').id)
    const f = versionFile(deps, a, c.req.param('versionId'), c.req.query('path'))
    // Never loaded whole per request (binaries can be 50 MB).
    const size = deps.blobs.sizeOf(f.hash)
    if (size === null) throw notFound('content missing')
    const name = f.path.slice(f.path.lastIndexOf('/') + 1)
    const headers: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      // As the raw route: nothing stays in the browser cache after logout, removal or thinning.
      'cache-control': 'private, no-cache',
      // Revalidation is cheap: the content of a (version, path) is addressed by its hash.
      etag: `"${f.hash}"`,
    }
    if (f.kind === 'text') {
      headers['content-type'] = 'text/plain; charset=utf-8'
      headers['content-disposition'] = contentDisposition('attachment', name)
    } else {
      const image = inlineImageType(name)
      const inline = c.req.query('inline') === '1' && image !== null
      headers['content-type'] = image ?? contentTypeOf(name)
      headers['content-disposition'] = contentDisposition(inline ? 'inline' : 'attachment', name)
    }
    if ((c.req.header('if-none-match') ?? '').split(',').some(t => t.trim().replace(/^W\//, '') === headers.etag)) {
      return new Response(null, { status: 304, headers })
    }
    headers['content-length'] = String(size)
    return new Response(Readable.toWeb(createReadStream(deps.blobs.pathOf(f.hash))) as ReadableStream, { headers })
  })

  app.get('/projects/:id/versions/:versionId/diff', c => {
    const a = access(c.req.param('id'), c.get('user').id)
    // A diff against the live state snapshots the whole project (synchronously): budgeted per user.
    if (c.req.param('versionId') === 'current' || c.req.query('against') === 'current') {
      limit(deps.limiters.liveDiff, a.userId, 'comparisons with the current state')
    }
    return c.json(versionDiff(deps, a, c.req.param('versionId'), c.req.query('against')) satisfies VersionDiff,
      200, { 'cache-control': 'private, no-cache' })
  })

  app.post('/projects/:id/versions/:versionId/restore', async c => {
    const a = access(c.req.param('id'), c.get('user').id)
    // An empty body means "the whole project".
    const body = (await c.req.text()).trim() === '' ? {} : await readJson(c, restoreSchema)
    requireRole(a, can.edit)
    limit(deps.limiters.versionWrite, a.userId, 'new versions and restores')
    return c.json(await restoreVersion(deps, c.get('user'), a, c.req.param('versionId'), body) satisfies RestoreVersionResponse)
  })

  /** The zip of a version: same gate, idle timeout and headers as the M2 project export. */
  app.get('/projects/:id/versions/:versionId/export.zip', async c => {
    const userId = c.get('user').id
    access(c.req.param('id'), userId)
    const release = await deps.limiters.exportGate.acquire(userId)
    let streaming = false
    try {
      const a = access(c.req.param('id'), userId) // again: access may have changed while waiting
      const { name, items } = versionExport(deps, a, c.req.param('versionId'))
      const stream = zipItemsStream(deps, items, {
        idleMs: deps.limiters.exportIdleMs, onDone: release, missingBlob: 'fail',
        onIdle: () => (c.env as { outgoing?: { destroy(): void } } | undefined)?.outgoing?.destroy(),
      })
      streaming = true
      return new Response(stream, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': contentDisposition('attachment', name),
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        },
      })
    } finally {
      if (!streaming) release()
    }
  })

  return app
}
