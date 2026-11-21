import { describe, expect, it } from 'vitest'
import {
  CITE_COMMANDS, CLASSES, COMMANDS, COMMON_COMMANDS, DISPLAY_MATH_ENVIRONMENTS, ENVIRONMENTS, GRAPHICS_COMMANDS,
  INPUT_COMMANDS, PACKAGE_COMMANDS, PACKAGES, parseArgs, REF_COMMANDS,
} from '../src/lib/latex/completionData.ts'
import type { ArgSpec } from '../src/lib/latex/completionTypes.ts'

const dupes = (names: readonly string[]) => names.filter((n, i) => names.indexOf(n) !== i)
const cmd = (name: string) => COMMANDS.find(c => c.name === name)
const env = (name: string) => ENVIRONMENTS.find(e => e.name === name)
const R = (name: string): ArgSpec => ({ kind: 'required', name })
const O = (name: string): ArgSpec => ({ kind: 'optional', name })
/** A command's pkg is a package, or beamer (a class). */
const PROVIDERS = [...PACKAGES, ...CLASSES]

function validArgs(args: ArgSpec[]) {
  for (const a of args) {
    expect(['required', 'optional']).toContain(a.kind)
    expect(a.name.trim()).toBe(a.name)
    expect(a.name.length).toBeGreaterThan(0)
    expect(a.name).not.toMatch(/[{}[\]]/)
  }
}

describe('parseArgs', () => {
  it('reads [optional]{required} in order and rejects anything else', () => {
    expect(parseArgs('')).toEqual([])
    expect(parseArgs('[n]{radicand}')).toEqual([O('n'), R('radicand')])
    expect(parseArgs('{a}{b c}[d]')).toEqual([R('a'), R('b c'), O('d')])
    for (const bad of ['x', '{a', '[a]x', '{}', '{a} {b}']) expect(() => parseArgs(bad), bad).toThrow()
  })
})

describe('COMMANDS', () => {
  it('about 400, unique names, plain names, valid argument shapes', () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(380)
    expect(dupes(COMMANDS.map(c => c.name))).toEqual([])
    for (const c of COMMANDS) {
      expect(c.name, c.name).toMatch(/^[A-Za-z]+$/) // no backslash, no star
      validArgs(c.args)
      expect(c.detail, c.name).toBeTruthy()
      if (c.pkg !== undefined) expect(PROVIDERS, `${c.name}: ${c.pkg}`).toContain(c.pkg)
      if (c.math !== undefined) expect(c.math).toBe(true) // absent rather than false
    }
  })

  it('well-known shapes', () => {
    expect(cmd('frac')).toMatchObject({ args: [R('numerator'), R('denominator')], math: true })
    expect(cmd('frac')!.pkg).toBeUndefined()
    expect(cmd('sqrt')!.args).toEqual([O('n'), R('radicand')])
    expect(cmd('section')!.args).toEqual([O('short title'), R('title')])
    expect(cmd('includegraphics')).toMatchObject({ args: [O('options'), R('file')], pkg: 'graphicx' })
    expect(cmd('href')).toMatchObject({ args: [R('url'), R('text')], pkg: 'hyperref' })
    expect(cmd('SI')).toMatchObject({ pkg: 'siunitx' })
    expect(cmd('SI')!.args.filter(a => a.kind === 'required')).toEqual([R('value'), R('unit')])
    expect(cmd('usepackage')!.args).toEqual([O('options'), R('package')])
    expect(cmd('documentclass')!.args).toEqual([O('options'), R('class')])
    expect(cmd('newcommand')!.args.map(a => a.kind)).toEqual(['required', 'optional', 'required'])
    expect(cmd('textcolor')).toMatchObject({ args: [R('color'), R('text')], pkg: 'xcolor' })
    expect(cmd('eqref')).toMatchObject({ pkg: 'amsmath' })
    expect(cmd('cref')).toMatchObject({ pkg: 'cleveref' })
    expect(cmd('mathbb')).toMatchObject({ pkg: 'amssymb', math: true })
    expect(cmd('toprule')).toMatchObject({ pkg: 'booktabs' })
    expect(cmd('frametitle')).toMatchObject({ pkg: 'beamer', args: [R('title')] })
    expect(cmd('draw')).toMatchObject({ pkg: 'tikz' })
    expect(cmd('textbf')).toMatchObject({ args: [R('text')] })
    expect(cmd('textbf')!.math).toBeUndefined()
    expect(cmd('alpha')).toEqual({ name: 'alpha', args: [], detail: 'Greek letter α', math: true })
    expect(cmd('maketitle')!.args).toEqual([])
  })

  it('all Greek letters, and the common math families', () => {
    const lower = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa',
      'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega']
    const upper = ['Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega']
    const variants = ['varepsilon', 'vartheta', 'varpi', 'varrho', 'varsigma', 'varphi']
    const sample = ['sum', 'int', 'lim', 'sin', 'log', 'leq', 'neq', 'approx', 'in', 'subseteq', 'rightarrow',
      'Rightarrow', 'mapsto', 'infty', 'partial', 'nabla', 'forall', 'exists', 'langle', 'rangle', 'hat', 'vec',
      'bar', 'dot', 'times', 'cdot', 'pm', 'cdots', 'binom', 'text', 'operatorname', 'mathcal']
    for (const n of [...lower, ...upper, ...variants, ...sample]) {
      expect(cmd(n), n).toBeDefined()
      expect(cmd(n)!.math, n).toBe(true)
    }
  })

  it('common commands are known commands', () => {
    expect(dupes(COMMON_COMMANDS)).toEqual([])
    for (const n of COMMON_COMMANDS) expect(cmd(n), n).toBeDefined()
  })
})

describe('ENVIRONMENTS', () => {
  it('about 60, unique, valid shapes and packages', () => {
    expect(ENVIRONMENTS.length).toBeGreaterThanOrEqual(55)
    expect(dupes(ENVIRONMENTS.map(e => e.name))).toEqual([])
    for (const e of ENVIRONMENTS) {
      expect(e.name, e.name).toMatch(/^[A-Za-z]+\*?$/)
      validArgs(e.args)
      if (e.pkg !== undefined) expect(PROVIDERS, `${e.name}: ${e.pkg}`).toContain(e.pkg)
      if (e.math !== undefined) expect(e.math).toBe(true)
    }
  })

  it('math flag: inner math environments only; starred forms agree with unstarred ones', () => {
    const inner = ['cases', 'dcases', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix',
      'smallmatrix', 'split', 'aligned', 'alignedat', 'gathered', 'array']
    for (const n of inner) expect(env(n)?.math, n).toBe(true)
    for (const n of DISPLAY_MATH_ENVIRONMENTS) {
      expect(env(n), n).toBeDefined()
      expect(env(n)!.math, n).toBeUndefined() // they start math from text
    }
    const flagged = ENVIRONMENTS.filter(e => e.math).map(e => e.name.replace(/\*$/, ''))
    for (const n of flagged) expect(inner, n).toContain(n)
    for (const e of ENVIRONMENTS.filter(x => x.name.endsWith('*'))) {
      const base = env(e.name.slice(0, -1))
      expect(base, e.name).toBeDefined()
      expect(e.math, e.name).toBe(base!.math)
    }
  })

  it('well-known shapes and bodies', () => {
    expect(env('itemize')!.body).toBe('\\item ')
    expect(env('enumerate')!.body).toBe('\\item ')
    expect(env('figure')!.args).toEqual([O('placement')])
    expect(env('table')!.args).toEqual([O('placement')])
    expect(env('tabular')!.args).toEqual([O('position'), R('columns')])
    expect(env('tabularx')).toMatchObject({ args: [R('width'), R('columns')], pkg: 'tabularx' })
    expect(env('minipage')!.args.filter(a => a.kind === 'required')).toEqual([R('width')])
    expect(env('align')).toMatchObject({ pkg: 'amsmath', args: [] })
    expect(env('equation')!.args).toEqual([])
    expect(env('frame')).toMatchObject({ pkg: 'beamer' })
    expect(env('tikzpicture')).toMatchObject({ pkg: 'tikz' })
    expect(env('thebibliography')!.args).toEqual([R('widest label')])
    for (const n of ['document', 'abstract', 'center', 'quote', 'verbatim', 'lstlisting', 'proof', 'theorem',
      'longtable', 'gather', 'multline']) expect(env(n), n).toBeDefined()
  })
})

describe('PACKAGES and CLASSES', () => {
  it('about 120 unique packages, the spec classes', () => {
    expect(PACKAGES.length).toBeGreaterThanOrEqual(110)
    expect(dupes(PACKAGES)).toEqual([])
    for (const p of PACKAGES) expect(p).toMatch(/^[a-z][a-z0-9-]*$/i)
    for (const p of ['amsmath', 'graphicx', 'hyperref', 'xcolor', 'siunitx', 'booktabs', 'cleveref', 'biblatex',
      'natbib', 'tikz', 'geometry']) expect(PACKAGES).toContain(p)
    expect(dupes(CLASSES)).toEqual([])
    expect(CLASSES.slice(0, 10)).toEqual(['article', 'report', 'book', 'memoir', 'beamer', 'letter', 'scrartcl',
      'scrreprt', 'scrbook', 'amsart'])
  })
})

describe('argument-completion command sets', () => {
  const sets = { REF_COMMANDS, CITE_COMMANDS, INPUT_COMMANDS, GRAPHICS_COMMANDS, PACKAGE_COMMANDS }

  it('match the spec', () => {
    for (const n of ['ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'Cref', 'vref']) expect(REF_COMMANDS).toContain(n)
    for (const n of ['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite', 'footcite', 'nocite',
      'citeauthor', 'citeyear']) expect(CITE_COMMANDS).toContain(n)
    expect([...INPUT_COMMANDS].sort()).toEqual(['include', 'input', 'subfile'])
    expect(GRAPHICS_COMMANDS).toEqual(['includegraphics'])
    expect([...PACKAGE_COMMANDS].sort()).toEqual(['RequirePackage', 'usepackage'])
  })

  it('are disjoint, without duplicates, and every name is a known command with a required argument', () => {
    const all = Object.values(sets).flat()
    expect(dupes(all)).toEqual([])
    for (const [setName, names] of Object.entries(sets)) {
      for (const n of names) {
        expect(cmd(n), `${setName}: ${n}`).toBeDefined()
        expect(cmd(n)!.args.some(a => a.kind === 'required'), `${setName}: ${n}`).toBe(true)
      }
    }
  })
})
