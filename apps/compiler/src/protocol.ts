/**
 * Messages exchanged between the worker and the sandbox helper over framing.ts.
 *
 *   worker -> helper   job                              (what to build)
 *   helper -> worker   need { hashes }                  (contents it does not have on disk)
 *   worker -> helper   blob { hash, size } + DATA...    (once per needed hash)
 *   worker -> helper   blobs-done
 *   helper -> worker   result { status, durationMs, log, outputs[] }
 *   helper -> worker   output { name, size } + DATA...  (once per entry of outputs[])
 *   helper -> worker   done
 *   helper -> worker   error { message }                (any time; the helper then exits)
 *
 * The helper runs as the project's sandbox uid, i.e. in the same security domain as the TeX run,
 * so the worker treats everything it receives as untrusted and validates it (see runner.ts).
 */
import type { Readable, Writable } from 'node:stream'
import type { CompileStatus, Engine, Manifest, OutputName } from './contract.ts'
import { FRAME_CONTROL, FRAME_DATA, FrameError, readFrames, writeFrame, type Frame } from './framing.ts'
import { DATA_CHUNK_BYTES } from './limits.ts'

export interface JobMsg {
  t: 'job'
  /** absolute project directory; the helper chdirs there itself (see runner.ts for why) */
  dir: string
  manifest: Manifest
  mainFile: string
  engine: Engine
  clean: boolean
  timeoutMs: number
  /** argv prefix for latexmk (e.g. ['latexmk'] or ['node', 'fake-latexmk.mjs']) */
  latexmk: string[]
  /** optional argv prefix that applies resource limits, e.g. ['prlimit', '--as=...', '--'] */
  limitPrefix: string[]
  /** what a build may write on top of the sources (bytes, number of files and folders) */
  quota: { bytes: number; entries: number }
}
export interface NeedMsg { t: 'need'; hashes: string[] }
export interface BlobMsg { t: 'blob'; hash: string; size: number }
export interface BlobsDoneMsg { t: 'blobs-done' }
export interface OutputInfo { name: OutputName; size: number }
export interface ResultMsg { t: 'result'; status: CompileStatus; durationMs: number; log: string; outputs: OutputInfo[] }
export interface OutputMsg { t: 'output'; name: OutputName; size: number }
export interface DoneMsg { t: 'done' }
export interface ErrorMsg { t: 'error'; message: string }

export type Message = JobMsg | NeedMsg | BlobMsg | BlobsDoneMsg | ResultMsg | OutputMsg | DoneMsg | ErrorMsg

export class ProtocolError extends Error {}

/** A bidirectional message channel over a pair of byte streams. */
export class Channel {
  private readonly frames: AsyncGenerator<Frame>
  private readonly out: Writable

  constructor(input: Readable, out: Writable) {
    this.frames = readFrames(input)
    this.out = out
  }

  send(msg: Message): Promise<void> {
    return writeFrame(this.out, FRAME_CONTROL, Buffer.from(JSON.stringify(msg), 'utf8'))
  }

  /** Send exactly `size` bytes from `source` as DATA frames. */
  async sendData(size: number, source: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>): Promise<void> {
    let sent = 0
    for await (const raw of source) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      for (let off = 0; off < chunk.length; off += DATA_CHUNK_BYTES) {
        const part = chunk.subarray(off, off + DATA_CHUNK_BYTES)
        sent += part.length
        if (sent > size) throw new ProtocolError(`data source longer than announced size ${size}`)
        await writeFrame(this.out, FRAME_DATA, part)
      }
    }
    if (sent !== size) throw new ProtocolError(`data source shorter than announced size (${sent} < ${size})`)
  }

  /** Next CONTROL message as a plain object with a string `t`. Returns null at clean end of stream. */
  async recv(): Promise<Record<string, unknown> & { t: string } | null> {
    const r = await this.nextFrame()
    if (!r) return null
    if (r.type !== FRAME_CONTROL) throw new ProtocolError('expected a control frame')
    let v: unknown
    try { v = JSON.parse(r.payload.toString('utf8')) } catch { throw new ProtocolError('control frame is not JSON') }
    if (typeof v !== 'object' || v === null || Array.isArray(v) || typeof (v as { t?: unknown }).t !== 'string') {
      throw new ProtocolError('control message without a type')
    }
    return v as Record<string, unknown> & { t: string }
  }

  /** Receive exactly `size` bytes of DATA frames, handing each chunk to `sink` (awaited: backpressure). */
  async recvData(size: number, sink: (chunk: Buffer) => Promise<void> | void): Promise<void> {
    let got = 0
    while (got < size) {
      const r = await this.nextFrame()
      if (!r) throw new ProtocolError('stream ended inside a data stream')
      if (r.type !== FRAME_DATA) throw new ProtocolError('expected a data frame')
      got += r.payload.length
      if (got > size) throw new ProtocolError('more data than announced')
      await sink(r.payload)
    }
  }

  private async nextFrame(): Promise<Frame | null> {
    try {
      const r = await this.frames.next()
      return r.done ? null : r.value
    } catch (e) {
      if (e instanceof FrameError) throw new ProtocolError(e.message)
      throw e
    }
  }
}
