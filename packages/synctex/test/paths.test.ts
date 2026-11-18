import { describe, expect, it } from 'vitest'
import { normalizePath, tagsForPath } from '../src/index.ts'

describe('normalizePath', () => {
  it.each([
    ['/build/src/./main.tex', '/build/src/main.tex'],
    ['/build/src/./chapters//intro.tex', '/build/src/chapters/intro.tex'],
    ['./main.tex', 'main.tex'],
    ['chapters/../main.tex', 'main.tex'],
    ['../up.tex', '../up.tex'],
    ['/../x.tex', '/x.tex'],
    ['C:\\Users\\me\\proj\\.\\main.tex', 'C:/Users/me/proj/main.tex'],
    ['C:/../x.tex', 'C:/../x.tex'],
    ['', ''],
  ])('%s -> %s', (input, want) => {
    expect(normalizePath(input)).toBe(want)
  })
})

describe('tagsForPath', () => {
  const inputs = new Map([
    [1, '/build/src/main.tex'],
    [2, '/build/src/chapters/intro.tex'],
    [3, '/build/src/intro.tex'],
    [4, '/build/src/chapters/intro.tex'],
    [5, '/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls'],
  ])
  it('matches exactly, all tags of the same file', () => {
    expect([...tagsForPath(inputs, '/build/src/chapters/intro.tex')]).toEqual([2, 4])
    expect([...tagsForPath(inputs, '/build/src/./main.tex')]).toEqual([1])
  })
  it('matches a relative path as a suffix, preferring the shortest path', () => {
    expect([...tagsForPath(inputs, 'main.tex')]).toEqual([1])
    expect([...tagsForPath(inputs, './chapters/intro.tex')]).toEqual([2, 4])
    expect([...tagsForPath(inputs, 'intro.tex')]).toEqual([3])
  })
  it('does not match partial names, other absolute paths or empty paths', () => {
    expect(tagsForPath(inputs, 'ain.tex').size).toBe(0)
    expect(tagsForPath(inputs, '/other/main.tex').size).toBe(0)
    expect(tagsForPath(inputs, '').size).toBe(0)
    expect(tagsForPath(inputs, '.').size).toBe(0)
  })
})
