import { crc32 } from 'node:zlib'
import { Inflate } from 'fflate'
import { isValidName } from '@ligature/shared'

/*
 * A hardened, read-only ZIP parser for project imports (docs/M2.md §5).
 *
 * The central directory is the source of truth for the entry list; local headers are only used to find
 * where each entry's data starts. Sizes declared in headers are never trusted for resource limits:
 * inflation is streamed in small chunks and stops as soon as an entry or the archive crosses a limit.
 * Declared sizes and CRCs are verified afterwards, so a lying header is a corrupt archive.
 */

export interface ZipLimits {
  maxEntries: number
  /** total uncompressed bytes of all extracted entries */
  maxTotalBytes: number
  /** uncompressed bytes of one entry */
  maxEntryBytes: number
  /** max uncompressed:compressed ratio, enforced once an entry is larger than `ratioThreshold` */
  maxRatio: number
  ratioThreshold: number
  maxDepth: number
  maxPathLength: number
}

const MB = 1024 * 1024

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxTotalBytes: 200 * MB,
  maxEntryBytes: 50 * MB,
  maxRatio: 200,
  ratioThreshold: 1 * MB,
  maxDepth: 32,
  maxPathLength: 1024,
}

/** A rejected archive. `entry` names the offending entry when there is one. */
export class ZipError extends Error {
  constructor(message: string, readonly entry?: string) {
    super(entry === undefined ? message : `Entry ${JSON.stringify(entry)}: ${message}`)
  }
}

export interface ZipEntry {
  /** Name as stored (directories end with '/'). */
  name: string
  /** Name without the trailing '/' of directories, split into validated segments. */
  segments: string[]
  isDir: boolean
  method: number
  crc: number
  compressedSize: number
  /** As declared; verified against the real size after inflating. */
  declaredSize: number
  localOffset: number
  /** Filled in by `readZip` from the local header. */
  dataStart: number
}

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** Bytes of compressed input fed to the inflater per step: bounds what one step can produce (~1032x). */
const INFLATE_CHUNK = 4096

// IBM code page 437, bytes 0x80-0xFF: the ZIP default for names without the UTF-8 flag.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

const utf8 = new TextDecoder('utf-8', { fatal: true })

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) {
    try { return utf8.decode(bytes) } catch { throw new ZipError('Entry name is not valid UTF-8') }
  }
  if (bytes.every(b => b < 0x80)) return String.fromCharCode(...bytes)
  // Many tools write UTF-8 without setting the flag; fall back to CP437 only when it is not UTF-8.
  try { return utf8.decode(bytes) } catch { /* not UTF-8 */ }
  let s = ''
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80]!
  return s
}

const CONTROL = /[\u0000-\u001f\u007f]/
const DRIVE = /^[A-Za-z]:/

/** Validate an entry name; returns its segments (without the trailing '/' of a directory). */
function validateName(name: string, limits: ZipLimits): string[] {
  if (name.length === 0) throw new ZipError('empty entry name')
  if (CONTROL.test(name)) throw new ZipError('name contains NUL or control characters', name)
  if (name.includes('\\')) throw new ZipError('name contains a backslash', name)
  if (name.startsWith('/')) throw new ZipError('absolute path', name)
  if (DRIVE.test(name)) throw new ZipError('name starts with a drive letter', name)
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name
  const segments = trimmed.split('/')
  if (segments.some(s => s === '..')) throw new ZipError("path contains '..'", name)
  if (trimmed.length > limits.maxPathLength) throw new ZipError(`path longer than ${limits.maxPathLength} characters`, name)
  if (segments.length > limits.maxDepth) throw new ZipError(`path nested deeper than ${limits.maxDepth} levels`, name)
  for (const s of segments) if (!isValidName(s)) throw new ZipError(`invalid name segment ${JSON.stringify(s)}`, name)
  return segments
}

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

function u64(buf: Buffer, off: number, what: string): number {
  const v = buf.readBigUInt64LE(off)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError(`${what} out of range`)
  return Number(v)
}

function need(buf: Buffer, off: number, len: number, what: string): void {
  if (off < 0 || off + len > buf.length) throw new ZipError(`truncated archive (${what})`)
}

interface Directory { count: number; offset: number; size: number }

function findDirectory(buf: Buffer, limits: ZipLimits): Directory {
  if (buf.length < 22) throw new ZipError('not a zip file')
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && i + 22 + buf.readUInt16LE(i + 20) <= buf.length) { eocd = i; break }
  }
  if (eocd < 0) throw new ZipError('not a zip file (no end of central directory record)')
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new ZipError('multi-disk archives are not supported')
  let count = buf.readUInt16LE(eocd + 10)
  let size = buf.readUInt32LE(eocd + 12)
  let offset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    // Zip64: accepted, but only within the same limits.
    const loc = eocd - 20
    need(buf, loc, 20, 'zip64 locator')
    if (buf.readUInt32LE(loc) !== SIG_EOCD64_LOCATOR) throw new ZipError('missing zip64 end of central directory locator')
    const rec = u64(buf, loc + 8, 'zip64 record offset')
    need(buf, rec, 56, 'zip64 end of central directory')
    if (buf.readUInt32LE(rec) !== SIG_EOCD64) throw new ZipError('bad zip64 end of central directory record')
    count = u64(buf, rec + 32, 'entry count')
    size = u64(buf, rec + 40, 'central directory size')
    offset = u64(buf, rec + 48, 'central directory offset')
  }
  if (count > limits.maxEntries) throw new ZipError(`too many entries (${count}; the limit is ${limits.maxEntries})`)
  need(buf, offset, size, 'central directory')
  return { count, offset, size }
}

/** Parse zip64 extended information (extra field 0x0001) for the fields that were 0xFFFFFFFF. */
function zip64Extra(buf: Buffer, start: number, end: number, e: { comp: number; size: number; off: number }, name: string): void {
  for (let p = start; p + 4 <= end;) {
    const id = buf.readUInt16LE(p)
    const len = buf.readUInt16LE(p + 2)
    const body = p + 4
    if (body + len > end) throw new ZipError('malformed extra field', name)
    if (id === 0x0001) {
      let q = body
      const take = (what: string) => {
        if (q + 8 > body + len) throw new ZipError('malformed zip64 extra field', name)
        const v = u64(buf, q, what); q += 8; return v
      }
      if (e.size === 0xffffffff) e.size = take('size')
      if (e.comp === 0xffffffff) e.comp = take('compressed size')
      if (e.off === 0xffffffff) e.off = take('offset')
      return
    }
    p = body + len
  }
  if (e.size === 0xffffffff || e.comp === 0xffffffff || e.off === 0xffffffff) throw new ZipError('missing zip64 extra field', name)
}

/**
 * Read and validate the archive's entry list (no inflation yet). Rejects: hostile names, symlinks and
 * special files, encrypted entries, unsupported compression, duplicate paths (case-insensitive, and a
 * file colliding with a folder), overlapping entries, too many entries, too long / too deep paths.
 */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  const dir = findDirectory(buf, limits)
  const entries: ZipEntry[] = []
  let p = dir.offset
  const end = dir.offset + dir.size
  for (let i = 0; i < dir.count; i++) {
    need(buf, p, 46, 'central directory entry')
    if (p + 46 > end || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('corrupt central directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const external = buf.readUInt32LE(p + 38)
    const sizes = { comp: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), off: buf.readUInt32LE(p + 42) }
    const nameStart = p + 46
    need(buf, nameStart, nameLen + extraLen + commentLen, 'central directory entry')
    if (nameStart + nameLen + extraLen + commentLen > end) throw new ZipError('corrupt central directory')
    const name = decodeName(buf.subarray(nameStart, nameStart + nameLen), (flags & 0x0800) !== 0)
    zip64Extra(buf, nameStart + nameLen, nameStart + nameLen + extraLen, sizes, name)
    p = nameStart + nameLen + extraLen + commentLen

    const segments = validateName(name, limits)
    // Unix mode bits live in the high 16 bits of the external attributes (any "made by" host may set them).
    const mode = (external >>> 16) & S_IFMT
    if (mode === S_IFLNK) throw new ZipError('symbolic links are not allowed', name)
    if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) throw new ZipError('device, FIFO and socket entries are not allowed', name)
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || method === 99) throw new ZipError('encrypted entries are not supported', name)
    const isDir = name.endsWith('/') || mode === S_IFDIR
    if (!isDir && method !== 0 && method !== 8) throw new ZipError(`unsupported compression method ${method}`, name)
    entries.push({ name, segments, isDir, method, crc, compressedSize: sizes.comp, declaredSize: sizes.size, localOffset: sizes.off, dataStart: 0 })
  }

  checkDuplicates(entries)

  // Local headers: find each entry's data; entries must not overlap each other or the central directory.
  for (const e of entries) {
    need(buf, e.localOffset, 30, 'local header')
    if (buf.readUInt32LE(e.localOffset) !== SIG_LOCAL) throw new ZipError('bad local header', e.name)
    if ((buf.readUInt16LE(e.localOffset + 6) & 0x0041) !== 0) throw new ZipError('encrypted entries are not supported', e.name)
    e.dataStart = e.localOffset + 30 + buf.readUInt16LE(e.localOffset + 26) + buf.readUInt16LE(e.localOffset + 28)
    const dataEnd = e.dataStart + (e.isDir ? 0 : e.compressedSize)
    if (dataEnd > dir.offset || dataEnd > buf.length) throw new ZipError('entry data runs past the end of the archive', e.name)
  }
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset)
  for (let i = 1; i < byOffset.length; i++) {
    const prev = byOffset[i - 1]!
    const cur = byOffset[i]!
    if (cur.localOffset < prev.dataStart + (prev.isDir ? 0 : prev.compressedSize)) throw new ZipError('overlaps another entry', cur.name)
  }
  return entries
}

/** Comparison key of a path: Unicode NFC, lower-cased (names differing only in case or normalisation clash). */
export const pathKey = (path: string): string => path.normalize('NFC').toLowerCase()

/**
 * Duplicate paths (case- and normalisation-insensitive), a file whose path is also a folder of another
 * entry, and one folder spelled two ways (`Chapters/a.tex` + `chapters/b.tex` would make two sibling
 * folders that differ only in case).
 */
function checkDuplicates(entries: ZipEntry[]): void {
  const files = new Set<string>()
  const explicitDirs = new Set<string>()
  /** key of every folder (explicit or implied) -> its first spelling */
  const folderSpelling = new Map<string, string>()
  const folder = (spelled: string, e: ZipEntry) => {
    const key = pathKey(spelled)
    const first = folderSpelling.get(key)
    if (first === undefined) folderSpelling.set(key, spelled)
    else if (first !== spelled) throw new ZipError('duplicate path (a folder differs only in case or Unicode normalisation)', e.name)
  }
  for (const e of entries) {
    const path = e.segments.join('/')
    const key = pathKey(path)
    if (e.isDir) {
      if (explicitDirs.has(key) || files.has(key)) throw new ZipError('duplicate path', e.name)
      explicitDirs.add(key)
      folder(path, e)
    } else {
      if (files.has(key) || explicitDirs.has(key)) throw new ZipError('duplicate path', e.name)
      files.add(key)
    }
    for (let i = 1; i < e.segments.length; i++) folder(e.segments.slice(0, i).join('/'), e)
  }
  for (const e of entries) {
    if (!e.isDir && folderSpelling.has(pathKey(e.segments.join('/')))) throw new ZipError('a file has the same path as a folder', e.name)
  }
}

/** Running total shared by all entries of one archive. */
export interface ExtractBudget { totalBytes: number }

/**
 * Extract one file entry, enforcing the per-entry, total and ratio limits while inflating.
 * Verifies the declared size and CRC-32 afterwards.
 */
export function extractEntry(buf: Buffer, e: ZipEntry, budget: ExtractBudget, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Buffer {
  if (e.isDir) return Buffer.alloc(0)
  const src = buf.subarray(e.dataStart, e.dataStart + e.compressedSize)
  const chunks: Uint8Array[] = []
  let out = 0
  let crc = 0
  // The ratio is the entry's, not a prefix's: compare with the entry's real compressed length (bytes that
  // are in the archive, bounds- and overlap-checked by readZip), so a file whose start compresses very well
  // (a blank area of an image) is not refused. Still checked while inflating, so a bomb stops early.
  const maxOut = src.byteLength * limits.maxRatio
  const account = (chunk: Uint8Array) => {
    out += chunk.byteLength
    budget.totalBytes += chunk.byteLength
    if (out > limits.maxEntryBytes) throw new ZipError(`larger than ${fmt(limits.maxEntryBytes)} uncompressed`, e.name)
    if (budget.totalBytes > limits.maxTotalBytes) throw new ZipError(`the archive is larger than ${fmt(limits.maxTotalBytes)} uncompressed`, e.name)
    if (out > limits.ratioThreshold && out > maxOut) {
      throw new ZipError(`compression ratio above ${limits.maxRatio}:1`, e.name)
    }
    crc = crc32(chunk, crc)
    chunks.push(chunk)
  }
  if (e.method === 0) {
    account(src)
  } else if (src.byteLength > 0) {
    const inflater = new Inflate((chunk: Uint8Array) => { if (chunk.byteLength) account(chunk) })
    try {
      for (let off = 0; off < src.byteLength; off += INFLATE_CHUNK) {
        const piece = src.subarray(off, off + INFLATE_CHUNK)
        inflater.push(piece, off + INFLATE_CHUNK >= src.byteLength)
      }
    } catch (err) {
      if (err instanceof ZipError) throw err
      throw new ZipError('corrupt compressed data', e.name)
    }
  }
  if (out !== e.declaredSize) throw new ZipError('size does not match its header', e.name)
  if ((crc >>> 0) !== e.crc) throw new ZipError('CRC-32 mismatch (corrupt archive)', e.name)
  return Buffer.concat(chunks, out)
}

function fmt(bytes: number): string {
  return bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${bytes} bytes`
}
