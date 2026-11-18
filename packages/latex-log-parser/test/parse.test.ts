/** Synthetic logs for the cases the real-TeX fixtures cannot easily produce. */
import { describe, expect, it } from 'vitest'
import { MAX_DIAGNOSTICS, parseLatexLog, type ParsedDiagnostic } from '../src/index.ts'
import type { Diagnostic } from '../../shared/src/api.ts'

const SYS = '/usr/local/texlive/2026/texmf-dist/tex/latex'

function brief(log: string, rootDir?: string): Omit<ParsedDiagnostic, 'raw'>[] {
  return parseLatexLog(log, rootDir === undefined ? {} : { rootDir }).map(({ raw: _raw, ...d }) => d)
}

const UNDEFINED_HELP = [
  'The control sequence at the end of the top line',
  'of your error message was never \\def\'ed. If you have',
  'misspelled it (e.g., `\\hobx\'), type `I\' and the correct',
  'spelling (e.g., `I\\hbox\'). Otherwise just continue,',
  'and I\'ll forget about whatever was undefined.',
  '',
]

describe('contract', () => {
  it('a parsed diagnostic plus a file id is a shared Diagnostic, and vice versa', () => {
    const p: Omit<ParsedDiagnostic, 'raw'> = { severity: 'warning', kind: 'latex', message: 'm', path: 'a.tex', line: 1, endLine: 2 }
    const d: Diagnostic = { ...p, fileId: 'f' }
    const back: Omit<ParsedDiagnostic, 'raw'> = d
    expect(back.path).toBe('a.tex')
  })

  it('empty or non-string input gives no diagnostics', () => {
    expect(parseLatexLog('')).toEqual([])
    expect(parseLatexLog(undefined as unknown as string)).toEqual([])
    expect(parseLatexLog(42 as unknown as string)).toEqual([])
  })
})

describe('file attribution', () => {
  it('"! " errors without file:line use the file stack and the l.<n> line', () => {
    const log = ['(./main.tex (./chapters/a.tex', '! Undefined control sequence.', 'l.12 \\foo', '         ', ...UNDEFINED_HELP, ')', ')'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'tex', message: 'Undefined control sequence \\foo', path: 'chapters/a.tex', line: 12 },
    ])
  })

  it('a warning raised inside a TeX Live file goes to the nearest project file, without the foreign line', () => {
    const log = ['(./main.tex', `(${SYS}/foo/foo.sty`, '', 'Package foo Warning: Something odd on input line 42.', '', ')',
      '', 'LaTeX Warning: Back in main on input line 7.', '', ')'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'warning', kind: 'package:foo', message: 'Something odd.', path: 'main.tex' },
      { severity: 'warning', kind: 'latex', message: 'Back in main.', path: 'main.tex', line: 7 },
    ])
  })

  it('a file:line error in a TeX Live file goes to the nearest project file', () => {
    const log = ['(./chapters/x.tex', `(${SYS}/foo/foo.sty`, `${SYS}/foo/foo.sty:88: Package foo Error: Bad.`, '', 'l.88 \\bad', '    ', 'Help.', '', '))'].join('\n')
    expect(brief(log)).toEqual([{ severity: 'error', kind: 'package:foo', message: 'Bad.', path: 'chapters/x.tex' }])
  })

  it('absolute paths inside rootDir are project files; Windows paths and drive letters', () => {
    const log = ['(C:\\b\\src\\main.tex (C:\\b\\src\\chapters\\x.tex', '', 'LaTeX Warning: In x on input line 2.', '', ')',
      'c:/b/src/main.tex:3: Undefined control sequence.', 'l.3 \\nope', '      ', ...UNDEFINED_HELP, ')'].join('\r\n')
    expect(brief(log, 'C:\\b\\src')).toEqual([
      { severity: 'error', kind: 'tex', message: 'Undefined control sequence \\nope', path: 'main.tex', line: 3 },
      { severity: 'warning', kind: 'latex', message: 'In x.', path: 'chapters/x.tex', line: 2 },
    ])
  })

  it('without rootDir absolute paths are not project files', () => {
    const log = ['(/b/src/main.tex', '', 'LaTeX Warning: Somewhere on input line 2.', '', ')'].join('\n')
    expect(brief(log)).toEqual([{ severity: 'warning', kind: 'latex', message: 'Somewhere.' }])
    expect(brief(log, '/b/src')).toEqual([{ severity: 'warning', kind: 'latex', message: 'Somewhere.', path: 'main.tex', line: 2 }])
  })

  it('CRLF and LF logs give the same result', () => {
    const lines = ['(./main.tex', '', 'LaTeX Warning: Reference `x\' on page 1 undefined on input line 4.', '', ')']
    expect(brief(lines.join('\r\n'))).toEqual(brief(lines.join('\n')))
    expect(brief(lines.join('\r\n'))).toHaveLength(1)
  })

  it('a truncated log (no opening parentheses) still attributes later files', () => {
    const log = ['[ligature: log truncated, showing the last 100 of 5000000 bytes]', ')) ) (./b.tex', '',
      'LaTeX Warning: Late on input line 3.', '', ')'].join('\n')
    expect(brief(log)).toEqual([{ severity: 'warning', kind: 'latex', message: 'Late.', path: 'b.tex', line: 3 }])
  })

  it('when the stack holds no project file, the main file (first project file seen) is used', () => {
    const log = ['(./main.tex', ')', '! Emergency stop.', '<*> main.tex', '            ', '*** (job aborted, no legal \\end found)', ''].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'tex', message: 'Emergency stop (job aborted, no legal \\end found)', path: 'main.tex' },
    ])
  })

  it('file names with parentheses (unquoted by pdfTeX) keep the stack balanced', () => {
    const log = ['(./main.tex (./chapters/intro (old).tex', '', 'LaTeX Warning: Old on input line 2.', '', ')',
      '', 'LaTeX Warning: Main on input line 9.', '', ')'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'warning', kind: 'latex', message: 'Old.', path: 'chapters/intro (old).tex', line: 2 },
      { severity: 'warning', kind: 'latex', message: 'Main.', path: 'main.tex', line: 9 },
    ])
  })

  it('an error without context does not swallow the following lines', () => {
    const log = ['(./main.tex', '! Something odd.', '(./b.tex', '', 'LaTeX Warning: In b on input line 1.', '', ')', ')'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'tex', message: 'Something odd.', path: 'main.tex' },
      { severity: 'warning', kind: 'latex', message: 'In b.', path: 'b.tex', line: 1 },
    ])
  })

  it('parentheses in error context and help text do not disturb the stack', () => {
    const log = ['(./main.tex (./a.tex', './a.tex:2: Undefined control sequence.', 'l.2 (((\\foo', '         ))) )',
      'help (with an open paren', '', ')', '', 'LaTeX Warning: Back in main on input line 9.', '', ')'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'tex', message: 'Undefined control sequence \\foo', path: 'a.tex', line: 2 },
      { severity: 'warning', kind: 'latex', message: 'Back in main.', path: 'main.tex', line: 9 },
    ])
  })
})

describe('messages', () => {
  it('multi-line package and LaTeX errors join their continuation lines', () => {
    const log = ['(./main.tex', './main.tex:5: Package mypkg Error: First part', '(mypkg)                second part.', '',
      'See the mypkg package documentation for explanation.', 'Type  H <return>  for immediate help.', ' ...', '',
      'l.5 \\oops', '         ', 'Try typing  <return>  to proceed.', '', ')'].join('\n')
    expect(brief(log)).toEqual([{ severity: 'error', kind: 'package:mypkg', message: 'First part second part.', path: 'main.tex', line: 5 }])
  })

  it('package, class and LaTeX errors whose text is all on continuation lines keep kind and text', () => {
    const log = ['(./main.tex',
      './main.tex:4: Package fontspec Error: ', '(fontspec)                The font "NoSuchFont" cannot be found; this',
      '(fontspec)                may be a typo.', '', 'For immediate help type H <return>.', ' ...', '', 'l.4 \\begin',
      '          {document}', '',
      '! Class mycls Error:', '(mycls)                Text below.', '', 'l.6 x', '', '',
      './main.tex:8: LaTeX Error: ', '(LaTeX)                Kernel text.', '', 'l.8 y', '', '',
      'Package mypkg Warning: ', '(mypkg)                Warning text on input line 9.', '', ')'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'package:fontspec', message: 'The font "NoSuchFont" cannot be found; this may be a typo.', path: 'main.tex', line: 4 },
      { severity: 'error', kind: 'class:mycls', message: 'Text below.', path: 'main.tex', line: 6 },
      { severity: 'error', kind: 'latex', message: 'Kernel text.', path: 'main.tex', line: 8 },
      { severity: 'warning', kind: 'package:mypkg', message: 'Warning text.', path: 'main.tex', line: 9 },
    ])
  })

  it('"Runaway argument?" and the token text after it do not reach the file stack', () => {
    for (const [tokens, what] of [['{some text (see below ', 'argument'], ['{unbalanced) close ', 'definition'], ['', 'text']] as const) {
      const display = tokens === '' ? [`Runaway ${what}?`] : [`Runaway ${what}?`, tokens]
      const log = ['(./main.tex (./ch/sub.tex', ...display, './ch/sub.tex:3: Paragraph ended before \\short was complete.',
        '<to be read again> ', '                   \\par ', 'l.3 ', '    ', 'I suspect you\'ve forgotten a `}\'.', '', ')',
        '', 'LaTeX Warning: Reference `mainref\' on page 1 undefined on input line 6.', '',
        'LaTeX Warning: There were undefined references.', '', ')'].join('\n')
      expect(brief(log)).toEqual([
        { severity: 'error', kind: 'tex', message: 'Paragraph ended before \\short was complete.', path: 'ch/sub.tex', line: 3 },
        { severity: 'warning', kind: 'undefined-reference', message: 'Reference `mainref\' on page 1 undefined.', path: 'main.tex', line: 6 },
        { severity: 'warning', kind: 'undefined-reference', message: 'There were undefined references.', path: 'main.tex' },
      ])
    }
  })

  it('line 0 (file:0: or l.0) never becomes a line number', () => {
    const log = ['(./main.tex', './main.tex:0: Undefined control sequence.', 'l.0 \\foo', '', '',
      '! Other.', 'l.0 x', '', '', ')'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'tex', message: 'Undefined control sequence \\foo', path: 'main.tex' },
      { severity: 'error', kind: 'tex', message: 'Other.', path: 'main.tex' },
    ])
  })

  it('class errors and I can\'t find file', () => {
    const log = ['(./main.tex', './main.tex:1: Class myclass Error: Nope.', 'l.1 x', '  ', 'Help.', '',
      '! I can\'t find file `missing\'.', 'l.7 \\input missing', '                  ', '(Press Enter to retry, or Control-D to exit)', '', ')'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'class:myclass', message: 'Nope.', path: 'main.tex', line: 1 },
      { severity: 'error', kind: 'missing-file', message: 'I can\'t find file `missing\'.', path: 'main.tex', line: 7 },
    ])
  })

  it('"Fatal error occurred" is reported only when no other error is', () => {
    const fatal = './main.tex:4:  ==> Fatal error occurred, no output PDF file produced!'
    expect(brief(['(./main.tex', fatal].join('\n'))).toEqual([
      { severity: 'error', kind: 'tex', message: 'Fatal error occurred, no output PDF file produced!', path: 'main.tex' },
    ])
    const withError = ['(./main.tex', '! Emergency stop.', '<*> main.tex', '  ', '', fatal].join('\n')
    expect(brief(withError).map(d => d.message)).toEqual(['Emergency stop.'])
  })

  it('engine warnings, missing characters, LuaTeX backend messages', () => {
    const log = ['(./main.tex', 'pdfTeX warning (ext4): destination with the same identifier (name{page.1}) has been already used, duplicate ignored',
      '<to be read again> ', '                   \\relax ', 'l.12 \\newpage', '               ', '',
      'Missing character: There is no ^^A in font cmr10!', 'warning  (pdf backend): unreferenced destination with name \'x\'', '',
      'warning  (pdf backend): no pages of output.', ')'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'tex', message: 'No pages of output.', path: 'main.tex' },
      { severity: 'warning', kind: 'tex', message: 'destination with the same identifier (name{page.1}) has been already used, duplicate ignored', path: 'main.tex', line: 12 },
      { severity: 'warning', kind: 'font', message: 'Missing character: There is no ^^A in font cmr10!', path: 'main.tex' },
      { severity: 'warning', kind: 'tex', message: 'unreferenced destination with name \'x\'', path: 'main.tex' },
    ])
  })

  it('natbib / hyperref style undefined references and citations', () => {
    const log = ['(./main.tex', '', 'Package natbib Warning: Citation `a\' on page 1 undefined on input line 3.', '',
      'LaTeX Warning: Hyper reference `b\' on page 1 undefined on input line 4.', '',
      'Package natbib Warning: There were undefined citations.', '', ')'].join('\n')
    expect(brief(log).map(d => [d.kind, d.line])).toEqual([
      ['undefined-citation', 3], ['undefined-reference', 4], ['undefined-citation', undefined],
    ])
  })

  it('bad boxes inside a TeX Live file keep the attribution but drop the foreign lines', () => {
    const log = ['(./main.tex', `(${SYS}/x/x.sty`, 'Overfull \\hbox (1.0pt too wide) in paragraph at lines 10--12', '[]\\OT1/cmr/m/n/10 (text', ' []', '', ')', ')'].join('\n')
    expect(brief(log)).toEqual([{ severity: 'info', kind: 'badbox', message: 'Overfull \\hbox (1.0pt too wide) in paragraph', path: 'main.tex' }])
  })

  it('tight and loose boxes (with \\hbadness lowered) are info too', () => {
    const log = ['(./main.tex', 'Tight \\hbox (badness 0) detected at line 3', '\\OT1/cmr/m/n/10 x', '', ')'].join('\n')
    expect(brief(log)).toEqual([{ severity: 'info', kind: 'badbox', message: 'Tight \\hbox (badness 0)', path: 'main.tex', line: 3 }])
  })

  it('compiler notes become errors, except the truncation notice', () => {
    const log = '[ligature: log truncated, showing the last 10 of 20 bytes]\n[ligature: compile timed out after 60000 ms; process group killed]\n'
    expect(brief(log)).toEqual([{ severity: 'error', kind: 'compiler', message: 'compile timed out after 60000 ms; process group killed' }])
  })
})

describe('BibTeX and Biber', () => {
  it('BibTeX errors: database not found (location in the .aux), commands missing, repeated entry', () => {
    const log = ['This is BibTeX, Version 0.99e (TeX Live 2026)', 'The top-level auxiliary file: output.aux',
      'I couldn\'t open database file refs.bib', '---line 3 of file output.aux', ' : \\bibdata{refs', ' :                }',
      'I\'m skipping whatever remains of this command', 'I found no \\citation commands---while reading file output.aux',
      'Database file #1: refs.bib', 'Repeated entry---line 17 of file refs.bib', ' : @article{knuth', ' :               ,',
      'I\'m skipping whatever remains of this entry', '(There were 3 error messages)'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'bibtex', message: 'I couldn\'t open database file refs.bib' },
      { severity: 'error', kind: 'bibtex', message: 'I found no \\citation commands' },
      { severity: 'error', kind: 'bibtex', message: 'Repeated entry', path: 'refs.bib', line: 17 },
    ])
  })

  it('entry warnings are attributed to the database only when there is exactly one', () => {
    const log = (dbs: string[]) => ['This is BibTeX, Version 0.99e (TeX Live 2026)',
      ...dbs.map((d, k) => `Database file #${k + 1}: ${d}`), 'Warning--empty journal in x'].join('\n')
    expect(brief(log(['a.bib']))).toEqual([{ severity: 'warning', kind: 'bibtex', message: 'empty journal in x', path: 'a.bib' }])
    expect(brief(log(['a.bib', 'b.bib']))).toEqual([{ severity: 'warning', kind: 'bibtex', message: 'empty journal in x' }])
  })

  it('Biber warnings and errors', () => {
    const log = ['This is Biber 2.20', 'INFO - Found 3 citekeys in bib section 0',
      'WARN - I didn\'t find a database entry for \'missing\' (section 0)',
      'WARN - Datamodel: article entry \'x\' (refs.bib): Missing mandatory field \'journaltitle\'',
      '[123] Utils.pm:411> ERROR - BibTeX subsystem: /tmp/biber_tmp_ab/refs.bib_9999.utf8, line 15, syntax error: found "author", expected end of entry'].join('\n')
    expect(brief(log)).toEqual([
      { severity: 'error', kind: 'biber', message: 'BibTeX subsystem: /tmp/biber_tmp_ab/refs.bib_9999.utf8, line 15, syntax error: found "author", expected end of entry', path: 'refs.bib', line: 15 },
      { severity: 'warning', kind: 'biber', message: 'I didn\'t find a database entry for \'missing\' (section 0)' },
      { severity: 'warning', kind: 'biber', message: 'Datamodel: article entry \'x\' (refs.bib): Missing mandatory field \'journaltitle\'', path: 'refs.bib' },
    ])
  })
})

describe('deduplication, ordering, cap', () => {
  it('identical diagnostics are reported once; same message elsewhere is kept', () => {
    const w = (l: number) => ['', `LaTeX Warning: Same on input line ${l}.`, '']
    const log = ['(./main.tex', ...w(1), ...w(1), ...w(2), ')'].join('\n')
    expect(brief(log).map(d => d.line)).toEqual([1, 2])
  })

  it('errors first, then warnings, then bad boxes; each group in log order', () => {
    const log = ['(./main.tex', 'Overfull \\hbox (1pt too wide) detected at line 1', '', '', 'LaTeX Warning: W on input line 2.', '',
      './main.tex:3: E1.', 'l.3 x', ' ', '', './main.tex:4: E2.', 'l.4 x', ' ', '', ')'].join('\n')
    expect(brief(log).map(d => d.message)).toEqual(['E1.', 'E2.', 'W.', 'Overfull \\hbox (1pt too wide)'])
  })

  it(`caps at ${MAX_DIAGNOSTICS}, keeping every error`, () => {
    const lines = ['(./main.tex']
    for (let k = 1; k <= 700; k++) lines.push('', `LaTeX Warning: W${k} on input line ${k}.`, '')
    for (let k = 1; k <= 30; k++) lines.push(`./main.tex:${k}: E${k}.`, `l.${k} x`, ' ', '')
    lines.push(')')
    const out = parseLatexLog(lines.join('\n'))
    expect(out).toHaveLength(MAX_DIAGNOSTICS)
    expect(out.slice(0, 30).every(d => d.severity === 'error')).toBe(true)
    expect(out[30]!.message).toBe('W1.')
  })

  it('raw excerpts are capped', () => {
    const log = ['(./main.tex', `./main.tex:1: ${'x'.repeat(5000)}`, 'l.1 y', ' ', '', ')'].join('\n')
    const [d] = parseLatexLog(log)
    expect(d!.raw!.length).toBeLessThanOrEqual(1000)
  })
})
