/**
 * Tail-capping of TeX logs (a runaway document can produce gigabytes of log).
 *
 * Every function here returns a string whose UTF-8 encoding is at most `max` bytes. TeX logs are not
 * always valid UTF-8 (pdflatex writes raw 8-bit characters, and line wrapping splits multi-byte
 * sequences); each invalid byte decodes to U+FFFD, which re-encodes to 3 bytes, so the cap is applied
 * AFTER decoding, never to the raw byte count alone.
 */
import { openRegular } from './fsSafe.ts'

/** Room kept for the truncation notice. */
const NOTICE_RESERVE = 128
/** When cutting, skip forward to the next line start if one is this close, so the log starts on a whole line. */
const LINE_SEEK = 4096

function notice(totalBytes: number, keptBytes: number): string {
  return `[ligature: log truncated, showing the last ${keptBytes} of ${totalBytes} bytes]\n`
}

/** Index of the first byte at or after `i` that starts a UTF-8 sequence (enc is valid UTF-8). */
function charStart(enc: Buffer, i: number): number {
  while (i < enc.length && (enc[i]! & 0xc0) === 0x80) i++
  return i
}

/** The longest tail of `text` whose UTF-8 encoding fits in `max` bytes (cut on a character boundary). */
export function fitUtf8Tail(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  const enc = Buffer.from(text, 'utf8')
  return enc.subarray(charStart(enc, enc.length - Math.max(0, max))).toString('utf8')
}

/**
 * Decode `bytes`, the last bytes of a log that is `totalBytes` long, keeping at most `max` UTF-8 bytes
 * of text that end at the real end of the log, behind a one-line notice if anything was dropped.
 */
function decodeTail(bytes: Buffer, totalBytes: number, max: number): string {
  const text = bytes.toString('utf8')
  const complete = bytes.length >= totalBytes
  if (complete && Buffer.byteLength(text, 'utf8') <= max) return text
  const enc = Buffer.from(text, 'utf8')
  let start = Math.max(0, enc.length - Math.max(0, max - NOTICE_RESERVE))
  // Whatever precedes `start` is gone, so the line at `start` is partial: begin at the next line if close.
  const nl = enc.subarray(start, start + LINE_SEEK).indexOf(0x0a)
  start = nl >= 0 ? start + nl + 1 : charStart(enc, start)
  const body = enc.subarray(start)
  return notice(totalBytes, body.length) + body.toString('utf8')
}

/** Keep at most the last `max` bytes of `buf` as text (including a one-line truncation notice). */
export function capTail(buf: Buffer, max: number): string {
  return decodeTail(buf, buf.length, max)
}

/** Read the capped tail of a regular file (never following symlinks). Null if it does not exist. */
export async function readTail(path: string, max: number): Promise<string | null> {
  const f = await openRegular(path)
  if (!f) return null
  try {
    const want = f.size <= max ? f.size : Math.max(0, max - NOTICE_RESERVE)
    const buf = Buffer.alloc(want)
    const { bytesRead } = await f.fh.read(buf, 0, want, f.size - want)
    return decodeTail(buf.subarray(0, bytesRead), f.size, max)
  } finally {
    await f.fh.close()
  }
}

/** Bounded in-memory tail buffer for a process's stdout/stderr. */
export class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  private total = 0
  private readonly max: number

  constructor(max: number) { this.max = max }

  push(chunk: Buffer): void {
    this.total += chunk.length
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.max) {
      this.size -= this.chunks.shift()!.length
    }
  }

  text(): string {
    const all = Buffer.concat(this.chunks)
    const keep = this.total <= this.max ? all : all.subarray(Math.max(0, all.length - Math.max(0, this.max - NOTICE_RESERVE)))
    return decodeTail(keep, this.total, this.max)
  }
}
