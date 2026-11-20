/** A failed build always has an error diagnostic, even when the log parser finds none (pure; no server, no ports). */
import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '@ligature/shared'
import { computeDiagnostics } from '../src/compile/diagnostics.ts'
import { BUILD_FAILED_MESSAGE, buildFailureDiagnostic } from '../src/compile/orchestrator.ts'

const PATHS = { 'main.tex': '11111111-1111-4111-8111-111111111111', 'refs.bib': '22222222-2222-4222-8222-222222222222' }
const CLEAN_TEX_LOG = ['This is pdfTeX, Version 3.141592653-2.6-1.40.29 (TeX Live 2026)', '(./main.tex', 'LaTeX2e <2026-11-01>',
  '(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls)', ')', 'Output written on output.pdf (1 page).', ''].join('\n')
/** As the compiler appends the console to a failed build's log that shows no error (apps/compiler/src/logTail.ts). */
const withConsole = (console: string) =>
  `${CLEAN_TEX_LOG}==== Ligature: the TeX log above shows no error; the end of the latexmk console follows ====\n${console}\n==== Ligature: end of the latexmk console ====\n`

function diagnose(status: 'success' | 'failure' | 'timeout' | 'error', log: string): Diagnostic[] {
  const parsed = computeDiagnostics({ log, paths: PATHS })
  const failed = buildFailureDiagnostic(status, log, parsed)
  return failed ? [failed, ...parsed] : parsed
}

describe('buildFailureDiagnostic', () => {
  it('nothing for a successful build, or a failed one that already has an error', () => {
    expect(buildFailureDiagnostic('success', '', [])).toBeNull()
    const err: Diagnostic = { severity: 'error', kind: 'tex', message: 'x' }
    expect(buildFailureDiagnostic('failure', '', [err])).toBeNull()
    expect(buildFailureDiagnostic('timeout', '', [err])).toBeNull()
  })

  it('a failed build whose log shows only warnings gets the generic error', () => {
    const warn: Diagnostic = { severity: 'warning', kind: 'latex', message: 'w' }
    for (const status of ['failure', 'timeout', 'error'] as const) {
      expect(buildFailureDiagnostic(status, CLEAN_TEX_LOG, [warn])).toEqual({ severity: 'error', kind: 'build', message: BUILD_FAILED_MESSAGE })
    }
  })

  it('names the first "!" or biber ERROR line of the log, shortened', () => {
    expect(buildFailureDiagnostic('failure', 'x\n!  Unable to read an entire line---bufsize=200000\n! later\n', [])?.message)
      .toBe('The build failed: Unable to read an entire line---bufsize=200000')
    expect(buildFailureDiagnostic('failure', '[123] Biber.pm:131> ERROR - BibTeX subsystem: refs.bib, line 3, syntax error\n', [])?.message)
      .toBe('The build failed: BibTeX subsystem: refs.bib, line 3, syntax error')
    const long = buildFailureDiagnostic('failure', `! ${'x'.repeat(1000)}\n`, [])!.message
    expect(long.length).toBeLessThan(330)
    expect(long.endsWith('…')).toBe(true)
  })

  it('end to end with the parser: a biber failure on the console becomes the biber error, with its .bib line', () => {
    // As seen from Biber 2.22 in the compiler image (latexmk repeats the error behind "Biber error: ").
    const tmp = '/builds/p/.tmp/biber_tmp_eiXy/8fe4c9854184545302f21ebf0d47516c_234.utf8'
    const error = `BibTeX subsystem: ${tmp}, line 6, syntax error: at end of input, expected end of entry ("}" or ")") (skipping to next "@")`
    const console = ['Latexmk: applying rule \'biber /builds/p/out/output\'...', 'Running \'biber  "/builds/p/out/output.bcf"\'',
      'INFO - This is Biber 2.22', 'INFO - Found BibTeX data source \'refs.bib\'', `ERROR - ${error}`, 'INFO - ERRORS: 1',
      `Biber error: [124] Utils.pm:480> ERROR - ${error}`, 'Latexmk: Errors, so I did not complete making targets'].join('\n')
    const d = diagnose('failure', withConsole(console))
    expect(d.filter(x => x.severity === 'error')).toEqual([{
      severity: 'error', kind: 'biber', path: 'refs.bib', line: 6, fileId: PATHS['refs.bib'],
      message: 'BibTeX subsystem: refs.bib, line 6, syntax error: at end of input, expected end of entry ("}" or ")") (skipping to next "@")',
    }])
  })

  it('end to end with the parser: a fatal error TeX printed only to the terminal is named', () => {
    // As seen from TeX Live 2026 in the compiler image: stderr continues the line of the files TeX had opened.
    const d = diagnose('failure', withConsole(['Latexmk: Run number 1 of rule \'pdflatex\'', '(./main.tex',
      '(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size10.clo)) (/builds/p/out/output.aux)! Unable to read an entire line---bufsize=200000.',
      'Please increase buf_size in texmf.cnf.', 'Latexmk: Errors, so I did not complete making targets'].join('\n')))
    expect(d.filter(x => x.severity === 'error')).toEqual([
      { severity: 'error', kind: 'build', message: 'The build failed: Unable to read an entire line---bufsize=200000.' },
    ])
  })

  it('end to end with the parser: a console with nothing recognisable gets the generic error', () => {
    const d = diagnose('failure', withConsole('Latexmk: Errors, so I did not complete making targets'))
    expect(d).toEqual([{ severity: 'error', kind: 'build', message: BUILD_FAILED_MESSAGE }])
  })
})
