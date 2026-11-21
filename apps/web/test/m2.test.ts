import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { Diagnostic, TrashEntry, TreeEntry } from '@ligature/shared'
import {
  agoText, ancestorIds, daysLeft, expiryText, parentLabel, restoredText, restoreTargets, sortTrash, trashButtonLabel, trashRow,
} from '../src/lib/trash.ts'
import {
  ChangeLog, countSeverities, FileDiagnostics, lineAt, lineRange, lineStarts, linesForFile, locationText, mapPos,
  problemsSummary, type DeltaOp,
} from '../src/lib/diagnostics.ts'
import {
  AutoCompiler, autoCompileKey, backoffFor, loadAutoCompile, saveAutoCompile, type CompileOutcome, type CompileTrigger,
} from '../src/lib/autoCompile.ts'
import {
  canvasPointToPdf, cssPointToPdf, pageCssSize, pageScale, pdfPointToCanvas, pdfRectToCss, scrollTargetFor, stepZoom,
} from '../src/lib/pdfCoords.ts'
import { defaultProjectName, rememberImportReport, reportView, takeImportReport } from '../src/lib/zipImport.ts'
import { metaEventActions, parseMetaEvent } from '../src/lib/projectEvents.ts'
import { errorMessage } from '../src/lib/errors.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)

function entry(over: Partial<TrashEntry>): TrashEntry {
  return {
    id: 'x', name: 'a.tex', kind: 'text', originalPath: 'a.tex', deletedAt: NOW - 1000, deletedBy: 'Alice',
    fileCount: 1, size: 100, expiresAt: NOW - 1000 + 30 * DAY, ...over,
  }
}

describe('trash display', () => {
  it('sorts newest first, ties by path', () => {
    const list = [
      entry({ id: '1', deletedAt: NOW - 5000, originalPath: 'b' }),
      entry({ id: '2', deletedAt: NOW - 1000 }),
      entry({ id: '3', deletedAt: NOW - 5000, originalPath: 'a' }),
    ]
    expect(sortTrash(list).map(e => e.id)).toEqual(['2', '3', '1'])
    expect(list.map(e => e.id)).toEqual(['1', '2', '3']) // not mutated
  })

  it('labels the trash button with the count', () => {
    expect(trashButtonLabel(0)).toBe('Trash')
    expect(trashButtonLabel(3)).toBe('Trash (3)')
  })

  it('counts days until the purge, rounding up', () => {
    expect(daysLeft(NOW + 30 * DAY, NOW)).toBe(30)
    expect(daysLeft(NOW + 29.2 * DAY, NOW)).toBe(30)
    expect(daysLeft(NOW - DAY, NOW)).toBe(0)
    expect(expiryText(NOW + 30 * DAY, NOW)).toBe('deleted forever in 30 days')
    expect(expiryText(NOW + 3 * 3600_000, NOW)).toBe('deleted forever within a day')
    expect(expiryText(NOW - 1, NOW)).toBe('deleted forever soon')
  })

  it('says how long ago', () => {
    expect(agoText(NOW - 10_000, NOW)).toBe('just now')
    expect(agoText(NOW - 5 * 60_000, NOW)).toBe('5 min ago')
    expect(agoText(NOW - 3 * 3600_000, NOW)).toBe('3 h ago')
    expect(agoText(NOW - DAY, NOW)).toBe('1 day ago')
    expect(agoText(NOW - 2 * DAY, NOW)).toBe('2 days ago')
    expect(agoText(NOW + 5000, NOW)).toBe('just now') // clock skew
  })

  it('shows the folder an item came from', () => {
    expect(parentLabel('main.tex')).toBe('/')
    expect(parentLabel('chapters/intro.tex')).toBe('chapters/')
    expect(parentLabel('a/b/c')).toBe('a/b/')
    expect(parentLabel('…/figs/x.png')).toBe('…/figs/')
  })

  it('builds a row for files and folders', () => {
    const f = trashRow(entry({ name: 'intro.tex', originalPath: 'chapters/intro.tex', size: 2048, deletedAt: NOW - 120_000 }), NOW)
    expect(f).toMatchObject({ label: 'intro.tex', from: 'chapters/', deleted: 'by Alice, 2 min ago', size: '2.0 KB', expiresSoon: false })
    const d = trashRow(entry({ name: 'figs', kind: 'folder', originalPath: 'figs', fileCount: 3, size: 3 * 1048576, deletedBy: '' }), NOW)
    // '' = the deleter was never recorded (trashed before M2): no "by …". A deleted account comes as "a former member".
    expect(d).toMatchObject({ label: 'figs/', from: '/', deleted: 'just now', size: '3 files, 3.0 MB' })
    expect(trashRow(entry({ deletedBy: 'a former member' }), NOW).deleted).toBe('by a former member, just now')
    expect(trashRow(entry({ expiresAt: NOW + 2 * DAY }), NOW).expiresSoon).toBe(true)
    expect(trashRow(entry({ kind: 'folder', fileCount: 1, size: 0 }), NOW).size).toBe('1 file, 0 B')
  })

  it('lists live folders for "Restore to…", root first', () => {
    const tree: TreeEntry[] = [
      { id: 'r', parentId: null, name: '', kind: 'folder' },
      { id: 'z', parentId: 'r', name: 'zeta', kind: 'folder' },
      { id: 'a', parentId: 'r', name: 'alpha', kind: 'folder' },
      { id: 'a2', parentId: 'a', name: 'sub', kind: 'folder' },
      { id: 't', parentId: 'r', name: 'main.tex', kind: 'text', epoch: 0 },
    ]
    expect(restoreTargets(tree)).toEqual([
      { id: 'r', label: '/' }, { id: 'a', label: 'alpha/' }, { id: 'a2', label: 'alpha/sub/' }, { id: 'z', label: 'zeta/' },
    ])
    expect(ancestorIds(tree, 'a2')).toEqual(['a', 'r'])
    expect(ancestorIds(tree, 'nope')).toEqual([])
  })

  it('mentions a clash rename after a restore', () => {
    expect(restoredText('main.tex', { name: 'main.tex' }, '/')).toBe('Restored "main.tex" to /.')
    expect(restoredText('main.tex', { name: 'main (restored).tex' }, 'chapters/'))
      .toBe('Restored "main.tex" to chapters/ as "main (restored).tex" (the name was taken).')
  })
})

describe('diagnostic positions', () => {
  it('maps a position through inserts and deletes', () => {
    const ins: DeltaOp[] = [{ retain: 5 }, { insert: 'abc' }]
    expect(mapPos(2, ins, 1)).toBe(2)
    expect(mapPos(5, ins, 1)).toBe(8) // after the insertion
    expect(mapPos(5, ins, -1)).toBe(5) // before it
    expect(mapPos(9, ins, 1)).toBe(12)
    const del: DeltaOp[] = [{ retain: 2 }, { delete: 3 }]
    expect(mapPos(1, del, 1)).toBe(1)
    expect(mapPos(3, del, 1)).toBe(2) // inside the deleted range
    expect(mapPos(5, del, 1)).toBe(2)
    expect(mapPos(7, del, 1)).toBe(4)
    expect(mapPos(0, [{ insert: 'xy' }], 1)).toBe(2)
    expect(mapPos(0, [{ insert: { embed: 1 } }], 1)).toBe(1)
    expect(mapPos(4, [{ retain: 1 }, { delete: 1 }, { insert: 'QQQ' }], 1)).toBe(6)
  })

  it('finds lines and line ranges', () => {
    const text = 'one\ntwo\n\nfour'
    const s = lineStarts(text)
    expect(s).toEqual([0, 4, 8, 9])
    expect(lineAt(s, 0)).toBe(1)
    expect(lineAt(s, 3)).toBe(1)
    expect(lineAt(s, 4)).toBe(2)
    expect(lineAt(s, 8)).toBe(3)
    expect(lineAt(s, 13)).toBe(4)
    expect(lineRange(text, s, 2)).toEqual({ from: 4, to: 7 })
    expect(lineRange(text, s, 3)).toEqual({ from: 8, to: 8 })
    expect(lineRange(text, s, 2, 4)).toEqual({ from: 4, to: 13 })
    expect(lineRange(text, s, 99)).toEqual({ from: 9, to: 13 }) // clamped to the last line
    expect(lineRange(text, s, 0)).toEqual({ from: 0, to: 3 })
  })

  const diags: Diagnostic[] = [
    { severity: 'error', kind: 'latex', message: 'Undefined control sequence', fileId: 'f', path: 'a.tex', line: 3 },
    { severity: 'info', kind: 'badbox', message: 'Overfull', fileId: 'f', path: 'a.tex', line: 4, endLine: 5 },
    { severity: 'warning', kind: 'latex', message: 'other file', fileId: 'g', path: 'b.tex', line: 1 },
    { severity: 'warning', kind: 'latex', message: 'no line', fileId: 'f', path: 'a.tex' },
  ]

  it('takes the diagnostics of one file', () => {
    const lines = linesForFile(diags, 'f')
    expect(lines.map(l => [l.line, l.endLine])).toEqual([[3, 3], [4, 5], [1, 1]])
    expect(lines[0]!.diag).toBe(diags[0])
  })

  it('moves diagnostics with edits in a real Y.Text', () => {
    const doc = new Y.Doc()
    const ytext = doc.getText('content')
    ytext.insert(0, 'l1\nl2\nl3 \\foo\nl4\nl5\n')
    const fd = new FileDiagnostics(linesForFile(diags, 'f'), ytext.toString())
    ytext.observe(ev => fd.applyDelta(ev.delta as DeltaOp[]))

    expect(fd.lineOf(diags[0]!, ytext.toString())).toBe(3)
    ytext.insert(0, 'new line\nanother\n') // two lines above
    expect(fd.lineOf(diags[0]!, ytext.toString())).toBe(5)
    expect(fd.toLines(ytext.toString()).map(l => [l.line, l.endLine])).toEqual([[5, 5], [6, 7], [3, 3]]) // line 1 moved down too

    // Delete the first two lines again, and type on the error line itself.
    ytext.delete(0, 'new line\nanother\n'.length)
    const at = ytext.toString().indexOf('\\foo')
    ytext.insert(at + 3, 'bar')
    expect(fd.lineOf(diags[0]!, ytext.toString())).toBe(3)
    const r = fd.ranges(ytext.length).find(x => x.diag === diags[0])!
    expect(ytext.toString().slice(r.from, r.to)).toBe('l3 \\fobaro')
    // Text typed exactly at the end of the range stays outside it (like CodeMirror's marks).
    ytext.insert(r.to, '!')
    const r2 = fd.ranges(ytext.length).find(x => x.diag === diags[0])!
    expect(ytext.toString().slice(r2.from, r2.to)).toBe('l3 \\fobaro')

    // A line break inserted at the very start of the error line pushes it down.
    ytext.insert(ytext.toString().indexOf('l3'), '\n')
    expect(fd.lineOf(diags[0]!, ytext.toString())).toBe(4)
    expect(fd.lineOf({ ...diags[0]! }, ytext.toString())).toBeNull() // identity, not equality
  })

  it('collapses a diagnostic whose line was deleted, and clamps to the text', () => {
    const text = 'a\nb\nc\n'
    const fd = new FileDiagnostics([{ diag: diags[0]!, line: 2, endLine: 2 }], text)
    fd.applyDelta([{ retain: 1 }, { delete: 4 }]) // "a\n" + "c\n" -> "a\n"? no: deletes "\nb\nc"
    const r = fd.ranges(2)[0]!
    expect(r.from).toBe(1)
    expect(r.to).toBe(1)
    expect(fd.ranges(0)[0]).toMatchObject({ from: 0, to: 0 })
    expect(fd.size).toBe(1)
  })

  it('anchors a build to the text it was compiled from, then replays later edits', () => {
    const doc = new Y.Doc()
    const ytext = doc.getText('content')
    ytext.insert(0, 'a\nb\nerror here\nd\n')
    const log = new ChangeLog('f', ytext.toString())
    ytext.observe(ev => log.record(ev.delta as DeltaOp[]))
    // Typed while the build ran: three lines above the error.
    ytext.insert(0, 'x\ny\nz\n')
    const fd = log.anchor([{ diag: diags[0]!, line: 3, endLine: 3 }])
    expect(fd.lineOf(diags[0]!, ytext.toString())).toBe(6)
    const r = fd.ranges(ytext.length)[0]!
    expect(ytext.toString().slice(r.from, r.to)).toBe('error here')
  })

  it('counts and summarises', () => {
    const c = countSeverities(diags)
    expect(c).toEqual({ errors: 1, warnings: 2, infos: 1 })
    expect(problemsSummary(c)).toBe('1 error, 2 warnings, 1 bad box')
    expect(problemsSummary({ errors: 3, warnings: 5, infos: 0 })).toBe('3 errors, 5 warnings')
    expect(problemsSummary({ errors: 0, warnings: 0, infos: 2 })).toBe('2 bad boxes')
    expect(problemsSummary({ errors: 0, warnings: 0, infos: 0 })).toBe('No problems')
  })

  it('formats locations', () => {
    expect(locationText({ path: 'a.tex', line: 3 })).toBe('a.tex:3')
    expect(locationText({ path: 'a.tex', line: 3, endLine: 5 })).toBe('a.tex:3-5')
    expect(locationText({ path: 'a.tex', line: 3, endLine: 3 })).toBe('a.tex:3')
    expect(locationText({ path: 'a.tex' })).toBe('a.tex')
    expect(locationText({ line: 7 })).toBe('line 7')
    expect(locationText({})).toBe('')
  })
})

describe('auto-compile scheduler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** A compile function whose calls resolve when the test says so. */
  function harness(enabled = true) {
    const calls: { trigger: CompileTrigger; resolve: (o: CompileOutcome) => void }[] = []
    const ac = new AutoCompiler({
      enabled,
      now: () => Date.now(),
      compile: trigger => new Promise(resolve => { calls.push({ trigger, resolve }) }),
    })
    const finish = async (o: CompileOutcome = { kind: 'done' }) => {
      calls.at(-1)!.resolve(o)
      await vi.advanceTimersByTimeAsync(0)
    }
    return { ac, calls, finish }
  }

  it('compiles 2.5 s after the last local edit', async () => {
    const { ac, calls } = harness()
    ac.localEdit()
    await vi.advanceTimersByTimeAsync(2000)
    ac.localEdit() // restarts the delay
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.map(c => c.trigger)).toEqual(['auto'])
    expect(ac.isRunning).toBe(true)
  })

  it('does nothing when disabled; enabling with pending edits schedules', async () => {
    const { ac, calls } = harness(false)
    ac.localEdit()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(0)
    ac.setEnabled(true)
    expect(ac.scheduled).toBe(true)
    await vi.advanceTimersByTimeAsync(2500)
    expect(calls).toHaveLength(1)
  })

  it('disabling cancels a pending compile', async () => {
    const { ac, calls } = harness()
    ac.localEdit()
    ac.setEnabled(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(0)
    expect(ac.state.enabled).toBe(false)
  })

  it('never runs two compiles at once; edits during a compile compile once afterwards', async () => {
    const { ac, calls, finish } = harness()
    ac.localEdit()
    await vi.advanceTimersByTimeAsync(2500)
    expect(calls).toHaveLength(1)
    ac.localEdit()
    await vi.advanceTimersByTimeAsync(3000) // timer fires while the first compile runs
    ac.localEdit()
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls).toHaveLength(1)
    await finish()
    expect(calls).toHaveLength(2) // right away: the delay already passed
    await finish()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(2) // nothing left to do
  })

  it('an edit during a compile whose delay has not passed yet waits for its timer', async () => {
    const { ac, calls, finish } = harness()
    ac.localEdit()
    await vi.advanceTimersByTimeAsync(2500)
    await vi.advanceTimersByTimeAsync(1000)
    ac.localEdit()
    await finish()
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2499)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
  })

  it('compileNow runs at once, or right after the running compile', async () => {
    const { ac, calls, finish } = harness(false)
    ac.compileNow()
    expect(calls.map(c => c.trigger)).toEqual(['manual'])
    ac.compileNow()
    ac.compileNow()
    expect(calls).toHaveLength(1)
    await finish()
    expect(calls.map(c => c.trigger)).toEqual(['manual', 'manual'])
    await finish()
    expect(calls).toHaveLength(2)
  })

  it('compileNow cancels the pending automatic compile', async () => {
    const { ac, calls, finish } = harness()
    ac.localEdit()
    ac.compileNow()
    await finish()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.map(c => c.trigger)).toEqual(['manual'])
  })

  it('backs off after 429/503 and retries the edits later', async () => {
    const states: (number | null)[] = []
    const calls: CompileTrigger[] = []
    let answer: CompileOutcome = { kind: 'retry-later', afterMs: 60_000, reason: 'too many compiles' }
    const ac = new AutoCompiler({
      enabled: true,
      compile: async t => { calls.push(t); return answer },
      onState: s => states.push(s.pausedUntil),
    })
    ac.localEdit()
    await vi.advanceTimersByTimeAsync(2500)
    expect(calls).toHaveLength(1)
    expect(ac.state.pauseReason).toBe('too many compiles')
    expect(ac.state.pausedUntil).toBe(Date.now() + 60_000)
    ac.localEdit() // more typing during the pause does not compile early
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toHaveLength(1)
    answer = { kind: 'done' }
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toHaveLength(2)
    expect(ac.state.pausedUntil).toBeNull()
    expect(states.some(s => s !== null)).toBe(true)
  })

  it('a throwing compile does not wedge the scheduler', async () => {
    let n = 0
    const ac = new AutoCompiler({ enabled: true, compile: async () => { n++; throw new Error('boom') } })
    ac.localEdit()
    await vi.advanceTimersByTimeAsync(2500)
    ac.localEdit()
    await vi.advanceTimersByTimeAsync(2500)
    expect(n).toBe(2)
    expect(ac.isRunning).toBe(false)
  })

  it('stops after dispose', async () => {
    const { ac, calls } = harness()
    ac.localEdit()
    ac.dispose()
    ac.compileNow()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(0)
  })

  it('maps error codes to back-off times', () => {
    expect(backoffFor('rate-limited')?.afterMs).toBe(60_000)
    expect(backoffFor('compiler-busy')?.afterMs).toBe(10_000)
    expect(backoffFor('compiler-unavailable')).not.toBeNull()
    expect(backoffFor('forbidden')).toBeNull()
  })

  it('stores the toggle per project, default on for editors, always off for viewers', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
    expect(loadAutoCompile(store, 'p1', true)).toBe(true)
    saveAutoCompile(store, 'p1', false)
    expect(data.get(autoCompileKey('p1'))).toBe('0')
    expect(loadAutoCompile(store, 'p1', true)).toBe(false)
    expect(loadAutoCompile(store, 'p2', true)).toBe(true)
    saveAutoCompile(store, 'p2', true)
    expect(loadAutoCompile(store, 'p2', false)).toBe(false)
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(loadAutoCompile(broken, 'p1', true)).toBe(true)
    expect(() => saveAutoCompile(broken, 'p1', true)).not.toThrow()
    expect(loadAutoCompile(null, 'p1', true)).toBe(true)
  })
})

describe('SyncTeX coordinates', () => {
  const A4 = { width: 595.28, height: 841.89 }

  it('converts between PDF points and CSS / canvas pixels at several zooms', () => {
    for (const cssWidth of [300, 595.28, 1190.56]) {
      const scale = pageScale(cssWidth, A4.width)
      const css = pdfRectToCss({ x: 72, y: 144, width: 200, height: 12 }, scale)
      expect(css.left).toBeCloseTo(72 * cssWidth / A4.width)
      expect(css.top).toBeCloseTo(144 * cssWidth / A4.width)
      expect(css.width).toBeCloseTo(200 * scale)
      // Round trip through a click at the box's corner.
      const back = cssPointToPdf(css.left, css.top, scale)
      expect(back.x).toBeCloseTo(72, 1)
      expect(back.y).toBeCloseTo(144, 1)
      for (const dpr of [1, 1.5, 2]) {
        const px = pdfPointToCanvas(72, 144, scale, dpr)
        expect(px.x).toBeCloseTo(css.left * dpr)
        const pt = canvasPointToPdf(px.x, px.y, scale, dpr)
        expect(pt.x).toBeCloseTo(72, 1)
        expect(pt.y).toBeCloseTo(144, 1)
      }
    }
    expect(pageScale(100, 0)).toBe(1)
  })

  it('at 100 % of a 595 pt page shown 595 px wide, a point is a pixel', () => {
    const s = pageScale(595.28, A4.width)
    expect(s).toBe(1)
    expect(cssPointToPdf(100.123, 200.987, s)).toEqual({ x: 100.12, y: 200.99 })
  })

  it('sizes pages for a zoom and steps through zoom levels', () => {
    expect(pageCssSize(A4, 500, 1)).toEqual({ width: 500, height: 707 })
    expect(pageCssSize(A4, 500, 2)).toEqual({ width: 1000, height: 1414 })
    expect(pageCssSize(A4, 500, 0.5)).toEqual({ width: 250, height: 354 })
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(3, 1)).toBe(3)
    expect(stepZoom(0.5, -1)).toBe(0.5)
    expect(stepZoom(1.3, -1)).toBe(1.25)
  })

  it('scrolls so the boxes are a third of the way down', () => {
    expect(scrollTargetFor([{ y: 400, height: 10 }, { y: 300, height: 10 }], 1000, 2, 900)).toBe(1000 + 600 - 300)
    expect(scrollTargetFor([{ y: 10, height: 10 }], 0, 1, 900)).toBe(0)
    expect(scrollTargetFor([], 1234, 1, 900)).toBe(1234)
  })
})

describe('zip import', () => {
  it('derives the project name from the file name', () => {
    expect(defaultProjectName('My Thesis.zip')).toBe('My Thesis')
    expect(defaultProjectName('C:\\fakepath\\paper.ZIP')).toBe('paper')
    expect(defaultProjectName('.zip')).toBe('Imported project')
    expect(defaultProjectName('a'.repeat(200) + '.zip')).toHaveLength(120)
  })

  it('summarises the import report', () => {
    const v = reportView('Paper', { skipped: [{ path: '__MACOSX/', reason: 'macOS metadata' }, { path: 'main.aux', reason: 'build artifact' }], detectedMainFile: 'main.tex' })
    expect(v.summary).toBe('Imported "Paper". Main file: main.tex. 2 entries were skipped:')
    expect(v.skipped).toEqual(['__MACOSX/ (macOS metadata)', 'main.aux (build artifact)'])
    expect(v.more).toBe(0)
    const none = reportView('P', { skipped: [], detectedMainFile: null })
    expect(none.summary).toMatch(/No main file was found.*Nothing was skipped/)
    const many = reportView('P', { skipped: Array.from({ length: 25 }, (_, i) => ({ path: `f${i}`, reason: 'r' })), detectedMainFile: null }, 20)
    expect(many.skipped).toHaveLength(20)
    expect(many.more).toBe(5)
    expect(reportView('P', { skipped: [{ path: 'x', reason: 'y' }], detectedMainFile: null }).summary).toMatch(/1 entry was skipped/)
  })

  it('hands the report to the project page once', () => {
    rememberImportReport('p', { skipped: [], detectedMainFile: 'main.tex' })
    expect(takeImportReport('p')).toEqual({ skipped: [], detectedMainFile: 'main.tex' })
    expect(takeImportReport('p')).toBeNull()
  })
})

describe('M2 events and errors', () => {
  it('refreshes the trash on trash-changed', () => {
    expect(parseMetaEvent('{"type":"trash-changed"}')).toEqual({ type: 'trash-changed' })
    expect(metaEventActions({ type: 'trash-changed' }, { meId: 'u', treeVersion: 1, membersOpen: false }))
      .toEqual([{ type: 'refresh-trash' }])
  })

  it('has messages for the new error codes', () => {
    const err = (status: number, code: string, message?: string) => Object.assign(new Error(message ?? code), { status, code })
    expect(errorMessage(err(503, 'compiler-busy'))).toMatch(/busy/)
    expect(errorMessage(err(400, 'bad-zip', 'entry "../x": path escapes the archive'))).toBe('Entry "../x": path escapes the archive.')
    expect(errorMessage(err(400, 'bad-zip'))).toMatch(/not a usable zip/)
    expect(errorMessage(err(429, 'rate-limited', 'Too many compiles; try again in a few minutes'))).toMatch(/Too many compiles/)
  })
})
