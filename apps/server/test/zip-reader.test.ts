import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { DEFAULT_ZIP_LIMITS, extractEntry, readZip, ZipError, type ZipLimits } from '../src/zip/reader.ts'
import { planImport, skipReason } from '../src/zip/importer.ts'
import { craftZip, crcZeros, deflateZeros, S_IFCHR, S_IFDIR, S_IFIFO, S_IFLNK, S_IFREG, unixMode, type CraftEntry } from './fixtures/zips/craft.ts'

const KB = 1024
const MB = 1024 * 1024
const SMALL: ZipLimits = { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 300 * KB, maxEntryBytes: 200 * KB, ratioThreshold: 64 * KB, maxRatio: 20 }

/** Read and extract everything; returns path -> text. */
function extractAll(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Map<string, string> {
  const budget = { totalBytes: 0 }
  return new Map(readZip(buf, limits).filter(e => !e.isDir).map(e => [e.name, extractEntry(buf, e, budget, limits).toString('utf8')]))
}

function rejects(entries: CraftEntry[], pattern: RegExp, limits: ZipLimits = DEFAULT_ZIP_LIMITS, opts = {}): ZipError {
  const buf = craftZip(entries, opts)
  let err: unknown
  try { extractAll(buf, limits) } catch (e) { err = e }
  expect(err, `expected rejection matching ${pattern}`).toBeInstanceOf(ZipError)
  expect((err as ZipError).message).toMatch(pattern)
  return err as ZipError
}

describe('zip reader: valid archives', () => {
  it('reads archives written by fflate (deflate + stored, folders, UTF-8 names)', () => {
    const buf = Buffer.from(zipSync({
      'main.tex': new TextEncoder().encode('\\documentclass{article}'),
      chapters: {},
      'chapters/intro.tex': [new TextEncoder().encode('Intro'), { level: 0 }],
      'figures/größe.txt': new TextEncoder().encode('ü'),
    }))
    const entries = readZip(buf)
    expect(entries.map(e => [e.name, e.isDir])).toEqual([
      ['main.tex', false], ['chapters/', true], ['chapters/intro.tex', false], ['figures/größe.txt', false],
    ])
    const files = extractAll(buf)
    expect(files.get('main.tex')).toBe('\\documentclass{article}')
    expect(files.get('chapters/intro.tex')).toBe('Intro')
    expect(files.get('figures/größe.txt')).toBe('ü')
  })

  it('accepts zip64 within the limits (zip64 extra fields and zip64 end of central directory)', () => {
    const buf = craftZip([{ name: 'a.tex', data: 'hello', zip64: true }, { name: 'b.tex', data: 'world' }], { zip64Eocd: true })
    expect([...extractAll(buf)]).toEqual([['a.tex', 'hello'], ['b.tex', 'world']])
  })

  it('decodes non-UTF-8 names without the UTF-8 flag as CP437', () => {
    const buf = craftZip([{ name: Uint8Array.from([0x82, 0x2e, 0x74, 0x65, 0x78]), data: 'x' }]) // "é.tex" in CP437
    expect(readZip(buf)[0]!.name).toBe('é.tex')
  })

  it('treats an archive with a trailing comment normally', () => {
    expect([...extractAll(craftZip([{ name: 'a.txt', data: 'a' }], { comment: 'made by a test' }))]).toEqual([['a.txt', 'a']])
  })
})

describe('zip reader: hostile names are rejected, naming the entry', () => {
  const cases: [string, string | Uint8Array, RegExp][] = [
    ['absolute path', '/etc/passwd', /"\/etc\/passwd": absolute path/],
    ['parent segment', 'a/../../evil.tex', /"a\/..\/..\/evil.tex": path contains '\.\.'/],
    ['leading ..', '../evil.tex', /contains '\.\.'/],
    ['backslash', 'a\\..\\evil.tex', /backslash/],
    ['drive letter', 'C:/Windows/evil.tex', /drive letter/],
    ['NUL', 'evil.tex\u0000.png', /control characters/],
    ['control char', 'bad\u0007name.tex', /control characters/],
    ['empty segment', 'a//b.tex', /invalid name segment ""/],
    ['dot segment', 'a/./b.tex', /invalid name segment "\."/],
    ['bad char', 'a/b:c.tex', /invalid name segment/],
    ['trailing space', 'a /b.tex', /invalid name segment "a "/],
    ['too long segment', `${'x'.repeat(256)}.tex`, /invalid name segment/],
    ['invalid UTF-8 with flag', Uint8Array.from([0xff, 0xfe, 0x2e, 0x74]), /not valid UTF-8/],
  ]
  for (const [what, name, re] of cases) {
    it(what, () => {
      const flags = name instanceof Uint8Array ? 0x0800 : 0
      rejects([{ name: 'ok.tex', data: 'ok' }, { name, data: 'x', flags }], re)
    })
  }

  it('path longer than 1024 characters / deeper than 32 levels', () => {
    rejects([{ name: `${'abcdefghij/'.repeat(100)}x.tex`, data: 'x' }], /longer than 1024 characters/)
    rejects([{ name: `${'d/'.repeat(32)}x.tex`, data: 'x' }], /deeper than 32 levels/)
    expect(() => extractAll(craftZip([{ name: `${'d/'.repeat(31)}x.tex`, data: 'x' }]))).not.toThrow()
  })
})

describe('zip reader: entry types, encryption, duplicates', () => {
  it('rejects symlinks (Unix mode in the external attributes), devices, FIFOs', () => {
    rejects([{ name: 'link.tex', data: '/etc/passwd', externalAttrs: unixMode(S_IFLNK | 0o777) }], /"link.tex": symbolic links/)
    rejects([{ name: 'dev', data: '', method: 0, externalAttrs: unixMode(S_IFCHR | 0o666) }], /"dev": device, FIFO/)
    rejects([{ name: 'fifo', data: '', method: 0, externalAttrs: unixMode(S_IFIFO | 0o666) }], /device, FIFO/)
    // a symlink flagged by a non-Unix "made by" host is still a symlink
    rejects([{ name: 'link2', data: 'x', madeBy: 0x0014, externalAttrs: unixMode(S_IFLNK | 0o777) }], /symbolic links/)
    // regular files and directories with modes are fine
    expect(() => extractAll(craftZip([
      { name: 'd/', method: 0, externalAttrs: unixMode(S_IFDIR | 0o755) },
      { name: 'd/f.tex', data: 'x', externalAttrs: unixMode(S_IFREG | 0o644) },
    ]))).not.toThrow()
  })

  it('rejects encrypted entries (traditional flag, strong encryption flag, AES method 99)', () => {
    rejects([{ name: 'secret.tex', data: 'x', flags: 0x0001 }], /"secret.tex": encrypted/)
    rejects([{ name: 'secret.tex', data: 'x', flags: 0x0040 }], /encrypted/)
    rejects([{ name: 'secret.tex', data: 'x', method: 99 }], /encrypted/)
  })

  it('rejects unsupported compression methods', () => {
    rejects([{ name: 'a.tex', data: 'x', method: 14, compressed: Uint8Array.from([1, 2, 3]) }], /unsupported compression method 14/)
  })

  it('rejects duplicate paths, case-insensitive duplicates and file/folder collisions', () => {
    rejects([{ name: 'a.tex', data: '1' }, { name: 'a.tex', data: '2' }], /"a.tex": duplicate path/)
    rejects([{ name: 'Main.tex', data: '1' }, { name: 'main.TEX', data: '2' }], /"main.TEX": duplicate path/)
    rejects([{ name: 'figs', data: 'file' }, { name: 'figs/a.png', data: 'x' }], /"figs": a file has the same path as a folder/)
    rejects([{ name: 'Figs/a.png', data: 'x' }, { name: 'figs', data: 'file' }], /"figs": a file has the same path as a folder/)
    rejects([{ name: 'figs/', method: 0 }, { name: 'FIGS', data: 'file' }], /duplicate path/)
    rejects([{ name: 'd/', method: 0 }, { name: 'd/', method: 0 }], /duplicate path/)
  })

  it('rejects one folder spelled two ways (case), implied or explicit, at any depth', () => {
    const differs = /duplicate path \(a folder differs only in case or Unicode normalisation\)/
    rejects([{ name: 'main.tex', data: 'x' }, { name: 'Chapters/a.tex', data: 'a' }, { name: 'chapters/b.tex', data: 'b' }], differs)
    rejects([{ name: 'Chapters/', method: 0 }, { name: 'chapters/x.tex', data: 'x' }], differs)
    rejects([{ name: 'a/Figs/x.png', data: 'x' }, { name: 'a/figs/y.png', data: 'y' }], differs)
    rejects([{ name: 'chapters/x.tex', data: 'x' }, { name: 'CHAPTERS/', method: 0 }], differs)
    // the same spelling everywhere is fine, explicit folder entries included
    expect(() => extractAll(craftZip([{ name: 'Chapters/', method: 0 }, { name: 'Chapters/a.tex', data: 'a' }, { name: 'Chapters/b.tex', data: 'b' }]))).not.toThrow()
  })

  it('rejects names that differ only in Unicode normalisation (NFC vs NFD)', () => {
    const nfc = 'café'
    const nfd = 'café'
    expect(nfc).not.toBe(nfd)
    rejects([{ name: `${nfc}.tex`, data: '1' }, { name: `${nfd}.tex`, data: '2' }], /duplicate path/)
    rejects([{ name: `${nfc}/a.tex`, data: '1' }, { name: `${nfd}/b.tex`, data: '2' }], /differs only in case or Unicode normalisation/)
    rejects([{ name: `${nfc.toUpperCase()}.TEX`, data: '1' }, { name: `${nfd}.tex`, data: '2' }], /duplicate path/)
  })

  it('rejects overlapping entries (one local header shared by two central entries)', () => {
    rejects([{ name: 'a.tex', data: 'aaaa' }, { name: 'b.tex', data: 'aaaa', sameLocalAs: 0 }], /"b.tex": overlaps another entry/)
  })
})

describe('zip reader: limits are enforced while inflating', () => {
  it('more than 2000 entries', () => {
    const many = Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.txt`, data: '' }))
    rejects(many, /too many entries \(2001; the limit is 2000\)/)
    // a lying entry count in the EOCD cannot smuggle extra entries in: only declared entries are read
    const lying = craftZip(many.slice(0, 3), { declaredCount: 2 })
    expect(readZip(lying).length).toBe(2)
    expect(() => readZip(craftZip(many.slice(0, 2000)))).not.toThrow()
  })

  it('per-entry size, regardless of the declared size (a lying header is caught mid-stream)', () => {
    const data = randomBytes(250 * KB) // incompressible: the ratio limit cannot fire first
    rejects([{ name: 'big.bin', data, declaredSize: 10 }], /"big.bin": larger than 204800 bytes uncompressed/, SMALL)
    rejects([{ name: 'big.bin', data, method: 0, declaredSize: 10 }], /larger than/, SMALL)
  })

  it('total uncompressed size', () => {
    const data = randomBytes(160 * KB)
    rejects([{ name: 'a.bin', data }, { name: 'b.bin', data }, { name: 'c.bin', data }], /"b.bin": the archive is larger than 307200 bytes/, SMALL)
  })

  it('compression ratio above the limit for entries over the threshold', () => {
    const n = 150 * KB
    rejects([{ name: 'zeros.bin', compressed: deflateZeros(n), declaredSize: n, crc: crcZeros(n) }], /"zeros.bin": compression ratio above 20:1/, SMALL)
    // below the threshold the ratio does not matter
    const small = 60 * KB
    expect(() => extractAll(craftZip([{ name: 'z.bin', compressed: deflateZeros(small), declaredSize: small, crc: crcZeros(small) }]), SMALL)).not.toThrow()
  })

  it('a zip bomb with a lying header stops after the first megabytes (default limits)', () => {
    // 40 MB of zeros is ~40 KB of DEFLATE: the entry's ratio limit (200 x 40 KB = 8 MB) stops it
    const n = 40 * MB
    const t = Date.now()
    const err = rejects([{ name: 'bomb.tex', compressed: deflateZeros(n), declaredSize: 100, crc: 0 }], /compression ratio above 200:1/)
    expect(err.entry).toBe('bomb.tex')
    expect(Date.now() - t).toBeLessThan(2_000)
    // a bigger bomb has a bigger ratio allowance; the per-entry limit stops it at 50 MB
    const t2 = Date.now()
    rejects([{ name: 'bomb.tex', compressed: deflateZeros(256 * MB), declaredSize: 100, crc: 0 }], /"bomb.tex": larger than 50 MB/)
    expect(Date.now() - t2).toBeLessThan(5_000)
  }, 60_000)

  it("the ratio is the entry's, not its start's: a file whose first megabytes compress very well is accepted", () => {
    // 1.5 MB of zeros then 1.5 MB of random bytes: overall about 2:1, though the start is ~1000:1
    const data = Buffer.concat([Buffer.alloc(1.5 * MB), randomBytes(1.5 * MB)])
    const zip = zipSync({ 'fig.bmp': data }, { level: 6 })
    const got = extractAll(Buffer.from(zip))
    expect(got.has('fig.bmp')).toBe(true)
    const buf = Buffer.from(zip)
    const [e] = readZip(buf)
    expect(extractEntry(buf, e!, { totalBytes: 0 }).equals(data)).toBe(true)
  })

  it('detects corrupt data, size mismatch and CRC mismatch', () => {
    rejects([{ name: 'a.tex', data: 'hello', crc: 1234 }], /"a.tex": CRC-32 mismatch/)
    rejects([{ name: 'a.tex', data: 'hello', declaredSize: 4 }], /size does not match/)
    rejects([{ name: 'a.tex', declaredSize: 5, compressed: Uint8Array.from([0xff, 0xff, 0xff]) }], /corrupt compressed data/)
  })

  it('rejects things that are not zips, truncated archives and data past the end', () => {
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow(/not a zip file/)
    expect(() => readZip(Buffer.alloc(5))).toThrow(/not a zip file/)
    const good = craftZip([{ name: 'a.tex', data: 'hello world' }])
    expect(() => readZip(good.subarray(10))).toThrow(ZipError)
    const lying = craftZip([{ name: 'a.tex', compressed: Uint8Array.from([1, 2, 3]), declaredSize: 3 }])
    // patch the central directory's compressed size to point past the central directory
    const cd = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    lying.writeUInt32LE(1_000_000, cd + 20)
    expect(() => readZip(lying)).toThrow(/runs past the end/)
  })
})

describe('import planning', () => {
  it('skip rules', () => {
    expect(skipReason(['__MACOSX', 'proj', '._main.tex'], false)).toBe('macOS metadata')
    expect(skipReason(['__MACOSX'], true)).toBe('macOS metadata')
    expect(skipReason(['proj', '.DS_Store'], false)).toBe('system file')
    expect(skipReason(['THUMBS.DB'], false)).toBe('system file')
    expect(skipReason(['desktop.ini'], false)).toBe('system file')
    for (const f of ['main.aux', 'main.log', 'main.out', 'main.toc', 'main.synctex.gz', 'main.fdb_latexmk', 'main.fls', 'main.bbl', 'main.blg', 'MAIN.AUX']) {
      expect(skipReason([f], false), f).toBe('LaTeX build artifact')
    }
    for (const f of ['main.tex', 'refs.bib', 'fig.pdf', 'nested.zip', 'logo.png']) expect(skipReason([f], false), f).toBeNull()
  })

  it('strips a single top-level folder, skips junk, the main PDF and empty folders, detects the main file', async () => {
    const buf = craftZip([
      { name: 'paper/', method: 0 },
      { name: 'paper/paper.tex', data: '\\documentclass{article}\n\\begin{document}x\\end{document}\n' },
      { name: 'paper/paper.pdf', data: '%PDF-1.5 fake', method: 0 },
      { name: 'paper/paper.aux', data: 'aux' },
      { name: 'paper/.DS_Store', data: 'junk' },
      { name: 'paper/empty/', method: 0 },
      { name: 'paper/figs/', method: 0 },
      { name: 'paper/figs/plot.pdf', data: '%PDF-1.5 plot', method: 0 },
      { name: 'paper/inner.zip', data: craftZip([{ name: 'x.tex', data: 'x' }]), method: 0 },
      { name: '__MACOSX/', method: 0 },
      { name: '__MACOSX/paper/._paper.tex', data: 'resource fork' },
    ])
    const plan = await planImport(buf, DEFAULT_ZIP_LIMITS)
    expect(plan.files.map(f => [f.path, f.cls.kind])).toEqual([
      ['figs/plot.pdf', 'binary'], ['inner.zip', 'binary'], ['paper.tex', 'text'],
    ])
    expect(plan.folders).toEqual(['figs'])
    expect(plan.report.detectedMainFile).toBe('paper.tex')
    expect(plan.report.skipped).toEqual(expect.arrayContaining([
      { path: 'paper/paper.aux', reason: 'LaTeX build artifact' },
      { path: 'paper/.DS_Store', reason: 'system file' },
      { path: '__MACOSX/', reason: 'macOS metadata' },
      { path: '__MACOSX/paper/._paper.tex', reason: 'macOS metadata' },
      { path: 'paper/paper.pdf', reason: 'LaTeX build artifact (PDF of the main file)' },
      { path: 'paper/empty/', reason: 'empty folder' },
    ]))
    expect(plan.report.skipped).toHaveLength(6)
  })

  it('does not strip when entries sit under different top-level folders or at the root', async () => {
    const two = await planImport(craftZip([{ name: 'a/main.tex', data: 'x' }, { name: 'b/x.tex', data: 'y' }]), DEFAULT_ZIP_LIMITS)
    expect(two.files.map(f => f.path)).toEqual(['a/main.tex', 'b/x.tex'])
    const root = await planImport(craftZip([{ name: 'a/main.tex', data: 'x' }, { name: 'readme.md', data: 'y' }]), DEFAULT_ZIP_LIMITS)
    expect(root.files.map(f => f.path)).toEqual(['a/main.tex', 'readme.md'])
  })

  it('hostile entries are rejected even under __MACOSX/', async () => {
    await expect(planImport(craftZip([{ name: '__MACOSX/../../x', data: 'x' }]), DEFAULT_ZIP_LIMITS)).rejects.toMatchObject({ code: 'bad-zip' })
  })
})
