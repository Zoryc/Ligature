import { crc32 } from 'node:zlib'
import { Deflate, deflateSync } from 'fflate'

/*
 * Hostile-zip fixtures (docs/M2.md §6): a tiny ZIP writer with full control over every header field,
 * so tests can build malformed and malicious archives in memory instead of committing binaries.
 */

export interface CraftEntry {
  /** Entry name; a Uint8Array is written as raw bytes. */
  name: string | Uint8Array
  data?: Uint8Array | string
  /** 0 = stored, 8 = deflate (default), anything else is written as-is. */
  method?: number
  /** Use these bytes as the compressed data instead of compressing `data`. */
  compressed?: Uint8Array
  /** Uncompressed size written in the headers (default: the real size). */
  declaredSize?: number
  crc?: number
  /** General purpose flags (bit 0 = encrypted, bit 11 = UTF-8 is added automatically for non-ASCII names). */
  flags?: number
  externalAttrs?: number
  /** Version made by (high byte = host OS; 3 = Unix). Default 0x031e. */
  madeBy?: number
  /** Write sizes and offset through a zip64 extended-information extra field. */
  zip64?: boolean
  /** Do not write a local header: point the central entry at entry #n's local header (overlap). */
  sameLocalAs?: number
}

export interface CraftOptions {
  /** Write a zip64 end-of-central-directory record + locator (EOCD fields set to 0xFFFF/0xFFFFFFFF). */
  zip64Eocd?: boolean
  /** Entry count written in the EOCD (default: the real count). */
  declaredCount?: number
  comment?: string
}

const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }
const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }

export const S_IFREG = 0o100000
export const S_IFDIR = 0o040000
export const S_IFLNK = 0o120000
export const S_IFCHR = 0o020000
export const S_IFIFO = 0o010000
/** External attributes carrying a Unix mode. */
export const unixMode = (mode: number) => (mode << 16) >>> 0

export function craftZip(entries: CraftEntry[], opts: CraftOptions = {}): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  const offsets: number[] = []
  let offset = 0
  for (const e of entries) {
    const name = typeof e.name === 'string' ? Buffer.from(e.name, 'utf8') : Buffer.from(e.name)
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data ?? new Uint8Array())
    const method = e.method ?? 8
    const comp = Buffer.from(e.compressed ?? (method === 8 ? deflateSync(raw) : raw))
    const crc = e.crc ?? crc32(raw)
    const size = e.declaredSize ?? raw.length
    const nonAscii = typeof e.name === 'string' && /[^\x00-\x7f]/.test(e.name)
    const flags = (e.flags ?? 0) | (nonAscii ? 0x0800 : 0)
    let localOff: number
    if (e.sameLocalAs !== undefined) {
      localOff = offsets[e.sameLocalAs]!
    } else {
      localOff = offset
      const extra = e.zip64 ? Buffer.concat([u16(1), u16(16), u64(size), u64(comp.length)]) : Buffer.alloc(0)
      const local = Buffer.concat([
        u32(0x04034b50), u16(e.zip64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc),
        u32(e.zip64 ? 0xffffffff : comp.length), u32(e.zip64 ? 0xffffffff : size), u16(name.length), u16(extra.length),
        name, extra, comp,
      ])
      parts.push(local)
      offset += local.length
    }
    offsets.push(localOff)
    const cextra = e.zip64 ? Buffer.concat([u16(1), u16(24), u64(size), u64(comp.length), u64(localOff)]) : Buffer.alloc(0)
    central.push(Buffer.concat([
      u32(0x02014b50), u16(e.madeBy ?? 0x031e), u16(e.zip64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc),
      u32(e.zip64 ? 0xffffffff : comp.length), u32(e.zip64 ? 0xffffffff : size), u16(name.length), u16(cextra.length), u16(0),
      u16(0), u16(0), u32(e.externalAttrs ?? 0), u32(e.zip64 ? 0xffffffff : localOff), name, cextra,
    ]))
  }
  const cd = Buffer.concat(central)
  const cdOffset = offset
  const count = opts.declaredCount ?? entries.length
  const comment = Buffer.from(opts.comment ?? '', 'utf8')
  const tail: Buffer[] = []
  if (opts.zip64Eocd) {
    const recOffset = cdOffset + cd.length
    tail.push(Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(count), u64(count), u64(cd.length), u64(cdOffset),
    ]))
    tail.push(Buffer.concat([u32(0x07064b50), u32(0), u64(recOffset), u32(1)]))
    tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(comment.length), comment]))
  } else {
    tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(cd.length), u32(cdOffset), u16(comment.length), comment]))
  }
  return Buffer.concat([...parts, cd, ...tail])
}

/** Raw DEFLATE of `n` zero bytes, produced in 1 MB steps (never holds `n` bytes in memory). */
export function deflateZeros(n: number): Uint8Array {
  const out: Uint8Array[] = []
  const d = new Deflate({ level: 9 }, chunk => { out.push(chunk) })
  const step = new Uint8Array(1024 * 1024)
  for (let left = n; left > 0;) {
    const k = Math.min(left, step.length)
    left -= k
    d.push(k === step.length ? step : step.subarray(0, k), left === 0)
  }
  if (n === 0) d.push(new Uint8Array(), true)
  return Buffer.concat(out)
}

/** CRC-32 of `n` zero bytes, computed in 1 MB steps. */
export function crcZeros(n: number): number {
  const step = new Uint8Array(1024 * 1024)
  let c = 0
  for (let left = n; left > 0;) {
    const k = Math.min(left, step.length)
    c = crc32(step.subarray(0, k), c)
    left -= k
  }
  return c
}
