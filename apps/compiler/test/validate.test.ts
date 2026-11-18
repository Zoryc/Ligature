import { describe, expect, it } from 'vitest'
import { isHash, isUuid } from '../src/contract.ts'
import { mainFileProblem, parseCompileRequest, parseManifest, parseSyncRequest } from '../src/validate.ts'

const H = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

describe('ids and hashes', () => {
  it('uuid', () => {
    expect(isUuid('85043672-fc4b-4a10-81fd-34afaeb30e00')).toBe(true)
    expect(isUuid('85043672-FC4B-4a10-81fd-34afaeb30e00')).toBe(false)
    expect(isUuid('85043672fc4b4a1081fd34afaeb30e00')).toBe(false)
    expect(isUuid('../../etc')).toBe(false)
    expect(isUuid('85043672-fc4b-4a10-81fd-34afaeb30e00\n')).toBe(false)
  })
  it('hash', () => {
    expect(isHash(H)).toBe(true)
    expect(isHash('A'.repeat(64))).toBe(false)
    expect(isHash('a'.repeat(63))).toBe(false)
    expect(isHash('g'.repeat(64))).toBe(false)
  })
})

describe('parseManifest', () => {
  it('accepts a normal manifest', () => {
    const r = parseManifest({ 'main.tex': H, 'chapters/a.tex': H2, 'img/x.png': H })
    expect(r.ok).toBe(true)
  })

  it.each([
    [null], [[]], ['x'], [{ '../x.tex': H }], [{ '/etc/passwd': H }], [{ 'a/../../b': H }], [{ 'a\\b.tex': H }],
    [{ 'C:/x.tex': H }], [{ 'a//b': H }], [{ 'main.tex': 'A'.repeat(64) }], [{ 'main.tex': 42 }], [{ 'nul\u0000.tex': H }],
    [{ a: H, 'a/b.tex': H2 }],
  ])('rejects %j', m => {
    expect(parseManifest(m).ok).toBe(false)
  })

  it('keeps a __proto__ path as an ordinary key', () => {
    const r = parseManifest(JSON.parse(`{"__proto__":"${H}"}`))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Object.keys(r.value)).toEqual(['__proto__'])
      expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype)
    }
  })

  it('rejects too many entries', () => {
    const m: Record<string, string> = {}
    for (let i = 0; i < 20_001; i++) m[`f${i}.tex`] = H
    expect(parseManifest(m).ok).toBe(false)
  })
})

describe('parseSyncRequest / parseCompileRequest', () => {
  const base = { manifest: { 'main.tex': H, 'sub/x.tex': H2 }, mainFile: 'main.tex', engine: 'pdflatex' }

  it('sync: only { manifest }', () => {
    expect(parseSyncRequest({ manifest: {} }).ok).toBe(true)
    expect(parseSyncRequest({ manifest: {}, extra: 1 }).ok).toBe(false)
  })

  it('compile: defaults', () => {
    const r = parseCompileRequest(base, 300_000)
    expect(r).toEqual({ ok: true, value: { ...base, clean: false, timeoutMs: 90_000 } })
  })

  it.each([
    [{ ...base, mainFile: '../main.tex' }],
    [{ ...base, mainFile: 42 }],
    [{ ...base, mainFile: 'a\\b.tex' }],
    [{ ...base, engine: 'tectonic' }],
    // malformed in another way: still a 400 even though the main file is also unbuildable
    [{ ...base, mainFile: 'missing.tex', engine: 'tectonic' }],
    [{ ...base, clean: 'yes' }],
    [{ ...base, timeoutMs: 10 }],
    [{ ...base, timeoutMs: 1_000_000 }],
    [{ ...base, timeoutMs: 1.5e3 + 0.5 }],
    [{ ...base, shellEscape: true }],
  ])('compile rejects %j', body => {
    expect(parseCompileRequest(body, 300_000).ok).toBe(false)
  })

  // latexmk runs `pdflatex %O "%S"` through /bin/sh: $(...), backticks and $VAR expand inside the quotes.
  it.each([
    'missing.tex', 'main.sty', '-x.tex', '$(touch pwned).tex', '`id`.tex', '$HOME.tex', 'a;b.tex', 'a&b.tex',
    "it's.tex", 'a%b.tex', 'a#b.tex', 'a(b).tex', '~x.tex', '.hidden.tex', 'sub/-x.tex', '$(x)/main.tex',
    'a{b}.tex', 'a[b].tex', 'a!b.tex', 'a^b.tex', '&fmt.tex',
  ])('compile: main file %j is unbuildable (200 failure, not 400)', mainFile => {
    const manifest = { 'main.tex': H, [mainFile]: H2 }
    if (mainFile === 'missing.tex') delete (manifest as Record<string, string>)[mainFile]
    const r = parseCompileRequest({ ...base, manifest, mainFile }, 300_000)
    expect(r.ok).toBe('unbuildable')
    if (r.ok === 'unbuildable') {
      expect(r.value.problem).toContain(mainFile)
      expect(mainFileProblem(mainFile, manifest)).toBe(r.value.problem)
    }
  })

  it.each(['main.tex', 'My Thesis.tex', 'sub dir/ch_1.tex', 'thèse-v2.tex', 'Θέμα.tex', 'a+b,c=d@e.TEX', '_x.tex', '2024/paper.tex'])(
    'compile: main file %j is fine', mainFile => {
      const r = parseCompileRequest({ ...base, manifest: { [mainFile]: H }, mainFile }, 300_000)
      expect(r.ok).toBe(true)
    })

  it('compile accepts the other engines and explicit options', () => {
    for (const engine of ['xelatex', 'lualatex']) {
      expect(parseCompileRequest({ ...base, engine, clean: true, timeoutMs: 5000 }, 300_000).ok).toBe(true)
    }
    expect(parseCompileRequest({ ...base, mainFile: 'sub/x.tex' }, 300_000).ok).toBe(true)
  })
})
