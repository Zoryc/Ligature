import { describe, expect, it } from 'vitest'
import { explain, usepackageInsertion } from '../src/lib/explain.ts'
import { buildOutline, entryMarks, plainTitle, resolveInput, scanSource } from '../src/lib/outline.ts'
import { initials, PRESENCE_COLORS, userColor } from '../src/lib/colors.ts'

describe('explain', () => {
  it('names the package of a known undefined command and offers to load it', () => {
    const e = explain({ message: 'Undefined control sequence \\SI' }, 'main.tex')
    expect(e?.text).toContain('siunitx')
    expect(e?.text).toContain('main.tex')
    expect(e?.fix).toEqual({ kind: 'usepackage', pkg: 'siunitx', label: 'Add \\usepackage{siunitx}' })
  })

  it('explains unknown commands and environments without a fix', () => {
    expect(explain({ message: 'Undefined control sequence \\frobnicate' })?.fix).toBeUndefined()
    expect(explain({ message: 'Environment align undefined.' })?.fix?.pkg).toBe('amsmath')
    expect(explain({ message: 'Environment wibble undefined.' })?.fix).toBeUndefined()
  })

  it('covers the common messages and stays silent on others', () => {
    for (const message of [
      'Missing $ inserted.', "Reference `sec:x' on page 1 undefined.", "Citation `knuth' on page 1 undefined.",
      'Overfull \\hbox (4.2pt too wide) in paragraph', "File `doesnotexist.sty' not found.", 'Paragraph ended before \\short was complete.',
      "Label `dup' multiply defined.",
    ]) expect(explain({ message })?.text, message).toBeTruthy()
    expect(explain({ message: 'Overfull \\hbox (4.2pt too wide) in paragraph' })?.text).toContain('4.2 pt')
    expect(explain({ message: 'Something nobody has seen' })).toBeNull()
  })
})

describe('usepackageInsertion', () => {
  const doc = '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage[T1]{fontenc}\n\n\\begin{document}\nHi\n\\end{document}\n'

  it('goes after the last \\usepackage of the preamble', () => {
    const r = usepackageInsertion(doc, 'siunitx')!
    const out = doc.slice(0, r.at) + r.insert + doc.slice(r.at)
    expect(out).toContain('\\usepackage[T1]{fontenc}\n\\usepackage{siunitx}\n\n\\begin{document}')
  })

  it('goes after \\documentclass when there is no package yet', () => {
    const d = '\\documentclass[11pt]{article}\n\\begin{document}\n\\end{document}'
    const r = usepackageInsertion(d, 'graphicx')!
    expect(d.slice(0, r.at) + r.insert + d.slice(r.at)).toBe('\\documentclass[11pt]{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\end{document}')
  })

  it('does nothing when the package is loaded (also in a list) or there is no preamble', () => {
    expect(usepackageInsertion('\\usepackage{amsmath, siunitx}\n\\begin{document}', 'siunitx')).toBeNull()
    expect(usepackageInsertion('\\section{Body only}', 'siunitx')).toBeNull()
    // a commented-out package does not count
    expect(usepackageInsertion('\\documentclass{article}\n% \\usepackage{siunitx}\n\\begin{document}', 'siunitx')).not.toBeNull()
  })
})

describe('outline', () => {
  const main = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\begin{abstract} x \\end{abstract}',
    '\\section{Introduction}\\label{sec:intro}',
    '% \\section{Commented out}',
    '\\input{chapters/method}',
    '\\section*{Acknowledgements}',
    '\\appendix',
    '\\section[Short]{Extra \\emph{data}}',
    '\\bibliography{refs}',
    '\\end{document}',
  ].join('\n')
  const method = '\\section{Method}\n\\subsection{Specimens}\ntext\n\\subsection{Hot-spot stress~$\\sigma$}\n\\includegraphics{x}\n'
  const files = new Map([['main.tex', { id: 'm' }], ['chapters/method.tex', { id: 'c' }]])
  const texts: Record<string, string> = { m: main, c: method }
  const outline = buildOutline({ mainFileId: 'm', text: id => texts[id] ?? null, resolve: p => resolveInput(p, '', files) })

  it('follows \\input and numbers like LaTeX (appendix in letters)', () => {
    expect(outline.map(e => [e.number, e.title, e.fileId, e.line, e.depth])).toEqual([
      ['', 'Abstract', 'm', 3, 0],
      ['1', 'Introduction', 'm', 4, 0],
      ['2', 'Method', 'c', 1, 0],
      ['2.1', 'Specimens', 'c', 2, 1],
      ['2.2', 'Hot-spot stress σ', 'c', 4, 1],
      ['', 'Acknowledgements', 'm', 7, 0],
      ['A', 'Extra data', 'm', 9, 0],
      ['', 'References', 'm', 10, 0],
    ])
  })

  it('does not loop on files that include each other', () => {
    const t: Record<string, string> = { a: '\\section{A}\\input{b}', b: '\\section{B}\\input{a}' }
    const o = buildOutline({ mainFileId: 'a', text: id => t[id] ?? null, resolve: p => p })
    expect(o.map(e => e.title)).toEqual(['A', 'B'])
  })

  it('marks the worst problem of each entry', () => {
    const marks = entryMarks(outline, id => (id === 'c' ? [{ line: 3, severity: 'warning' }, { line: 5, severity: 'error' }] : []))
    expect(marks[3]).toBe('warning') // Specimens: lines 2–3
    expect(marks[4]).toBe('error') // Hot-spot stress: line 4 to the end of the file
    expect(marks[1]).toBeNull()
  })

  it('cleans titles and ignores look-alike commands', () => {
    expect(plainTitle('The \\textbf{big} {idea} --- part~1\\\\ two')).toBe('The big idea –- part 1 two')
    expect(scanSource('\\sectionmark{x}\\includegraphics{y}\\inputencoding{z}')).toEqual([])
  })

  it('resolves input paths relative to the main file folder', () => {
    const f = new Map([['paper/main.tex', { id: 'm' }], ['paper/sec/a.tex', { id: 'a' }]])
    expect(resolveInput('sec/a', 'paper', f)).toBe('a')
    expect(resolveInput('./sec/a.tex', 'paper', f)).toBe('a')
    expect(resolveInput('../paper/sec/a', 'paper', f)).toBe('a')
    expect(resolveInput('missing', 'paper', f)).toBeNull()
  })
})

describe('people', () => {
  it('initials and colours', () => {
    expect(initials('Bob Okafor')).toBe('BO')
    expect(initials('carol')).toBe('CA')
    expect(initials('  Ana  María  de la Cruz ')).toBe('AC')
    expect(initials('')).toBe('?')
    expect(PRESENCE_COLORS).toContain(userColor('anyone').color)
  })
})
