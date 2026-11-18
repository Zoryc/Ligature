import { parentPort } from 'node:worker_threads'
import { gunzipSync } from 'node:zlib'
import { parseSynctex, type SynctexIndex } from '@ligature/synctex'

/*
 * Worker thread for SyncTeX parsing (gunzip + parse take ~1-2 s for the largest files we accept), so the
 * server's event loop never blocks on it. Erasable TypeScript only: Node runs this file directly.
 *
 * In:  { id, gz: Uint8Array, maxBytes, maxRecords? }
 * Out: { id, index } with the typed arrays transferred, or { id, error } when the file is unusable.
 */

export interface ParseRequest { id: number; gz: Uint8Array; maxBytes: number; maxRecords?: number }
export type ParseReply = { id: number; index: SynctexIndex } | { id: number; error: string }

const COLUMNS = ['kind', 'tag', 'line', 'column', 'page', 'parent', 'depth', 'h', 'v', 'width', 'height', 'depthBelow'] as const

export function parseInWorker(req: ParseRequest): { reply: ParseReply; transfer: ArrayBuffer[] } {
  try {
    const text = gunzipSync(req.gz, { maxOutputLength: req.maxBytes }).toString('utf8')
    const index = parseSynctex(text, {
      maxChars: req.maxBytes,
      ...(req.maxRecords !== undefined ? { maxRecords: req.maxRecords } : {}),
    })
    const transfer: ArrayBuffer[] = []
    for (const k of COLUMNS) {
      const buf = index[k].buffer
      if (buf instanceof ArrayBuffer && !transfer.includes(buf)) transfer.push(buf)
    }
    return { reply: { id: req.id, index }, transfer }
  } catch (e) {
    return { reply: { id: req.id, error: e instanceof Error ? e.message : String(e) }, transfer: [] }
  }
}

if (parentPort) {
  const port = parentPort
  port.on('message', (req: ParseRequest) => {
    const { reply, transfer } = parseInWorker(req)
    port.postMessage(reply, transfer)
  })
}
