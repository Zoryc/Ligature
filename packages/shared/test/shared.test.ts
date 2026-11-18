import { describe, expect, it } from 'vitest'
import { can, fileDocName, isValidName, isValidRelPath, metaDocName, parseDocName } from '../src/index.ts'

const P = '85043672-fc4b-4a10-81fd-34afaeb30e00'
const F = 'e4efee72-09bf-4ff6-b4d5-737872cee5af'

describe('doc names', () => {
  it('round-trips file and meta names', () => {
    expect(parseDocName(fileDocName(P, F, 1))).toEqual({ kind: 'file', projectId: P, fileId: F, epoch: 1 })
    expect(parseDocName(fileDocName(P, F, 123456789))).toEqual({ kind: 'file', projectId: P, fileId: F, epoch: 123456789 })
    expect(parseDocName(metaDocName(P))).toEqual({ kind: 'meta', projectId: P })
  })

  it.each([
    '',
    `proj/${P}/file/${F}/g0`, // epochs start at 1
    `proj/${P}/file/${F}/g01`,
    `proj/${P}/file/${F}/g1234567890`, // too long
    `proj/${P}/file/${F}/g1/extra`,
    `proj/${P}/file/${F}`,
    `proj/${P.toUpperCase()}/meta`,
    `proj/${P}/meta/`,
    `proj/../file/${F}/g1`,
    `x/proj/${P}/meta`,
    `proj/${P}/file/${F}/gd`,
  ])('rejects %j', name => {
    expect(parseDocName(name)).toBeNull()
  })
})

describe('path validation', () => {
  it.each(['main.tex', 'chapters', 'Figure 1.png', 'é.tex', 'a'.repeat(255)])('accepts name %j', n => {
    expect(isValidName(n)).toBe(true)
  })

  it.each(['', '.', '..', 'a/b', 'a\\b', 'C:', 'a\u0000b', 'a\nb', ' lead', 'trail ', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a'.repeat(256)])(
    'rejects name %j', n => {
      expect(isValidName(n)).toBe(false)
    })

  it('validates relative paths', () => {
    expect(isValidRelPath('main.tex')).toBe(true)
    expect(isValidRelPath('chapters/intro.tex')).toBe(true)
    expect(isValidRelPath('/etc/passwd')).toBe(false)
    expect(isValidRelPath('../x.tex')).toBe(false)
    expect(isValidRelPath('a/../../x')).toBe(false)
    expect(isValidRelPath('a//b')).toBe(false)
    expect(isValidRelPath('a/')).toBe(false)
    expect(isValidRelPath(Array(33).fill('d').join('/'))).toBe(false)
  })
})

describe('roles', () => {
  it('only owners and editors edit or compile', () => {
    expect(can.edit('owner')).toBe(true)
    expect(can.edit('editor')).toBe(true)
    expect(can.edit('viewer')).toBe(false)
    expect(can.compile('viewer')).toBe(false)
    expect(can.manageMembers('editor')).toBe(false)
  })
})
