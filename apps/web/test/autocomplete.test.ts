import { describe, expect, it } from 'vitest'
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete'
import { indexBib, indexTex, ProjectIndex, xparseArgs } from '../src/lib/latex/projectIndex.ts'
import {
  beginHasEnd, closingEnvironments, commandTemplate, commentStart, detectContext, environmentTemplate, inMath,
  latexCompletion, openEnvironments, pathSuggestions, relativePath, shortAuthor, userArgs, type CommandSets,
  type CompletionData,
} from '../src/lib/latex/latexCompletion.ts'
import { groups, scanSource } from '../src/lib/outline.ts'
import { ProjectTexts } from '../src/lib/projectTexts.ts'

/** Enough of an EditorView for the completions' apply functions: they read `state` and dispatch. */
function fakeView(doc: string, cursor = doc.length) {
  const view = {
    state: EditorState.create({ doc, selection: { anchor: cursor } }),
    dispatch(...specs: (Transaction | TransactionSpec)[]) {
      const [first] = specs
      view.state = (first instanceof Transaction ? first : view.state.update(...(specs as TransactionSpec[]))).state
    },
  }
  return view
}

/** Accept `completion` over from..to, as CodeMirror's applyCompletion does. */
function accept(view: ReturnType<typeof fakeView>, completion: Completion | undefined, from: number, to: number) {
  if (!completion || typeof completion.apply !== 'function') throw new Error('no apply function')
  completion.apply(view as unknown as EditorView, completion, from, to)
}

/** Snippets indent the body with the state's indent unit; tests compare without it. */
const unindent = (s: string) => s.replace(/\n[ \t]+/g, '\n')

// Small fixtures: the tests must not depend on the full built-in lists.
const SETS: CommandSets = {
  ref: new Set(['ref', 'eqref', 'cref']),
  cite: new Set(['cite', 'citet', 'parencite']),
  input: new Set(['input', 'include']),
  graphics: new Set(['includegraphics']),
  package: new Set(['usepackage', 'RequirePackage']),
}
const DISPLAY = new Set(['equation', 'equation*', 'align', 'align*'])

const DATA: CompletionData = {
  commands: [
    { name: 'frac', args: [{ kind: 'required', name: 'numerator' }, { kind: 'required', name: 'denominator' }], pkg: 'amsmath', detail: 'fraction', math: true },
    { name: 'section', args: [{ kind: 'optional', name: 'short title' }, { kind: 'required', name: 'title' }], detail: 'section' },
    { name: 'alpha', args: [], detail: 'Greek letter', math: true },
    { name: 'author', args: [{ kind: 'required', name: 'names' }], detail: 'authors' },
    { name: 'sec', args: [], detail: 'secant', math: true },
  ],
  environments: [
    { name: 'itemize', args: [], body: '\\item ' },
    { name: 'tabular', args: [{ kind: 'optional', name: 'pos' }, { kind: 'required', name: 'columns' }] },
    { name: 'cases', args: [], math: true },
  ],
  packages: ['amsmath', 'graphicx', 'geometry'],
  classes: ['article', 'book'],
  common: ['section', 'frac'],
  displayMath: [...DISPLAY],
  refCommands: ['ref', 'eqref', 'cref'],
  citeCommands: ['cite', 'citet', 'parencite'],
  inputCommands: ['input', 'include'],
  graphicsCommands: ['includegraphics'],
  packageCommands: ['usepackage'],
}

describe('project index: .tex', () => {
  it('finds labels with what they label: heading, environment, caption; never in comments', () => {
    const tex = [
      '\\section{Intro to $\\alpha$}\\label{sec:intro}', // 1
      '% \\label{commented}', // 2
      'Text \\label{after-heading}', // 3
      '\\begin{figure}', // 4
      '  \\centering', // 5
      '  \\begin{center}\\caption[Short]{A \\emph{nice} plot}\\label{fig:plot}\\end{center}', // 6
      '\\end{figure}', // 7
      '\\begin{equation}\\label{eq:e} e = mc^2 \\end{equation}', // 8
      'A line break\\\\label{not-a-label}', // 9
      '50\\% \\label{after-percent}', // 10
    ].join('\n')
    const { labels } = indexTex(tex, 'f1')
    expect(labels).toEqual([
      { name: 'sec:intro', fileId: 'f1', line: 1, context: 'Intro to α' },
      { name: 'after-heading', fileId: 'f1', line: 3, context: 'Intro to α' },
      { name: 'fig:plot', fileId: 'f1', line: 6, context: 'figure: A nice plot' },
      { name: 'eq:e', fileId: 'f1', line: 8, context: 'equation' },
      { name: 'after-percent', fileId: 'f1', line: 10, context: 'Intro to α' },
    ])
  })

  it('labels before any heading have no context', () => {
    expect(indexTex('\\label{top}', 'x').labels).toEqual([{ name: 'top', fileId: 'x', line: 1 }])
  })

  it('a heading or caption without readable text leaves the one before it as the context', () => {
    const tex = '\\section{Intro}\\section{\\relax}\\label{a}\\begin{table}\\caption{Data}\\caption{}\\label{b}\\end{table}'
    expect(indexTex(tex, 'x').labels.map(l => l.context)).toEqual(['Intro', 'table: Data'])
  })

  it('skips labels made of macro parameters inside definitions', () => {
    const tex = [
      '\\newcommand{\\fig}[2]{\\begin{figure}\\includegraphics{#1}\\label{fig:#2}\\end{figure}}',
      '\\newenvironment{myfig}[1]{\\begin{figure}\\label{#1}}{\\end{figure}}',
      '\\def\\lab#1{\\label{#1}}',
      '\\label{real}',
    ].join('\n')
    expect(indexTex(tex, 'p').labels.map(l => l.name)).toEqual(['real'])
  })

  it('indexes pathological files (repeated unclosed groups, deep nesting) in linear time', () => {
    const mb = (s: string) => s.repeat(Math.ceil((1024 * 1024) / s.length))
    const n = 100_000
    const inputs = [
      mb('\\label{'),
      mb('\\newcommand\\a['),
      mb('\\begin{x}') + mb('\\end{y}'),
      mb('\\def\\a'),
      mb('\\section['),
      mb('\\caption{'),
      mb('\\NewDocumentCommand\\a{'),
      '\\label{'.repeat(n) + '}'.repeat(n), // every group closes, each holding the rest of the file
      '\\section{'.repeat(n) + '}'.repeat(n),
      '\\section{\\label{a}'.repeat(n) + '}'.repeat(n), // and every label needs its heading's title
      '\\section{\\relax}'.repeat(n) + '\\label{a}'.repeat(n), // empty titles fall back to the one before
      `\\begin{figure}${'\\caption{\\label{a}'.repeat(n)}${'}'.repeat(n)}`,
    ]
    for (const text of inputs) {
      const t0 = performance.now()
      indexTex(text, 'f')
      scanSource(text)
      // Quadratic scans took minutes on these; linear ones take tens of milliseconds.
      expect(performance.now() - t0).toBeLessThan(1500)
    }
  })

  it('matches braces and brackets like the forward scan, brackets per brace level', () => {
    const text = '\\a{x{y}\\}z}[p{]}q][r'
    const g = groups(text)
    expect(g.brace(2)).toEqual({ content: 'x{y}\\}z', end: 11 })
    expect(g.brace(2, 3)).toBeNull() // longer than allowed
    expect(g.bracket(11)).toEqual({ content: 'p{]}q', end: 18 })
    expect(g.bracket(18)).toBeNull() // never closed
    expect(g.brace(0)).toBeNull() // not a brace
    expect(scanSource('\\section[a [b] c]{Title}')).toMatchObject([{ type: 'heading', title: 'Title' }])
  })

  it('finds the project\'s own commands and environments, with their arguments', () => {
    const tex = [
      '\\newcommand{\\vect}[2][n]{#1_{#2}}', // 1
      '\\newcommand\\R{\\mathbb{R}}', // 2
      '\\renewcommand*{\\emph}[1]{\\textit{#1}}', // 3
      '\\providecommand{\\pair}[2]{(#1,#2)}', // 4
      '\\def\\swap#1#2{#2#1}', // 5
      '\\DeclareMathOperator*{\\argmax}{arg\\,max}', // 6
      '\\NewDocumentCommand{\\nd}{O{x} m m}{#1#2#3}', // 7
      '\\NewDocumentCommand\\starred{s m}{}', // 8
      '\\newenvironment{boxed}[1]{\\fbox{#1}}{}', // 9
      '\\NewDocumentEnvironment{note}{o m}{}{}', // 10
      '\\newtheorem{theorem}{Theorem}', // 11
      '% \\newcommand{\\hidden}{x}', // 12
    ].join('\n')
    const defs = indexTex(tex, 'p').definitions.map(d => ({ ...d, fileId: undefined }))
    expect(defs).toEqual([
      { kind: 'command', name: 'vect', argCount: 2, optionalDefault: true, line: 1, fileId: undefined },
      { kind: 'command', name: 'R', argCount: 0, line: 2, fileId: undefined },
      { kind: 'command', name: 'emph', argCount: 1, line: 3, fileId: undefined },
      { kind: 'command', name: 'pair', argCount: 2, line: 4, fileId: undefined },
      { kind: 'command', name: 'swap', argCount: 2, line: 5, fileId: undefined },
      { kind: 'command', name: 'argmax', argCount: 0, line: 6, fileId: undefined },
      { kind: 'command', name: 'nd', argCount: 3, optionalDefault: true, line: 7, fileId: undefined },
      { kind: 'command', name: 'starred', argCount: 1, line: 8, fileId: undefined },
      { kind: 'environment', name: 'boxed', argCount: 1, line: 9, fileId: undefined },
      { kind: 'environment', name: 'note', argCount: 2, optionalDefault: true, line: 10, fileId: undefined },
      { kind: 'environment', name: 'theorem', argCount: 0, line: 11, fileId: undefined },
    ])
  })

  it('reads xparse argument specs', () => {
    expect(xparseArgs('m m')).toEqual({ argCount: 2, optionalDefault: false })
    expect(xparseArgs('o m')).toEqual({ argCount: 2, optionalDefault: true })
    expect(xparseArgs('s O{default} D(){0} m')).toEqual({ argCount: 2, optionalDefault: true })
    expect(xparseArgs('r() m')).toEqual({ argCount: 1, optionalDefault: false })
    expect(xparseArgs('')).toEqual({ argCount: 0, optionalDefault: false })
  })
})

describe('project index: .bib', () => {
  it('reads keys, authors, years and titles: braces, quotes, @string, @comment, broken entries', () => {
    const bib = [
      '@string{tug = "TUGboat"}',
      '@comment{ @article{commented, title={No}} }',
      '@preamble{ "\\newcommand{\\noop}[1]{}" }',
      '@Book{knuth84,',
      '  author = {Donald E. Knuth},',
      '  title = {The {\\TeX}book},',
      '  year = 1984,',
      '}',
      '@article(lamport, author = "Leslie Lamport and Others", title = "A {"}quoted{"} title",',
      '  journal = tug, date = {1994-05-01})',
      '@misc{broken, title = {Never closed',
      '@inproceedings{after, author={G{\\"o}del, Kurt}, title={Next}, year={1931}}',
      'free text is a comment in BibTeX',
      '@online{nokey}',
    ].join('\n')
    expect(indexBib(bib, 'b')).toEqual([
      { key: 'knuth84', fileId: 'b', type: 'book', title: 'The TeXbook', author: 'Donald E. Knuth', year: '1984' },
      { key: 'lamport', fileId: 'b', type: 'article', title: 'A "quoted" title', author: 'Leslie Lamport and Others', year: '1994' },
      { key: 'broken', fileId: 'b', type: 'misc', title: 'Never closed' },
      { key: 'after', fileId: 'b', type: 'inproceedings', title: 'Next', author: 'Godel, Kurt', year: '1931' },
      { key: 'nokey', fileId: 'b', type: 'online' },
    ])
  })

  it('resolves @string names in fields', () => {
    const [e] = indexBib('@string{me = {Ada Lovelace}}\n@misc{a, author = me # " and Babbage"}', 'b')
    expect(e?.author).toBe('Ada Lovelace and Babbage')
  })
})

describe('ProjectIndex', () => {
  it('indexes by extension, skips unchanged texts, forgets deleted files and dedupes definitions', () => {
    const ix = new ProjectIndex()
    ix.setFiles([{ id: 'm', path: 'main.tex', kind: 'text' }, { id: 'r', path: 'refs.bib', kind: 'text' }, { id: 'd', path: 'img', kind: 'folder' }])
    expect(ix.update('m', 'main.tex', '\\newcommand{\\x}{1}\\label{a}')).toBe(true)
    expect(ix.update('m', 'main.tex', '\\newcommand{\\x}{1}\\label{a}')).toBe(false)
    ix.update('s', 'macros.sty', '\\newcommand{\\x}[1]{2}\\newcommand{\\y}{3}')
    ix.update('r', 'refs.bib', '@book{k, title={T}}')
    expect(ix.labels().map(l => l.name)).toEqual(['a'])
    expect(ix.bibEntries().map(e => e.key)).toEqual(['k'])
    expect(ix.definitions().map(d => `${d.name}/${d.argCount}`)).toEqual(['x/0', 'y/0'])
    expect(ix.pathOf('r')).toBe('refs.bib')
    expect(ix.filePaths()).toEqual(['main.tex', 'refs.bib'])
    const v = ix.version
    ix.retain(['m'])
    expect(ix.version).toBeGreaterThan(v)
    expect(ix.bibEntries()).toEqual([])
    expect(ix.definitions().map(d => d.name)).toEqual(['x'])
  })

  it('re-parses a file renamed between .tex and .bib although its text is the same', () => {
    const ix = new ProjectIndex()
    const bib = '@book{knuth84, title={The TeXbook}}'
    ix.update('r', 'refs.tex', bib)
    expect(ix.bibEntries()).toEqual([])
    expect(ix.update('r', 'refs.bib', bib)).toBe(true)
    expect(ix.bibEntries().map(e => e.key)).toEqual(['knuth84'])
    expect(ix.update('r', 'refs.bib', bib)).toBe(false)
    expect(ix.update('r', 'refs.sty', bib)).toBe(true)
    expect(ix.bibEntries()).toEqual([])
    expect(ix.update('r', 'refs.txt', bib)).toBe(true) // no longer a source file: forgotten
    expect(ix.update('r', 'refs.txt', bib)).toBe(false)
  })
})

describe('completion context', () => {
  const ctx = (line: string) => detectContext(line, SETS)

  it('after a backslash: a command (not after an escaped one)', () => {
    expect(ctx('Some \\fr')).toEqual({ kind: 'command', from: 5, prefix: 'fr' })
    expect(ctx('\\')).toEqual({ kind: 'command', from: 0, prefix: '' })
    expect(ctx('a line break \\\\fr')).toBeNull()
  })

  it('in \\begin{ and \\end{', () => {
    expect(ctx('  \\begin{it')).toMatchObject({ kind: 'begin', cmdFrom: 2, from: 9, prefix: 'it' })
    expect(ctx('\\end{')).toMatchObject({ kind: 'end', from: 5, prefix: '' })
    expect(ctx('\\begin{itemize} \\item {x')).toBeNull()
  })

  it('in \\ref-family and \\cite-family braces, after commas and after optional arguments', () => {
    expect(ctx('see \\ref{fig:')).toMatchObject({ kind: 'ref', command: 'ref', from: 9, prefix: 'fig:', done: [] })
    expect(ctx('\\cref{a,b')).toMatchObject({ kind: 'ref', from: 8, prefix: 'b', done: ['a'] })
    expect(ctx('\\cref{a, ')).toMatchObject({ kind: 'ref', from: 9, prefix: '', done: ['a'] })
    expect(ctx('\\cite[p.~5]{kn')).toMatchObject({ kind: 'cite', from: 12, prefix: 'kn' })
    expect(ctx('\\parencite[see][12]{a, kn')).toMatchObject({ kind: 'cite', prefix: 'kn', done: ['a'] })
    expect(ctx('\\citet*{x')).toMatchObject({ kind: 'cite', prefix: 'x' })
    expect(ctx('\\ref{done} and')).toBeNull()
    expect(ctx('\\textbf{bold')).toBeNull()
  })

  it('in \\input, \\includegraphics, \\usepackage and \\documentclass', () => {
    expect(ctx('\\input{chap')).toMatchObject({ kind: 'input', prefix: 'chap' })
    expect(ctx('\\includegraphics[width=0.5\\linewidth]{img/')).toMatchObject({ kind: 'graphics', prefix: 'img/' })
    expect(ctx('\\usepackage{amsmath,gra')).toMatchObject({ kind: 'package', prefix: 'gra', done: ['amsmath'] })
    expect(ctx('\\usepackage[utf8]{inp')).toMatchObject({ kind: 'package', prefix: 'inp' })
    expect(ctx('\\documentclass[11pt]{art')).toMatchObject({ kind: 'class', prefix: 'art' })
  })

  it('never inside comments', () => {
    expect(ctx('% \\ref{')).toBeNull()
    expect(ctx('text % \\fr')).toBeNull()
    expect(ctx('50\\% of \\ref{a')).toMatchObject({ kind: 'ref', prefix: 'a' })
    expect(commentStart('a \\\\% b')).toBe(4)
    expect(commentStart('a \\% b')).toBe(-1)
  })
})

describe('math mode', () => {
  const math = (s: string) => inMath(s, DISPLAY)

  it('follows $, $$, \\( \\), \\[ \\] and display environments', () => {
    expect(math('$x + \\al')).toBe(true)
    expect(math('$x$ and \\al')).toBe(false)
    expect(math('$$ x')).toBe(true)
    expect(math('$$ x $$ y')).toBe(false)
    expect(math('\\( a')).toBe(true)
    expect(math('\\[ a \\] b')).toBe(false)
    expect(math('\\begin{equation} a \\fr')).toBe(true)
    expect(math('\\begin{equation} a \\end{equation} \\fr')).toBe(false)
    expect(math('\\begin{itemize} \\item x')).toBe(false)
  })

  it('treats \\text{…} as text, escaped dollars and comments as nothing, and stops at blank lines', () => {
    expect(math('$a \\text{word \\al')).toBe(false)
    expect(math('$a \\text{w} \\al')).toBe(true)
    expect(math('a \\$ price')).toBe(false)
    expect(math('% $ a\nb')).toBe(false)
    expect(math('$ a\n\nb')).toBe(false)
  })

  it('knows the environments still open (for \\end{)', () => {
    expect(openEnvironments('\\begin{document}\n\\begin{itemize}\n\\item a')).toEqual(['document', 'itemize'])
    expect(openEnvironments('\\begin{document}\\begin{itemize}\\end{itemize}\n% \\begin{x}')).toEqual(['document'])
    expect(closingEnvironments('\\begin{a}\\end{a}\\end{itemize}\n\\end{document}')).toEqual(['itemize', 'document'])
    expect(closingEnvironments('\\end{x}\\end{y}\\end{z}', 2)).toEqual(['x', 'y'])
  })

  it('tells a new \\begin from one that already has its \\end (a rename)', () => {
    const doc = '\\begin{document}\n'
    expect(beginHasEnd(doc, '\n\\end{document}')).toBe(false)
    expect(beginHasEnd('', '\nText')).toBe(false)
    expect(beginHasEnd(doc, '\n\\item a\n\\end{itemize}\n\\end{document}')).toBe(true)
    expect(beginHasEnd('', '\n\\item a\n\\end{itemize}')).toBe(true) // a chapter file: no document environment
    // An environment above that the user has not closed yet: still a new \begin.
    expect(beginHasEnd(`${doc}\\begin{figure}\n`, '\n\\end{document}')).toBe(false)
    // Renaming an itemize nested in an itemize: one \end more than the environments open above.
    expect(beginHasEnd(`${doc}\\begin{itemize}\n`, '\n\\end{itemize}\n\\end{itemize}\n\\end{document}')).toBe(true)
    expect(beginHasEnd(`${doc}\\begin{itemize}\n`, '\n\\end{itemize}\n\\end{document}')).toBe(false)
  })
})

describe('snippets and paths', () => {
  it('commands get placeholders for required arguments only', () => {
    expect(commandTemplate('frac', DATA.commands[0]?.args ?? [])).toBe('\\frac{${1:numerator}}{${2:denominator}}${0}')
    expect(commandTemplate('section', DATA.commands[1]?.args ?? [])).toBe('\\section{${1:title}}${0}')
    expect(commandTemplate('alpha', [])).toBeNull()
    expect(commandTemplate('x', [{ kind: 'required', name: 'a{b}' }])).toBe('\\x{${1:ab}}${0}')
  })

  it('environments get their arguments, a body line and the matching \\end', () => {
    expect(environmentTemplate('itemize', [], '\\item ')).toBe('\\begin{itemize}\n\t\\item ${1}\n\\end{itemize}${0}')
    expect(environmentTemplate('tabular', DATA.environments[1]?.args ?? [])).toBe('\\begin{tabular}{${1:columns}}\n\t${2}\n\\end{tabular}${0}')
  })

  it('user definitions: the leading optional argument is not a placeholder', () => {
    expect(userArgs({ kind: 'command', name: 'v', argCount: 2, optionalDefault: true, fileId: 'f', line: 1 })).toEqual([{ kind: 'required', name: 'arg1' }])
    expect(userArgs({ kind: 'command', name: 'p', argCount: 2, fileId: 'f', line: 1 }).length).toBe(2)
  })

  it('paths are relative to the main file\'s folder', () => {
    expect(relativePath('chapters/intro.tex', '')).toBe('chapters/intro.tex')
    expect(relativePath('thesis/img/a.png', 'thesis')).toBe('img/a.png')
    expect(relativePath('shared/macros.tex', 'thesis')).toBe('../shared/macros.tex')
    const paths = ['thesis/main.tex', 'thesis/ch/one.tex', 'shared/x.tex', 'thesis/img/a.PNG', 'thesis/fig.pdf', 'notes.txt']
    expect(pathSuggestions(paths, 'thesis', 'input', 'thesis/main.tex')).toEqual(['../shared/x', 'ch/one'])
    expect(pathSuggestions(paths, 'thesis', 'graphics')).toEqual(['fig.pdf', 'img/a.PNG'])
  })

  it('shortens author lists', () => {
    expect(shortAuthor('Knuth, Donald E.')).toBe('Knuth')
    expect(shortAuthor('Donald Knuth and Leslie Lamport')).toBe('Knuth and Lamport')
    expect(shortAuthor('A One and B Two and C Three')).toBe('One et al.')
  })
})

describe('completion source', () => {
  const ix = new ProjectIndex()
  ix.setFiles([{ id: 'm', path: 'main.tex', kind: 'text' }, { id: 'b', path: 'refs.bib', kind: 'text' }, { id: 'c', path: 'ch/one.tex', kind: 'text' }])
  ix.update('m', 'main.tex', '\\newcommand{\\R}{\\mathbb{R}}\n\\section{Intro}\\label{sec:intro}')
  ix.update('b', 'refs.bib', '@book{knuth84, author={Donald Knuth}, year=1984, title={The TeXbook}}')
  const source = latexCompletion({ index: () => ix, mainDir: () => '', mainPath: () => 'main.tex', data: DATA })
  const run = (doc: string, explicit = false) =>
    source(new CompletionContext(EditorState.create({ doc }), doc.length, explicit)) as CompletionResult | null
  const labels = (r: CompletionResult | null) => r?.options.map(o => o.label)
  const option = (r: CompletionResult | null, label: string): Completion | undefined => r?.options.find(o => o.label === label)

  it('suggests built-in and project commands after a backslash and a letter', () => {
    const r = run('text \\f')
    expect(r?.from).toBe(5)
    expect(labels(r)).toEqual(expect.arrayContaining(['\\frac', '\\section', '\\R']))
    expect(option(r, '\\R')?.detail).toBe('defined in main.tex:1')
    expect(run('text \\')).toBeNull() // opens by itself only after one letter
    expect(run('text \\', true)?.from).toBe(5)
    expect(run('% \\f')).toBeNull()
  })

  it('ranks math commands first inside math', () => {
    const inside = run('$\\a')
    const outside = run('\\a')
    expect(option(inside, '\\alpha')?.boost ?? 0).toBeGreaterThan(option(inside, '\\author')?.boost ?? 0)
    expect(option(outside, '\\alpha')?.boost ?? 0).toBeLessThan(option(outside, '\\author')?.boost ?? 0)
  })

  it('in text, \\sec offers \\section before the math-only \\sec (exact match scores 0, a longer prefix -100)', () => {
    const score = (r: CompletionResult | null, label: string, exact: boolean) => (exact ? 0 : -100) + (option(r, label)?.boost ?? 0)
    const text = run('Results \\sec')
    expect(score(text, '\\section', false)).toBeGreaterThan(score(text, '\\sec', true))
    const math = run('$x = \\sec')
    expect(score(math, '\\sec', true)).toBeGreaterThan(score(math, '\\section', false))
  })

  it('suggests labels with context and file:line, and bibliography keys with author and year', () => {
    expect(option(run('\\ref{'), 'sec:intro')?.detail).toBe('Intro · main.tex:2')
    expect(option(run('\\cite{'), 'knuth84')?.detail).toBe('Knuth 1984 · The TeXbook')
    expect(labels(run('\\cite{knuth84,'))).toEqual([])
  })

  it('puts the innermost open environment first after \\end{', () => {
    const r = run('\\begin{tabular}{l}\n\\begin{itemize}\n\\item x\n\\end{')
    const first = [...(r?.options ?? [])].sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0))[0]
    expect(first?.label).toBe('itemize')
  })

  it('suggests files, packages and classes', () => {
    expect(labels(run('\\input{'))).toEqual(['ch/one'])
    expect(labels(run('\\usepackage{amsmath,'))).toEqual(['graphicx', 'geometry'])
    expect(labels(run('\\documentclass{'))).toEqual(['article', 'book'])
  })

  /** Run the source on `view` at its cursor, as CodeMirror would. */
  const query = (view: ReturnType<typeof fakeView>, explicit = false) => {
    const r = source(new CompletionContext(view.state, view.state.selection.main.head, explicit)) as CompletionResult | null
    if (!r) throw new Error('no completions')
    return { r, from: r.from, to: r.to ?? view.state.selection.main.head }
  }

  it('\\begin{ inserts the whole environment for a new \\begin', () => {
    const view = fakeView('\\begin{document}\n\\begin{it\n\\end{document}', 26)
    const { r, from, to } = query(view)
    accept(view, option(r, 'itemize'), from, to)
    expect(unindent(view.state.doc.toString())).toBe('\\begin{document}\n\\begin{itemize}\n\\item \n\\end{itemize}\n\\end{document}')
  })

  it('\\begin{ replaces the right text after a co-author edits above while the popup is open', () => {
    for (const [change, expected] of [
      [{ from: 0, insert: 'Co-author: ' }, 'Co-author: Intro\n\\begin{itemize}\n\\item \n\\end{itemize}'],
      [{ from: 0, to: 3 }, 'ro\n\\begin{itemize}\n\\item \n\\end{itemize}'],
    ] as const) {
      const view = fakeView('Intro\n\\begin{it')
      const { r, from, to } = query(view)
      // A remote change (no selection, not touching the range): CodeMirror keeps the popup and maps its range;
      // the options are not asked for again.
      const tr = view.state.update({ changes: change })
      view.state = tr.state
      accept(view, option(r, 'itemize'), tr.changes.mapPos(from), tr.changes.mapPos(to, 1))
      expect(unindent(view.state.doc.toString())).toBe(expected)
    }
  })

  it('\\begin{ on an existing environment changes only the name (a rename leaves no orphaned \\end)', () => {
    // The user selected "itemize" in \begin{itemize} and typed "tab".
    let view = fakeView('\\begin{tab}\n\\item a\n\\end{itemize}', 10)
    let q = query(view)
    accept(view, option(q.r, 'tabular'), q.from, q.to)
    expect(view.state.doc.toString()).toBe('\\begin{tabular}\n\\item a\n\\end{itemize}')
    // Ctrl+Space inside a misspelt name.
    view = fakeView('\\begin{tabel}\n\\end{tabel}', 9)
    q = query(view, true)
    accept(view, option(q.r, 'tabular'), q.from, q.to)
    expect(view.state.doc.toString()).toBe('\\begin{tabular}\n\\end{tabel}')
  })

  it('a command accepted after Ctrl+Space in plain text keeps the rest of the word', () => {
    let view = fakeView('hello world', 3)
    let q = query(view, true)
    accept(view, option(q.r, '\\alpha'), q.from, q.to)
    expect(view.state.doc.toString()).toBe('hel\\alphalo world')
    // After a backslash the rest of the name is replaced, as before.
    view = fakeView('\\setion', 3)
    q = query(view)
    accept(view, option(q.r, '\\section'), q.from, q.to)
    expect(view.state.doc.toString()).toBe('\\section{title}')
  })

  it('Ctrl+Space in plain text is a one-off: typing closes the popup instead of asking again', () => {
    const r = run('Hello ', true)
    if (!r?.update || !(r.validFor instanceof RegExp)) throw new Error('expected an updatable result')
    // Typing a letter is not valid for the result, so CodeMirror calls update(); no options closes the popup
    // (without update() it would re-run the source as an explicit request and keep the list open).
    expect(r.validFor.test('w')).toBe(false)
    const doc = 'Hello w'
    expect(r.update(r, 6, 7, new CompletionContext(EditorState.create({ doc }), 7, false))?.options).toEqual([])
    // A backslash keeps it open: the list filters as a command.
    expect(r.validFor.test('\\')).toBe(true)
    expect(run('text \\', true)?.update).toBeUndefined()
  })
})

describe('ProjectTexts', () => {
  it('loads source files 8 at a time, reports changes and removals, prefers the live text', async () => {
    let active = 0
    let peak = 0
    const server = new Map(Array.from({ length: 20 }, (_, i) => [`f${i}`, `text ${i}`]))
    const loaded: { changed: string[]; removed: string[] }[] = []
    let live: { fileId: string; text: () => string } | null = null
    const texts = new ProjectTexts({
      fetch: async fid => {
        active++
        peak = Math.max(peak, active)
        await new Promise(r => setTimeout(r, 1))
        active--
        const t = server.get(fid)
        if (t === undefined) throw new Error('gone')
        return t
      },
      onLoaded: (changed, removed) => loaded.push({ changed, removed }),
      live: () => live,
    })
    const files = [...server.keys()].map(id => ({ id, name: `${id}.tex` }))
    await texts.load([...files, { id: 'img', name: 'a.png' }])
    expect(peak).toBe(8)
    expect(loaded[0]?.changed.length).toBe(20)
    expect(texts.text('img')).toBeNull()

    server.set('f1', 'changed')
    server.delete('f2')
    await texts.load(files)
    expect(loaded[1]).toEqual({ changed: ['f1'], removed: ['f2'] })

    live = { fileId: 'f3', text: () => 'live' }
    expect(texts.text('f3')).toBe('live')
    texts.remember('f4', 'kept')
    expect(texts.text('f4')).toBe('kept')
  })

  it('a file closed while a load runs keeps its newer text over one fetched before it closed', async () => {
    const server = new Map(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'old']))
    const gates = new Map<string, () => void>()
    const texts = new ProjectTexts({
      fetch: fid => new Promise(resolve => gates.set(fid, () => resolve(server.get(fid) ?? ''))),
      onLoaded: () => {},
    })
    const load = texts.load([...server.keys()].map(id => ({ id, name: `${id}.tex` })))
    // The first 8 are being fetched ("old"); f8 waits for the next batch.
    expect([...gates.keys()]).toHaveLength(8)
    // The user edits f0 and f8 and closes them; the server has their texts from now on.
    texts.remember('f0', 'closed')
    texts.remember('f8', 'closed')
    server.set('f8', 'closed, then edited by a co-author')
    for (const open of gates.values()) open()
    await new Promise(r => setTimeout(r, 0))
    gates.get('f8')?.()
    await load
    expect(texts.text('f0')).toBe('closed') // its fetch started before it closed: the editor's text wins
    expect(texts.text('f8')).toBe('closed, then edited by a co-author') // fetched after it closed: the server wins
    expect(texts.text('f1')).toBe('old')
  })

  it('a load requested during a load runs once more afterwards', async () => {
    let calls = 0
    const texts = new ProjectTexts({ fetch: async () => { calls++; return 'x' }, onLoaded: () => {} })
    const first = texts.load([{ id: 'a', name: 'a.tex' }])
    void texts.load([{ id: 'a', name: 'a.tex' }, { id: 'b', name: 'b.bib' }])
    void texts.load([{ id: 'a', name: 'a.tex' }, { id: 'b', name: 'b.bib' }])
    await first
    expect(calls).toBe(3)
    expect(texts.ids().sort()).toEqual(['a', 'b'])
  })
})
