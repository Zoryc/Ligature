import { Hono, type Context } from 'hono'
import type { ImportResponse } from '@ligature/shared'
import { ApiError } from '../../errors.ts'
import { requireAccess, validateProjectName } from '../../projects/service.ts'
import { exportZipStream } from '../../zip/exporter.ts'
import { importProject } from '../../zip/importer.ts'
import { contentDisposition, declaredLength, readRawBody } from '../body.ts'
import type { Env, RouteDeps } from '../context.ts'

const rateLimited = () => new ApiError(429, 'rate-limited', 'Upload volume limit reached; try again later')

/** The Node response behind a request (when served by @hono/node-server), to cut off a stalled client. */
function destroyConnection(c: Context<Env>): void {
  const env = c.env as { outgoing?: { destroy(): void } } | undefined
  env?.outgoing?.destroy()
}

/** Zip import and export (docs/M2.md §5). */
export function zipRoutes(deps: RouteDeps): Hono<Env> {
  const app = new Hono<Env>()

  // Exports stream one slice of one file at a time, behind a small gate (per user and per process); a
  // client that stops reading is cut off after `exportIdleMs`, which frees its slot.
  app.get('/projects/:id/export.zip', async c => {
    const userId = c.get('user').id
    requireAccess(deps.db, c.req.param('id'), userId)
    const release = await deps.limiters.exportGate.acquire(userId)
    let streaming = false
    try {
      const a = requireAccess(deps.db, c.req.param('id'), userId) // again: access may have changed while waiting
      const { name, stream } = exportZipStream(deps, a.projectId, {
        idleMs: deps.limiters.exportIdleMs, onDone: release, onIdle: () => destroyConnection(c),
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

  // Import, in two phases: the body is received behind its own gate with a deadline (a trickled body
  // cannot hold a processing slot, and frees its own slot at the deadline), then the archive is
  // processed behind the import gate.
  app.post('/projects/import', async c => {
    const user = c.get('user')
    validateProjectName(c.req.query('name') ?? '') // fail fast, before reading the body
    const len = declaredLength(c, deps.limits.maxImportBytes, 'Imports')
    // Imports share the per-user upload byte budget: the request bytes now, and what the archive
    // extracts to (beyond the request bytes) once it is known, before anything is written.
    if (!deps.limiters.uploadBytes.consume(user.id, len)) throw rateLimited()
    let zip: Buffer
    let release: () => void
    const releaseBody = await deps.limiters.importBodyGate.acquire(user.id)
    try {
      const body = await readRawBody(c, len, deps.limiters.importBodyDeadline)
      zip = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
      // The body slot is held until processing starts, so received archives waiting for a processing
      // slot stay bounded by the body gate.
      release = await deps.limiters.importGate.acquire(user.id)
    } finally {
      releaseBody()
    }
    try {
      const charge = (bytes: number) => {
        if (!deps.limiters.uploadBytes.consume(user.id, Math.max(0, bytes - len))) throw rateLimited()
      }
      return c.json(await importProject(deps, user, c.req.query('name'), zip, { charge }) satisfies ImportResponse)
    } finally {
      release()
    }
  })

  return app
}
