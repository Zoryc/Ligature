import type { Context } from 'hono'
import { ApiError } from '../errors.ts'

/* Raw request/response body helpers (uploads, zip import/export). */

/** The declared Content-Length of an upload, checked against `max` (nothing is read yet). */
export function declaredLength(c: Context, max: number, what = 'Uploads'): number {
  const lenHeader = c.req.header('content-length')
  if (lenHeader === undefined || !/^[0-9]+$/.test(lenHeader)) throw new ApiError(411, 'length-required', 'Content-Length is required')
  const len = Number(lenHeader)
  if (len > max) throw new ApiError(413, 'too-large', `${what} are limited to ${Math.round(max / 1048576)} MB`)
  return len
}

/** A deadline for receiving a body: `graceMs` plus the time the declared length takes at `minBytesPerSec`. */
export interface BodyDeadline { graceMs: number; minBytesPerSec: number }

export const bodyDeadlineMs = (len: number, d: BodyDeadline): number => d.graceMs + Math.ceil(len / d.minBytesPerSec * 1000)

/**
 * Read a raw request body of exactly `len` bytes. Memory grows with the bytes that actually arrive
 * (never pre-allocated from the declared length). A client abort is a 400, not a server error. With a
 * `deadline`, a body that has not fully arrived in time is a `408 request-timeout` (a client trickling
 * bytes cannot hold whatever the caller holds while reading).
 */
export async function readRawBody(c: Context, len: number, deadline?: BodyDeadline): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let off = 0
  const body = c.req.raw.body
  if (body) {
    const reader = body.getReader()
    let timedOut = false
    const timer = deadline
      ? setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}) }, bodyDeadlineMs(len, deadline))
      : null
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (timedOut) break
        if (done) break
        if (off + value.byteLength > len) throw new ApiError(400, 'bad-request', 'Body longer than Content-Length')
        chunks.push(value)
        off += value.byteLength
      }
    } catch (e) {
      if (e instanceof ApiError) throw e
      if (!timedOut) throw new ApiError(400, 'bad-request', 'Upload aborted')
    } finally {
      if (timer) clearTimeout(timer)
      if (timedOut || off !== len) reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    if (timedOut) throw new ApiError(408, 'request-timeout', 'The upload was too slow; try again')
  }
  if (off !== len) throw new ApiError(400, 'bad-request', 'Body shorter than Content-Length')
  return Buffer.concat(chunks, len)
}

/** `attachment|inline; filename="ascii"; filename*=UTF-8''pct` (RFC 6266 / 5987). */
export function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
