/**
 * Length-prefixed binary framing used on the pipes between the worker and the sandbox helper.
 *
 *   frame  = type:u8  length:u32be  payload[length]
 *   type 1 = CONTROL  payload is UTF-8 JSON (a protocol message, see protocol.ts)
 *   type 2 = DATA     payload is raw bytes belonging to the stream announced by the preceding CONTROL
 *
 * Payload sizes are bounded per type; anything else (unknown type, oversize length) is a protocol error
 * and the decoder stops for good.
 */
import type { Readable, Writable } from 'node:stream'
import { DATA_CHUNK_BYTES, MAX_CONTROL_BYTES } from './limits.ts'

export const FRAME_CONTROL = 1
export const FRAME_DATA = 2
export type FrameType = typeof FRAME_CONTROL | typeof FRAME_DATA
export interface Frame { type: FrameType; payload: Buffer }

const HEADER = 5

export interface FrameLimits { control: number; data: number }
export const DEFAULT_LIMITS: FrameLimits = { control: MAX_CONTROL_BYTES, data: DATA_CHUNK_BYTES }

export function encodeFrame(type: FrameType, payload: Buffer, limits: FrameLimits = DEFAULT_LIMITS): Buffer {
  const max = type === FRAME_CONTROL ? limits.control : limits.data
  if (payload.length > max) throw new Error(`frame payload too large (${payload.length} > ${max})`)
  const head = Buffer.allocUnsafe(HEADER)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

export class FrameError extends Error {}

/** Incremental decoder: push arbitrary chunks, pull complete frames. */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private buffered = 0
  private failed: FrameError | null = null
  private readonly limits: FrameLimits

  constructor(limits: FrameLimits = DEFAULT_LIMITS) {
    this.limits = limits
  }

  push(chunk: Buffer): void {
    if (this.failed) throw this.failed
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.buffered += chunk.length
  }

  /** Next complete frame, or null if more bytes are needed. Throws FrameError on malformed input. */
  next(): Frame | null {
    if (this.failed) throw this.failed
    if (this.buffered < HEADER) return null
    const head = this.peek(HEADER)
    const type = head.readUInt8(0)
    const len = head.readUInt32BE(1)
    if (type !== FRAME_CONTROL && type !== FRAME_DATA) return this.fail(`unknown frame type ${type}`)
    const max = type === FRAME_CONTROL ? this.limits.control : this.limits.data
    if (len > max) return this.fail(`frame payload too large (${len} > ${max})`)
    if (this.buffered < HEADER + len) return null
    const all = this.take(HEADER + len)
    return { type, payload: all.subarray(HEADER) }
  }

  /** Bytes received but not yet returned as a frame. */
  get pending(): number { return this.buffered }

  private fail(msg: string): never {
    this.failed = new FrameError(msg)
    throw this.failed
  }

  private peek(n: number): Buffer {
    const first = this.chunks[0]!
    if (first.length >= n) return first.subarray(0, n)
    const joined = Buffer.concat(this.chunks)
    this.chunks = [joined]
    return joined.subarray(0, n)
  }

  private take(n: number): Buffer {
    let first = this.chunks[0]!
    if (first.length < n) {
      first = Buffer.concat(this.chunks)
      this.chunks = [first]
    }
    const out = first.subarray(0, n)
    if (first.length === n) this.chunks.shift()
    else this.chunks[0] = first.subarray(n)
    this.buffered -= n
    return out
  }
}

/** Async iteration over the frames of a readable stream; pulling lazily gives natural backpressure. */
export async function* readFrames(stream: Readable, limits: FrameLimits = DEFAULT_LIMITS): AsyncGenerator<Frame> {
  const dec = new FrameDecoder(limits)
  for await (const chunk of stream) {
    dec.push(chunk as Buffer)
    for (let f = dec.next(); f; f = dec.next()) yield f
  }
  if (dec.pending > 0) throw new FrameError('stream ended in the middle of a frame')
}

/** Write one frame, waiting for 'drain' when the stream is backed up. */
export function writeFrame(stream: Writable, type: FrameType, payload: Buffer, limits: FrameLimits = DEFAULT_LIMITS): Promise<void> {
  const buf = encodeFrame(type, payload, limits)
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) { reject(new Error('stream closed')); return }
    const onError = (e: Error) => { stream.off('drain', onDrain); reject(e) }
    const onDrain = () => { stream.off('error', onError); resolve() }
    if (stream.write(buf)) { resolve(); return }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}
