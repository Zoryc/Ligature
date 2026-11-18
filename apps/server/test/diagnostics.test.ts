import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '@ligature/shared'
import { canonicalPath, findInputsSrcRoot, findLogSrcRoot, PathMap, relativeTo } from '../src/compile/buildPaths.ts'
import { computeDiagnostics, MAX_DIAGNOSTICS, mergeDiagnostics } from '../src/compile/diagnostics.ts'

const PID = '0b6f1c2e-6a7d-4c43-9a51-3d2f1e0c9b8a'
const IDS = {
  main: '11111111-1111-4111-8111-111111111111',
  intro: '22222222-2222-4222-8222-222222222222',
  abs: '33333333-3333-4333-8333-333333333333',
  deep: '44444444-4444-4444-8444-444444444444',
}
const PATHS = {
  'main.tex': IDS.main,
  'chapters/intro.tex': IDS.intro,
  'chapters/abs.tex': IDS.abs,
  'Chapters/Sections/Deep.tex': IDS.deep,
}

describe('build paths', () => {
  it('canonicalises separators and drive letters', () => {
    expect(canonicalPath('C:\\Users\\x\\src\\main.tex')).toBe('c:/Users/x/src/main.tex')
    expect(canonicalPath('/srv/b/src/main.tex')).toBe('/srv/b/src/main.tex')
    expect(canonicalPath('./a\\b.tex')).toBe('./a/b.tex')
  })

  it('PathMap looks paths up exactly, then case-insensitively, and ids back to paths', () => {
    const m = new PathMap(PATHS)
    expect(m.fileId('main.tex')).toBe(IDS.main)
    expect(m.fileId('chapters/sections/deep.tex')).toBe(IDS.deep)
    expect(m.fileId('MAIN.TEX')).toBe(IDS.main)
    expect(m.fileId('nope.tex')).toBeUndefined()
    expect(m.fileId('constructor')).toBeUndefined()
    expect(m.fileId('__proto__')).toBeUndefined()
    expect(m.pathOf(IDS.deep)).toBe('Chapters/Sections/Deep.tex')
    expect(m.size).toBe(4)
  })

  it('finds the src root in a log by the project id, keeping spaces and drive letters', () => {
    const m = new PathMap(PATHS)
    expect(findLogSrcRoot(`x\n(/srv/ligature builds/b1/${PID}/src/chapters/abs.tex\n`, PID, m)).toBe(`/srv/ligature builds/b1/${PID}/src`)
    expect(findLogSrcRoot(`(C:\\Users\\Jane Doe\\Temp\\b\\${PID}\\src\\main.tex)`, PID, m)).toBe(`c:/Users/Jane Doe/Temp/b/${PID}/src`)
    expect(findLogSrcRoot(`Latexmk: in directory /x/${PID.toUpperCase()}/src/ now`, PID, m)).toBe(`/x/${PID.toUpperCase()}/src`)
    // The out dir is not the src dir.
    expect(findLogSrcRoot(`(/srv/b/${PID}/out/output.aux)`, PID, m)).toBeUndefined()
    expect(findLogSrcRoot('(./main.tex (./chapters/intro.tex))', PID, m)).toBeUndefined()
  })

  it('falls back to a /src/ segment followed by a file of the build', () => {
    const m = new PathMap(PATHS)
    expect(findLogSrcRoot('(/home/me/src/tools/x.sty) (/build/src/chapters/intro.tex)', undefined, m)).toBe('/build/src')
    expect(findLogSrcRoot('(/build/src/MAIN.TEX)', undefined, m)).toBe('/build/src')
    // `./src/...` is relative, not a root
    expect(findLogSrcRoot('(./src/main.tex)', undefined, new PathMap({ 'src/main.tex': IDS.main, 'main.tex': IDS.intro }))).toBeUndefined()
    expect(findLogSrcRoot('(/build/src/other.tex)', undefined, m)).toBeUndefined()
  })

  it('stays fast on hostile logs', () => {
    const m = new PathMap(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`dir/f${i}.tex`, `${i}`])))
    const log = `(/a/src/ ${'x'.repeat(10)}\n`.repeat(50_000) + `/${PID}/src/`.repeat(10_000)
    const t = performance.now()
    findLogSrcRoot(log, PID, m)
    findLogSrcRoot(log, undefined, m)
    expect(performance.now() - t).toBeLessThan(1000)
  })

  it('finds the src root of synctex inputs by project id, else by voting', () => {
    const m = new PathMap(PATHS)
    expect(findInputsSrcRoot([
      'c:/tex/texmf-dist/tex/latex/base/article.cls',
      `C:/b/${PID}/src/main.tex`,
      `C:/b/${PID}/out/output.aux`,
    ], PID, m)).toBe(`c:/b/${PID}/src`)
    expect(findInputsSrcRoot(['/usr/share/src/main.tex', '/build/src/main.tex', '/build/src/chapters/intro.tex'], undefined, m)).toBe('/build/src')
    // tie: shortest root
    expect(findInputsSrcRoot(['/x/y/src/main.tex', '/x/src/main.tex'], undefined, m)).toBe('/x/src')
    expect(findInputsSrcRoot(['/usr/local/texlive/article.cls'], undefined, m)).toBeUndefined()
  })

  it('relativeTo keeps paths inside the root only', () => {
    expect(relativeTo('/b/src', '/b/src/chapters/intro.tex')).toBe('chapters/intro.tex')
    expect(relativeTo('c:/b/src', 'C:\\b\\src\\main.tex')).toBe('main.tex')
    expect(relativeTo('/b/src', '/b/srcx/main.tex')).toBeNull()
    expect(relativeTo('/b/src', '/b/src')).toBeNull()
    expect(relativeTo('/b/src', '/b/src/../out/output.aux')).toBeNull()
    expect(relativeTo('/b/src', '/b/out/output.aux')).toBeNull()
  })
})

/** A pdfTeX-style log (unwrapped, file:line:error), sanitised. */
const LOG = [
  'This is pdfTeX, Version 3.141592653-2.6-1.40.29 (TeX Live 2026) (preloaded format=pdflatex)',
  ' file:line:error style messages enabled.',
  '**main.tex',
  '(./main.tex',
  'LaTeX2e <2026-11-01>',
  '(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls',
  'Document Class: article 2026-06-04 v1.4n Standard LaTeX document class',
  '(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size10.clo',
  'File: size10.clo 2026-06-04 v1.4n Standard LaTeX file (size option)',
  '))',
  `(/srv/ligature builds/b1/${PID}/src/chapters/abs.tex`,
  `/srv/ligature builds/b1/${PID}/src/chapters/abs.tex:4: Undefined control sequence.`,
  'l.4 \\foo',
  '        ',
  'The control sequence at the end of the top line',
  'of your error message was never \\def\'ed.',
  '',
  ')',
  '(./chapters/intro.tex',
  './chapters/intro.tex:3: Undefined control sequence.',
  'l.3 Second paragraph \\undefinedmacro',
  '                                    {} here.',
  '',
  'LaTeX Warning: Reference `sec:x\' on page 1 undefined on input line 5.',
  '',
  ') (./chapters/sections/deep.tex',
  'Overfull \\hbox (12.0pt too wide) in paragraph at lines 7--9',
  '[]\\OT1/cmr/m/n/10 x',
  ') (./ghost.tex',
  'LaTeX Warning: Citation `knuth\' on page 1 undefined on input line 2.',
  ')',
  'LaTeX Warning: There were undefined references.',
  `(/srv/ligature builds/b1/${PID}/out/output.aux) )`,
  'Output written on output.pdf (1 page, 15157 bytes).',
].join('\n')

describe('computeDiagnostics', () => {
  it('maps parsed diagnostics to file ids, with paths relative to the src dir', () => {
    const d = computeDiagnostics({ log: LOG, paths: PATHS, projectId: PID })
    expect(d.filter(x => x.severity === 'error')).toEqual([
      { severity: 'error', kind: 'tex', message: 'Undefined control sequence \\foo', fileId: IDS.abs, path: 'chapters/abs.tex', line: 4 },
      { severity: 'error', kind: 'tex', message: 'Undefined control sequence \\undefinedmacro', fileId: IDS.intro, path: 'chapters/intro.tex', line: 3 },
    ])
    expect(d).toContainEqual(expect.objectContaining({
      severity: 'warning', kind: 'undefined-reference', fileId: IDS.intro, path: 'chapters/intro.tex', line: 5,
    }))
    // case-insensitive match: TeX printed the spelling used in \input
    expect(d).toContainEqual({
      severity: 'info', kind: 'badbox', message: expect.stringContaining('Overfull'), fileId: IDS.deep,
      path: 'Chapters/Sections/Deep.tex', line: 7, endLine: 9,
    })
    // a path that is not a file of the build keeps its path, without a file id
    const cite = d.find(x => x.kind === 'undefined-citation')!
    expect(cite).toMatchObject({ path: 'ghost.tex', line: 2 })
    expect(cite.fileId).toBeUndefined()
    // only contract fields (no `raw`)
    for (const x of d) {
      expect(Object.keys(x).every(k => ['severity', 'kind', 'message', 'fileId', 'path', 'line', 'endLine'].includes(k))).toBe(true)
    }
    // errors first
    const sev = d.map(x => x.severity)
    expect(sev).toEqual([...sev].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)))
    // no TeX Live or out-dir paths leak
    expect(d.every(x => x.path === undefined || !x.path.startsWith('/'))).toBe(true)
  })

  it('an explicit rootDir (as reported by a worker) wins', () => {
    const d = computeDiagnostics({ log: LOG, paths: PATHS, rootDir: `/srv/ligature builds/b1/${PID}/src` })
    expect(d[0]).toMatchObject({ fileId: IDS.abs, line: 4 })
  })

  it('without the project id, the src dir is found as a /src/ segment followed by a file of the build', () => {
    const d = computeDiagnostics({ log: LOG, paths: PATHS })
    expect(d[0]).toMatchObject({ severity: 'error', fileId: IDS.abs, path: 'chapters/abs.tex', line: 4 })
  })

  it('an absolute path outside the src dir is never taken for a project file', () => {
    const log = LOG.replaceAll(`/srv/ligature builds/b1/${PID}/src/chapters/abs.tex`, '/home/eve/chapters/abs.tex')
    const d = computeDiagnostics({ log, paths: PATHS, projectId: PID })
    expect(d[0]).toMatchObject({ severity: 'error', message: 'Undefined control sequence \\foo' })
    expect(d[0]!.fileId).not.toBe(IDS.abs)
    expect(d[0]!.path ?? '').not.toContain('/home/')
  })

  it('empty or junk logs give no diagnostics and never throw', () => {
    expect(computeDiagnostics({ log: '', paths: PATHS })).toEqual([])
    expect(computeDiagnostics({ log: '(((((\u0000))', paths: {} })).toEqual([])
  })

  it('caps at 500, errors first', () => {
    const log = ['(./main.tex', ...Array.from({ length: 400 }, (_, i) => `Overfull \\hbox (1.0pt too wide) in paragraph at lines ${i + 1}--${i + 1}`),
      ...Array.from({ length: 300 }, (_, i) => `./main.tex:${i + 1}: Undefined control sequence.\nl.${i + 1} \\x${i}`), ')'].join('\n')
    const d = computeDiagnostics({ log, paths: PATHS })
    expect(d.length).toBe(MAX_DIAGNOSTICS)
    const errors = d.filter(x => x.severity === 'error').length
    expect(errors).toBeGreaterThan(100)
    expect(d.slice(0, errors).every(x => x.severity === 'error' && x.fileId === IDS.main)).toBe(true)
    expect(d.slice(errors).every(x => x.severity === 'info')).toBe(true)
  })
})

describe('mergeDiagnostics', () => {
  it('keeps server-made diagnostics, sorts by severity (stable) and caps', () => {
    const w: Diagnostic = { severity: 'warning', kind: 'latex', message: 'w' }
    const e: Diagnostic = { severity: 'error', kind: 'no-main-file', message: 'e' }
    const i: Diagnostic = { severity: 'info', kind: 'badbox', message: 'i' }
    expect(mergeDiagnostics([e], [i, w, { ...e, message: 'e2' }])).toEqual([e, { ...e, message: 'e2' }, w, i])
    expect(mergeDiagnostics([], Array.from({ length: 600 }, () => w)).length).toBe(MAX_DIAGNOSTICS)
  })
})
