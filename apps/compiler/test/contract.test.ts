import { describe, expect, it } from 'vitest'
import * as shared from '@ligature/shared'
import * as local from '../src/contract.ts'

// The worker keeps local copies of the runtime parts of the contract (see src/contract.ts).
// These cases must give the same answer in both.
const PATH_CASES = [
  'main.tex', 'chapters/intro.tex', 'a/b/c/d.tex', 'images/fig 1.png', 'ünïcödé.tex', '-dash.tex', '__proto__',
  '', '.', '..', '../x.tex', 'a/../b.tex', './a.tex', '/etc/passwd', 'a//b.tex', 'a/', '/a', 'a\\b.tex',
  'C:\\x.tex', 'c:x', 'a\u0000b', 'tab\there', 'line\nbreak', ' lead.tex', 'trail.tex ', 'q?.tex', 'st*r.tex',
  'pipe|.tex', 'lt<.tex', 'quote".tex', 'del\u007f.tex', 'x'.repeat(255), 'x'.repeat(256),
  Array.from({ length: 32 }, () => 'd').join('/'), Array.from({ length: 33 }, () => 'd').join('/'),
  `${'abcdefghij/'.repeat(93)}x.tex`, `${'abcdefghij/'.repeat(94)}x.tex`,
]

describe('local contract copies agree with @ligature/shared', () => {
  it.each(PATH_CASES.map(p => [p]))('isValidRelPath(%j)', p => {
    expect(local.isValidRelPath(p)).toBe(shared.isValidRelPath(p))
  })

  it.each(PATH_CASES.map(p => [p]))('isValidName(%j)', p => {
    expect(local.isValidName(p)).toBe(shared.isValidName(p))
  })

  it('constants', () => {
    expect([...local.ENGINES]).toEqual([...shared.ENGINES])
    expect([...local.OUTPUT_NAMES]).toEqual([...shared.OUTPUT_NAMES])
    expect(local.MAX_NAME_LEN).toBe(shared.MAX_NAME_LEN)
    expect(local.MAX_PATH_LEN).toBe(shared.MAX_PATH_LEN)
    expect(local.MAX_DEPTH).toBe(shared.MAX_DEPTH)
  })

  it('the case list exercises both answers', () => {
    const answers = new Set(PATH_CASES.map(p => shared.isValidRelPath(p)))
    expect(answers).toEqual(new Set([true, false]))
  })
})
