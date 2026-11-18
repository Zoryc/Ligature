// Hash cache, disk usage / quota, blob cache eviction, and the no-follow file helpers.
import { createHash } from 'node:crypto'
import { constants, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { BlobStore } from '../src/blobStore.ts'
import { diskUsage, QuotaWatch } from '../src/diskUsage.ts'
import { openForWrite, openRegular } from '../src/fsSafe.ts'
import { HASH_CACHE_FILE, HashCache } from '../src/hashCache.ts'

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const tmp = () => mkdtempSync(join(tmpdir(), 'ligature-store-'))
const MB = 1024 * 1024

describe('source hash cache', () => {
  it('answers unchanged files from the cache, re-hashes changed ones, and survives a reload', async () => {
    const root = tmp()
    const src = join(root, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'a.tex'), 'alpha')
    let c = await HashCache.load(root)
    expect(await c.hashOf(src, 'a.tex')).toBe(sha('alpha'))
    expect(c.hashed).toBe(1)
    await c.save(root, { 'a.tex': sha('alpha') })

    c = await HashCache.load(root)
    expect(await c.hashOf(src, 'a.tex')).toBe(sha('alpha'))
    expect(c.hashed).toBe(0) // from the cache

    // Same size and even the same mtime: the ctime still changes, so the edit is seen.
    const before = (await openRegular(join(src, 'a.tex')))!
    await before.fh.close()
    writeFileSync(join(src, 'a.tex'), 'ALPHA')
    utimesSync(join(src, 'a.tex'), new Date(before.mtimeMs), new Date(before.mtimeMs))
    expect(await c.hashOf(src, 'a.tex')).toBe(sha('ALPHA'))
    expect(c.hashed).toBe(1)

    // `fresh` (clean builds) ignores the file; a malformed file is ignored.
    expect((await HashCache.load(root, true)).hashed).toBe(0)
    writeFileSync(join(root, HASH_CACHE_FILE), 'not json')
    c = await HashCache.load(root)
    expect(await c.hashOf(src, 'a.tex')).toBe(sha('ALPHA'))
    expect(c.hashed).toBe(1)
    expect(await c.hashOf(src, 'missing.tex')).toBeNull()
  })

  it('saves only entries that match the manifest', async () => {
    const root = tmp()
    const src = join(root, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'a.tex'), 'a')
    writeFileSync(join(src, 'b.tex'), 'b')
    const c = await HashCache.load(root)
    await c.hashOf(src, 'a.tex')
    await c.hashOf(src, 'b.tex')
    await c.save(root, { 'a.tex': sha('a'), 'b.tex': sha('something else') })
    expect(Object.keys(JSON.parse(readFileSync(join(root, HASH_CACHE_FILE), 'utf8')).files)).toEqual(['a.tex'])
  })
})

describe('disk usage and quota', () => {
  it('sums sizes and stops early once over the limit', async () => {
    const d = tmp()
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'a'), Buffer.alloc(1000))
    writeFileSync(join(d, 'sub', 'b'), Buffer.alloc(2000))
    const u = await diskUsage(d, { maxBytes: 10 * MB, maxEntries: 100 })
    expect(u.over).toBe(false)
    expect(u.entries).toBe(3)
    expect(u.bytes).toBeGreaterThanOrEqual(3000)
    expect((await diskUsage(d, { maxBytes: 1500, maxEntries: 100 })).over).toBe(true)
    expect((await diskUsage(d, { maxBytes: 10 * MB, maxEntries: 2 })).over).toBe(true)
  })

  it('QuotaWatch does not count the manifest sources', async () => {
    const root = tmp()
    const src = join(root, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'big.png'), Buffer.alloc(3 * MB))
    const w = await QuotaWatch.start(root, src, { 'big.png': sha('x') }, { bytes: 1 * MB, entries: 100 })
    expect(await w.check()).toBeNull()
    writeFileSync(join(root, 'junk'), Buffer.alloc(2 * MB))
    expect(await w.check()).toMatch(/disk quota/)
  })
})

describe('blob cache eviction', () => {
  async function store(): Promise<BlobStore> {
    const s = new BlobStore(join(tmp(), '.blobs'), 100 * MB)
    await s.init()
    return s
  }
  const put = (s: BlobStore, content: string) => s.put(sha(content), Readable.from([Buffer.from(content)]))
  const age = (s: BlobStore, content: string, ms: number) => {
    const t = new Date(Date.now() - ms)
    utimesSync(s.path(sha(content)), t, t)
  }
  const HOUR = 3600_000

  it('evicts blobs unused for too long, then the least recently used beyond the size cap', async () => {
    const s = await store()
    for (const c of ['old', 'mid', 'new', 'fresh']) await put(s, c)
    age(s, 'old', 100 * HOUR)
    age(s, 'mid', 3 * HOUR)
    age(s, 'new', 2 * HOUR)
    age(s, 'fresh', 1000)
    // by age only
    let r = await s.gc({ maxBytes: 1e9, maxAgeMs: 72 * HOUR, minAgeMs: 15 * 60_000 })
    expect(r.removed).toBe(1)
    expect(await s.has(sha('old'))).toBe(false)
    expect(await s.has(sha('mid'))).toBe(true)
    // by size: 3 blobs of 3-5 bytes; cap 4 bytes evicts oldest first but never the one used within minAge
    r = await s.gc({ maxBytes: 4, maxAgeMs: 72 * HOUR, minAgeMs: 15 * 60_000 })
    expect(r.removed).toBe(2)
    expect(await s.has(sha('mid'))).toBe(false)
    expect(await s.has(sha('new'))).toBe(false)
    expect(await s.has(sha('fresh'))).toBe(true)
  })

  it('a sync (missing) marks present blobs as used', async () => {
    const s = await store()
    await put(s, 'kept')
    age(s, 'kept', 100 * HOUR)
    expect(await s.missing([sha('kept'), sha('absent')])).toEqual([sha('absent')])
    const r = await s.gc({ maxBytes: 1e9, maxAgeMs: 72 * HOUR, minAgeMs: 15 * 60_000 })
    expect(r.removed).toBe(0)
    expect(await s.has(sha('kept'))).toBe(true)
  })
})

// O_NOFOLLOW exists on POSIX only; Windows (dev) takes the lstat fallback, covered by materialize.test.ts.
describe.skipIf(!constants.O_NOFOLLOW)('no-follow file helpers (POSIX O_NOFOLLOW path)', () => {
  it('openRegular refuses a symlink, openForWrite fails with ELOOP and leaves the target alone', async () => {
    const d = tmp()
    writeFileSync(join(d, 'target'), 'TARGET')
    symlinkSync(join(d, 'target'), join(d, 'link'))
    expect(await openRegular(join(d, 'link'))).toBeNull()
    await expect(openForWrite(join(d, 'link'))).rejects.toMatchObject({ code: 'ELOOP' })
    expect(readFileSync(join(d, 'target'), 'utf8')).toBe('TARGET')
  })
})
