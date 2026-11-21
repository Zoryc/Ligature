import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  caretAt, findDefinition, jumpModifier, targetAt, type DefinitionSources, type IsDefined, type ModifierKeys, type Target,
} from '../src/lib/latex/definitions.ts'
import { ProjectIndex } from '../src/lib/latex/projectIndex.ts'

/** The target at the `|` in `doc` (the bar is removed). */
function at(doc: string, isDefined?: IsDefined): (Target & { text: string }) | null {
  const pos = doc.indexOf('|')
  const text = doc.slice(0, pos) + doc.slice(pos + 1)
  const t = targetAt(text, pos, isDefined)
  return t && { ...t, text: text.slice(t.from, t.to) }
}

const own: IsDefined = (kind, name) => (kind === 'command' ? ['vect', 'R', 'my@cmd'] : ['theorem', 'proofsketch']).includes(name)

describe('targetAt', () => {
  it('finds a label inside each ref command, each key of a list separately', () => {
    expect(at('see \\ref{fig:a|b} now')).toMatchObject({ kind: 'ref', name: 'fig:ab', text: 'fig:ab' })
    expect(at('\\eqref{|eq}')).toMatchObject({ kind: 'ref', name: 'eq' })
    expect(at('\\cref{a, |b}')).toMatchObject({ kind: 'ref', name: 'b', text: 'b' })
    expect(at('\\cref{a|, b}')).toMatchObject({ kind: 'ref', name: 'a' })
    expect(at('\\Cref*{x}{|}')).toBeNull()
  })

  it('finds a key inside each cite command, also after [...] arguments', () => {
    expect(at('\\cite{knuth84,lam|port}')).toMatchObject({ kind: 'cite', name: 'lamport' })
    expect(at('\\cite{knu|th84,lamport}')).toMatchObject({ kind: 'cite', name: 'knuth84' })
    expect(at('\\citep[p.~5]{|k}')).toMatchObject({ kind: 'cite', name: 'k' })
    expect(at('\\parencite[see][12]{a, |b}')).toMatchObject({ kind: 'cite', name: 'b' })
    expect(at('\\cite[p.~5|]{k}')).toBeNull()
    expect(at('\\cite{a,| ,b}')).toBeNull()
  })

  it('does not take the \\nocite{*} wildcard for a key', () => {
    expect(at('\\nocite{|*}')).toBeNull()
    expect(at('\\nocite{ *| }')).toBeNull()
    expect(at('\\nocite{a,|*}')).toBeNull()
    expect(at('\\nocite{|a,*}')).toMatchObject({ kind: 'cite', name: 'a' })
    expect(at('\\nocite*{|k}')).toMatchObject({ kind: 'cite', name: 'k' }) // a starred command is still followed
  })

  it('finds the path of \\input-like commands and \\includegraphics', () => {
    expect(at('\\input{chapters/in|tro}')).toMatchObject({ kind: 'input', name: 'chapters/intro' })
    expect(at('\\include{ |a }')).toMatchObject({ kind: 'input', name: 'a', text: 'a' })
    expect(at('\\subfile{s|ub.tex}')).toMatchObject({ kind: 'input', name: 'sub.tex' })
    expect(at('\\includegraphics[width=\\linewidth]{figs/pl|ot}')).toMatchObject({ kind: 'graphics', name: 'figs/plot' })
    expect(at('\\includegraphics*{|a.png}')).toMatchObject({ kind: 'graphics', name: 'a.png' })
  })

  it('finds commands and environments, but only the project\'s own when asked', () => {
    expect(at('$\\ve|ct{x}$', own)).toMatchObject({ kind: 'command', name: 'vect', text: '\\vect' })
    expect(at('$|\\R$', own)).toMatchObject({ kind: 'command', name: 'R' })
    expect(at('\\my@c|md', own)).toMatchObject({ kind: 'command', name: 'my@cmd' })
    expect(at('\\sec|tion{A}', own)).toBeNull()
    expect(at('\\sec|tion{A}')).toMatchObject({ kind: 'command', name: 'section' }) // without the filter: syntax only
    expect(at('\\begin{theo|rem}', own)).toMatchObject({ kind: 'environment', name: 'theorem', text: 'theorem' })
    expect(at('\\end{ proofsketch| }', own)).toMatchObject({ kind: 'environment', name: 'proofsketch' })
    expect(at('\\begin{item|ize}', own)).toBeNull()
    expect(at('\\re|f{a}', own)).toBeNull() // the command name of \ref is not a target, its label is
  })

  it('ignores comments, escapes and text', () => {
    expect(at('% \\ref{|a}')).toBeNull()
    expect(at('\\ref{a} % \\ref{|b}')).toBeNull()
    expect(at('50\\% of \\ref{|a}')).toMatchObject({ kind: 'ref', name: 'a' })
    expect(at('\\\\ref{|a}')).toBeNull() // a line break followed by text
    expect(at('plain te|xt')).toBeNull()
    expect(at('\\input{\\dir/|x}')).toBeNull()
  })

  it('reads the line of the position and gives offsets in the whole text', () => {
    const doc = 'first line \\ref{a}\nsecond \\cite{|k}\nthird'
    const t = at(doc)
    expect(t).toMatchObject({ kind: 'cite', name: 'k', text: 'k' })
    expect(t?.from).toBe(doc.replace('|', '').indexOf('{k}') + 1)
    expect(targetAt('\\ref{a}\n', 8)).toBeNull()
    expect(targetAt('x', 5)).toBeNull()
  })

  it('handles an argument still being typed (no closing brace yet)', () => {
    expect(at('\\ref{fig:|')).toMatchObject({ kind: 'ref', name: 'fig:' })
  })
})

// ---------- the click ----------

describe('jumpModifier', () => {
  const keys = (k: Partial<ModifierKeys> & { altGraph?: boolean } = {}): ModifierKeys => ({
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...k,
    getModifierState: key => key === 'AltGraph' && !!k.altGraph,
  })

  it('is Ctrl off macOS and Cmd on macOS', () => {
    expect(jumpModifier(keys({ ctrlKey: true }), false)).toBe(true)
    expect(jumpModifier(keys({ metaKey: true }), false)).toBe(false)
    expect(jumpModifier(keys({ metaKey: true }), true)).toBe(true)
    expect(jumpModifier(keys({ ctrlKey: true }), true)).toBe(false)
    expect(jumpModifier(keys(), false)).toBe(false)
  })

  it('is not held with Shift or Alt, so the hint shows only when a click would jump', () => {
    expect(jumpModifier(keys({ ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(jumpModifier(keys({ ctrlKey: true, altKey: true }), false)).toBe(false)
    expect(jumpModifier(keys({ metaKey: true, altKey: true }), true)).toBe(false)
  })

  it('is not held for AltGr, which Windows reports as Ctrl+Alt', () => {
    expect(jumpModifier(keys({ ctrlKey: true, altKey: true, altGraph: true }), false)).toBe(false)
    expect(jumpModifier(keys({ ctrlKey: true, altGraph: true }), false)).toBe(false)
    // Without getModifierState (a plain object): the keys alone decide.
    expect(jumpModifier({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, false)).toBe(true)
  })
})

describe('caretAt', () => {
  it('moves the caret to the clicked target (one cursor, no edit), also when read-only, so Back returns there', () => {
    const doc = 'line 1\n'.repeat(399) + 'see \\ref{fig:x}\n'
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(20)]),
      extensions: [EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(true)],
    })
    const pos = doc.indexOf('fig:x') + 2
    const t = targetAt(doc, pos)
    expect(t).toMatchObject({ kind: 'ref', name: 'fig:x' })
    const after = state.update(caretAt(t!)).state
    expect(after.selection.ranges).toHaveLength(1)
    expect(after.selection.main.head).toBe(doc.indexOf('fig:x'))
    expect(after.doc.lineAt(after.selection.main.head).number).toBe(400)
    expect(after.doc.toString()).toBe(doc)
  })
})

// ---------- findDefinition ----------

interface FakeFile { id: string; path: string; text?: string | null; binary?: boolean; indexed?: string }

/**
 * Sources over fake files: `text` is the current text (null: not loaded); `indexed` is what the index saw
 * (default: the current text), so a stale index can be simulated.
 */
function sources(files: FakeFile[], mainDir = ''): DefinitionSources {
  const index = new ProjectIndex()
  for (const f of files) {
    const indexed = f.indexed ?? f.text
    if (!f.binary && typeof indexed === 'string') index.update(f.id, f.path.split('/').pop() ?? '', indexed)
  }
  return {
    files: files.map(f => ({ id: f.id, path: f.path, text: !f.binary })),
    text: id => files.find(f => f.id === id && !f.binary)?.text ?? null,
    index,
    mainDir,
  }
}

const target = (kind: Target['kind'], name: string): Target => ({ kind, name, from: 0, to: 0 })

describe('findDefinition', () => {
  it('finds a label in another file, outside comments', () => {
    const src = sources([
      { id: 'm', path: 'main.tex', text: '\\input{ch}\n% \\label{sec:a}\n' },
      { id: 'c', path: 'ch.tex', text: '\\section{A}\n\n\\label{sec:a}\n' },
    ])
    expect(findDefinition(target('ref', 'sec:a'), src)).toEqual({ fileId: 'c', line: 3, count: 1 })
  })

  it('takes the first of duplicate labels in file order (the caller lists the main file first), and counts them', () => {
    const src = sources([
      { id: 'm', path: 'main.tex', text: 'one\ntwo\n\\label{x}\n\\label{x}' },
      { id: 'a', path: 'a.tex', text: '\\label{x}' },
    ])
    expect(findDefinition(target('ref', 'x'), src)).toEqual({ fileId: 'm', line: 3, count: 3 })
    const reversed = { ...src, files: [...src.files].reverse() }
    expect(findDefinition(target('ref', 'x'), reversed)).toEqual({ fileId: 'a', line: 1, count: 3 })
  })

  it('uses the current text over a stale index line', () => {
    const src = sources([{ id: 'm', path: 'main.tex', indexed: '\\label{a}', text: 'new\nlines\nabove\n\\label{a}' }])
    expect(src.index.labels()[0]?.line).toBe(1)
    expect(findDefinition(target('ref', 'a'), src)).toEqual({ fileId: 'm', line: 4, count: 1 })
  })

  it('falls back to the index: for a file not loaded, and when the current texts lost the name', () => {
    const notLoaded = sources([{ id: 'm', path: 'main.tex', indexed: 'x\n\\label{a}', text: null }])
    expect(findDefinition(target('ref', 'a'), notLoaded)).toEqual({ fileId: 'm', line: 2, count: 1 })
    const deleted = sources([{ id: 'm', path: 'main.tex', indexed: 'x\nx\n\\label{a}', text: 'x\nx\n' }])
    expect(findDefinition(target('ref', 'a'), deleted)).toEqual({ fileId: 'm', line: 3, count: 1 })
  })

  it('finds a .bib entry at its @type line, skipping commented-out lines', () => {
    const bib = '% @book{knuth84, title={Old}}\n@string{x = "y"}\n\n@Book{knuth84,\n  title={T}}\n'
    const src = sources([{ id: 'm', path: 'main.tex', text: '\\cite{knuth84}' }, { id: 'b', path: 'refs.bib', text: bib }])
    expect(findDefinition(target('cite', 'knuth84'), src)).toEqual({ fileId: 'b', line: 4, count: 1 })
  })

  it('counts duplicate .bib keys across files', () => {
    const src = sources([
      { id: 'b1', path: 'a.bib', text: '@misc{k, title={1}}' },
      { id: 'b2', path: 'b.bib', text: '\n@misc{k, title={2}}' },
    ])
    expect(findDefinition(target('cite', 'k'), src)).toEqual({ fileId: 'b1', line: 1, count: 2 })
  })

  it('finds commands and environments however they are defined', () => {
    const sty = [
      '\\newcommand{\\vect}[1]{\\mathbf{#1}}', // 1
      '\\DeclareMathOperator{\\Tr}{Tr}', // 2
      '\\def\\half{\\frac12}', // 3
      '\\NewDocumentCommand{\\pair}{m m}{(#1,#2)}', // 4
      '\\newenvironment{proofsketch}{}{}', // 5
      '\\newtheorem{theorem}{Theorem}', // 6
      '\\NewDocumentEnvironment{boxed}{m}{}{}', // 7
      '% \\newcommand{\\gone}{}', // 8
    ].join('\n')
    const src = sources([{ id: 'm', path: 'main.tex', text: 'x' }, { id: 's', path: 'macros.sty', text: sty }])
    const line = (kind: Target['kind'], name: string) => {
      const d = findDefinition(target(kind, name), src)
      return 'line' in d ? d.line : d
    }
    expect(line('command', 'vect')).toBe(1)
    expect(line('command', 'Tr')).toBe(2)
    expect(line('command', 'half')).toBe(3)
    expect(line('command', 'pair')).toBe(4)
    expect(line('environment', 'proofsketch')).toBe(5)
    expect(line('environment', 'theorem')).toBe(6)
    expect(line('environment', 'boxed')).toBe(7)
    expect(line('command', 'gone')).toEqual({ reason: '\\gone is defined by LaTeX or a package, not in this project.' })
    expect(line('environment', 'vect')).toEqual({ reason: 'The vect environment is defined by LaTeX or a package, not in this project.' })
  })

  it('counts a command defined twice', () => {
    const src = sources([{ id: 'm', path: 'main.tex', text: '\\newcommand{\\x}{1}\n\\renewcommand{\\x}{2}' }])
    expect(findDefinition(target('command', 'x'), src)).toEqual({ fileId: 'm', line: 1, count: 2 })
  })

  it('says why a target cannot be found', () => {
    const src = sources([{ id: 'm', path: 'main.tex', text: '\\ref{fig:x}' }, { id: 'b', path: 'refs.bib', text: '@misc{other,}' }])
    expect(findDefinition(target('ref', 'fig:x'), src)).toEqual({ reason: 'No \\label{fig:x} in this project.' })
    expect(findDefinition(target('cite', 'knuth1984'), src)).toEqual({ reason: 'No entry knuth1984 in the project\'s .bib files.' })
    expect(findDefinition(target('input', 'chapters/x'), src)).toEqual({ reason: 'chapters/x.tex is not in this project.' })
    expect(findDefinition(target('input', 'chapters/x.ltx'), src)).toEqual({ reason: 'chapters/x.ltx is not in this project.' })
    expect(findDefinition(target('graphics', 'figs/a'), src)).toEqual({ reason: 'figs/a is not in this project.' })
    expect(findDefinition(target('command', 'section'), src)).toEqual({ reason: '\\section is defined by LaTeX or a package, not in this project.' })
  })

  it('resolves \\input paths relative to the main file\'s folder, with or without .tex', () => {
    const src = sources([
      { id: 'm', path: 'src/main.tex', text: '' },
      { id: 'i', path: 'src/chapters/intro.tex', text: '' },
      { id: 'n', path: 'src/notes', text: '' },
      { id: 'r', path: 'shared/defs.tex', text: '' },
      { id: 'top', path: 'chapters/intro.tex', text: '' },
    ], 'src')
    expect(findDefinition(target('input', 'chapters/intro'), src)).toEqual({ fileId: 'i', line: 1, count: 1 })
    expect(findDefinition(target('input', './chapters/intro.tex'), src)).toEqual({ fileId: 'i', line: 1, count: 1 })
    expect(findDefinition(target('input', 'notes'), src)).toEqual({ fileId: 'n', line: 1, count: 1 })
    expect(findDefinition(target('input', '../shared/defs'), src)).toEqual({ fileId: 'r', line: 1, count: 1 })
  })

  it('resolves \\includegraphics paths, trying the extensions in graphicx\'s order', () => {
    const src = sources([
      { id: 'm', path: 'tex/main.tex', text: '' },
      { id: 'png', path: 'tex/figs/plot.png', binary: true },
      { id: 'pdf', path: 'tex/figs/plot.pdf', binary: true },
      { id: 'jpg', path: 'tex/photo.jpg', binary: true },
      { id: 'up', path: 'images/logo.svg', text: '<svg/>' },
    ], 'tex')
    expect(findDefinition(target('graphics', 'figs/plot'), src)).toEqual({ fileId: 'pdf', preview: true })
    expect(findDefinition(target('graphics', 'figs/plot.png'), src)).toEqual({ fileId: 'png', preview: true })
    expect(findDefinition(target('graphics', 'photo'), src)).toEqual({ fileId: 'jpg', preview: true })
    expect(findDefinition(target('graphics', '../images/logo'), src)).toEqual({ fileId: 'up', preview: true })
  })
})
