import { describe, expect, it } from 'vitest'
import type { TreeEntry } from '@ligature/shared'
import { parseLog, normalizeLogPath } from '../src/lib/logParse.ts'
import { textFilesByPath, treeRows } from '../src/lib/tree.ts'
import { userColor } from '../src/lib/colors.ts'

describe('parseLog', () => {
  it('picks out file-line-error lines', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653',
      './main.tex:12: Undefined control sequence.',
      'l.12 \\foo',
      'chapters/intro.tex:3: LaTeX Error: Environment bar undefined.',
      'Output written on output.pdf (1 page).',
    ].join('\r\n')
    const lines = parseLog(log)
    expect(lines).toHaveLength(5)
    expect(lines[0]!.error).toBeUndefined()
    expect(lines[1]!.error).toEqual({ file: 'main.tex', line: 12, message: 'Undefined control sequence.' })
    expect(lines[2]!.text).toBe('l.12 \\foo')
    expect(lines[3]!.error).toEqual({ file: 'chapters/intro.tex', line: 3, message: 'LaTeX Error: Environment bar undefined.' })
    expect(lines[4]!.error).toBeUndefined()
  })

  it('rejects line 0 and normalises paths', () => {
    expect(parseLog('a.tex:0: x')[0]!.error).toBeUndefined()
    expect(normalizeLogPath('./a\\b.tex')).toBe('a/b.tex')
  })
})

describe('treeRows', () => {
  const tree: TreeEntry[] = [
    { id: 'r', parentId: null, name: '', kind: 'folder' },
    { id: 'm', parentId: 'r', name: 'main.tex', kind: 'text', epoch: 1 },
    { id: 'c', parentId: 'r', name: 'chapters', kind: 'folder' },
    { id: 'i', parentId: 'c', name: 'intro.tex', kind: 'text', epoch: 2 },
    { id: 'p', parentId: 'r', name: 'a.png', kind: 'binary' },
  ]

  it('lists folders first, depth-first, with paths', () => {
    const rows = treeRows(tree, 'r')
    expect(rows.map(r => [r.path, r.depth])).toEqual([
      ['chapters', 0], ['chapters/intro.tex', 1], ['a.png', 0], ['main.tex', 0],
    ])
    expect([...textFilesByPath(rows).keys()]).toEqual(['chapters/intro.tex', 'main.tex'])
  })

  it('survives a cycle', () => {
    const bad: TreeEntry[] = [
      { id: 'r', parentId: null, name: '', kind: 'folder' },
      { id: 'a', parentId: 'b', name: 'a', kind: 'folder' },
      { id: 'b', parentId: 'a', name: 'b', kind: 'folder' },
    ]
    expect(treeRows(bad, 'r')).toEqual([])
  })
})

describe('userColor', () => {
  it('is stable and hex', () => {
    const a = userColor('user-1')
    expect(a).toEqual(userColor('user-1'))
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(a.colorLight).toBe(`${a.color}33`)
  })
})
