import { describe, expect, it } from 'vitest'
import { fileNameAt, looksLikeFileName, normalizePath, projectPathMapper } from '../src/paths.ts'

function nameAfterParen(line: string): string | null {
  return fileNameAt(line, line.indexOf('('))?.name ?? null
}

describe('fileNameAt', () => {
  it.each([
    ['(./main.tex', './main.tex'],
    ['(./main.tex [1] (./other.tex)', './main.tex'],
    ['(./main.tex)', './main.tex'],
    ['(./main.tex some \\message output', './main.tex'],
    ['("./chapters/my intro.tex"', './chapters/my intro.tex'],
    ['(./chapters/my intro.tex', './chapters/my intro.tex'],
    ['(/srv/ligature builds/b1/out/output.aux (/srv/ligature builds/b1/out/chapters/x.aux))', '/srv/ligature builds/b1/out/output.aux'],
    ['("/srv/ligature builds/b1/out/output.aux")', '/srv/ligature builds/b1/out/output.aux'],
    ['(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls', '/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls'],
    ['(c:/texlive/2026/texmf-dist/tex/latex/base/size10.clo)', 'c:/texlive/2026/texmf-dist/tex/latex/base/size10.clo'],
    ['(C:\\build\\src\\chapters\\intro.tex', 'C:\\build\\src\\chapters\\intro.tex'],
    ['(/usr/share/texmf/tex/generic/pgf/utilities/pgfutil-common.code.tex)', '/usr/share/texmf/tex/generic/pgf/utilities/pgfutil-common.code.tex'],
    ['(./my file.v2 draft.tex', './my file.v2 draft.tex'], // a known extension wins over ".v2"
    ['(output.aux)', 'output.aux'],
    ['(./figures/plot.pdf', './figures/plot.pdf'],
    ['(./chapters/intro (old).tex', './chapters/intro (old).tex'], // pdfTeX does not quote names with parentheses
    ['(./chapters/intro (old).tex [1] (./b.tex)', './chapters/intro (old).tex'],
    ['(/p/x (1) (2).sty)', '/p/x (1) (2).sty'],
  ])('%s -> %s', (line, want) => {
    expect(nameAfterParen(line)).toBe(want)
  })

  it.each([
    '(Font)              <7> on input line 8.',
    '(hyperref)                removing `math shift\' on input line 5.',
    'Overfull \\hbox (8.25046pt too wide) in paragraph',
    '(see the transcript file for additional information)',
    '(e.g., `\\hobx\')',
    '(Default extension: sty)',
    '(file ./fig.pdf)',
    '(There were 3 warnings)',
    '(',
    '()',
    '("unterminated',
    '( ./leading-space.tex',
    '(./.hidden)',
    '(v1.2b)',
    '(./x (y',
    '(./x (y) z',
    '(intro (old).tex', // only anchored names may contain parentheses
  ])('not a file: %s', line => {
    expect(nameAfterParen(line)).toBeNull()
  })

  it('returns the index just past the name', () => {
    const line = 'x ("./a b.tex" rest'
    const r = fileNameAt(line, 2)
    expect(r).toEqual({ name: './a b.tex', end: line.indexOf(' rest') })
  })
})

describe('projectPathMapper', () => {
  it('relative paths are project paths, cleaned', () => {
    const map = projectPathMapper(undefined)
    expect(map('./main.tex')).toBe('main.tex')
    expect(map('./chapters/./a/../intro.tex')).toBe('chapters/intro.tex')
    expect(map('chapters\\intro.tex')).toBe('chapters/intro.tex')
    expect(map('../outside.tex')).toBeNull()
    expect(map('./')).toBeNull()
    expect(map('.../user/AppData/x.tlu')).toBeNull()
  })

  it('absolute paths are project paths only inside rootDir', () => {
    const map = projectPathMapper('/srv/ligature builds/b1/src')
    expect(map('/srv/ligature builds/b1/src/main.tex')).toBe('main.tex')
    expect(map('/srv/ligature builds/b1/src/chapters/intro.tex')).toBe('chapters/intro.tex')
    expect(map('/srv/ligature builds/b1/out/output.aux')).toBeNull()
    expect(map('/srv/ligature builds/b1/srcx/main.tex')).toBeNull()
    expect(map('/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls')).toBeNull()
    expect(map('/srv/ligature builds/b1/src/../out/x.tex')).toBeNull()
    expect(map('./main.tex')).toBe('main.tex')
  })

  it('without rootDir, absolute paths are never project paths', () => {
    const map = projectPathMapper(undefined)
    expect(map('/build/src/main.tex')).toBeNull()
    expect(map('c:/build/src/main.tex')).toBeNull()
    expect(map('~/texmf/tex/latex/x.sty')).toBeNull()
  })

  it('Windows roots: backslashes, drive letter case, trailing slash', () => {
    const map = projectPathMapper('C:\\Builds\\b1\\src\\')
    expect(map('c:/Builds/b1/src/chapters/a.tex')).toBe('chapters/a.tex')
    expect(map('C:\\Builds\\b1\\src\\main.tex')).toBe('main.tex')
    expect(map('d:/Builds/b1/src/main.tex')).toBeNull()
  })

  it('an empty rootDir is ignored', () => {
    expect(projectPathMapper('  ')('/a/b.tex')).toBeNull()
  })
})

describe('helpers', () => {
  it('normalizePath', () => {
    expect(normalizePath('C:\\a\\\\b\\')).toBe('c:/a/b')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('//server/share/x')).toBe('//server/share/x')
  })

  it('looksLikeFileName', () => {
    expect(looksLikeFileName('./main.tex')).toBe(true)
    expect(looksLikeFileName('./chapters/my intro.tex')).toBe(true)
    expect(looksLikeFileName('main.tex')).toBe(true)
    expect(looksLikeFileName('Package foo Info: x.tex')).toBe(false)
    expect(looksLikeFileName('README')).toBe(false)
    expect(looksLikeFileName('a/b.c/d')).toBe(false)
    expect(looksLikeFileName(' main.tex')).toBe(false)
  })
})
