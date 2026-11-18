// Regression tests for the M2 web review findings.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ChangeLog, type DeltaOp } from '../src/lib/diagnostics.ts'
import { LineMap, SyncLines } from '../src/lib/syncLines.ts'
import { BehindTracker, trackerAfterBuild } from '../src/lib/behind.ts'
import { dismissMenu, isSaveShortcut, isShowInPdfShortcut } from '../src/lib/shortcuts.ts'
import { closeActions } from '../src/lib/projectEvents.ts'

/** A Y.Text holding `text`, whose deltas are fed to `onDelta`. */
function ydoc(text: string, onDelta: (d: DeltaOp[]) => void) {
  const doc = new Y.Doc()
  const t = doc.getText('t')
  t.insert(0, text)
  t.observe(ev => onDelta(ev.delta as DeltaOp[]))
  return t
}

const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}`).join('\n')
const lineOf = (text: string, needle: string) => text.split('\n').indexOf(needle) + 1

describe('finding 1: SyncTeX line numbers follow edits made since the build', () => {
  it('review repro: 3 Enters at the top, then double-click Paragraph 14 lands on Paragraph 14', () => {
    const build = paragraphs(40)
    const map = LineMap.fromText(build)
    const t = ydoc(build, d => map.applyDelta(d))
    t.insert(0, '\n\n\n')
    const now = t.toString()
    expect(lineOf(now, 'Paragraph 14')).toBe(17)
    // PDF -> editor: SyncTeX says build line 14.
    expect(map.toCurrent(14, now)).toBe(17)
    // Editor -> PDF: cursor on Paragraph 14 (line 17 now) asks SyncTeX for build line 14.
    expect(map.toBuild(17, now)).toBe(14)
    // The three new lines come before build line 1.
    expect(map.toBuild(1, now)).toBe(1)
    expect(map.toBuild(3, now)).toBe(1)
  })

  it('maps through deletions, joins, insertions in the middle and edits within a line', () => {
    const build = paragraphs(10)
    const map = LineMap.fromText(build)
    const t = ydoc(build, d => map.applyDelta(d))
    // Delete line 3 entirely (with its line break).
    const s3 = build.indexOf('Paragraph 3')
    t.delete(s3, 'Paragraph 3\n'.length)
    // Insert two new lines after Paragraph 6.
    const after6 = t.toString().indexOf('Paragraph 6') + 'Paragraph 6'.length
    t.insert(after6, '\nnew A\nnew B')
    // Type inside Paragraph 8.
    t.insert(t.toString().indexOf('Paragraph 8') + 4, 'XX')
    const now = t.toString()
    for (const n of [1, 2, 4, 5, 6, 7, 9, 10]) {
      expect(map.toCurrent(n, now)).toBe(lineOf(now, `Paragraph ${n}`))
      expect(map.toBuild(lineOf(now, `Paragraph ${n}`), now)).toBe(n)
    }
    expect(map.toCurrent(8, now)).toBe(lineOf(now, 'ParaXXgraph 8'))
    // The deleted line lands where it was (on the next line's start).
    expect(map.toCurrent(3, now)).toBe(lineOf(now, 'Paragraph 4'))
    // New lines map to the build line before them.
    expect(map.toBuild(lineOf(now, 'new A'), now)).toBe(6)
    expect(map.toBuild(lineOf(now, 'new B'), now)).toBe(6)
    // Out of range build lines clamp.
    expect(map.toCurrent(99, now)).toBe(lineOf(now, 'Paragraph 10'))
  })

  it('a joined line (line break deleted) maps both build lines to the joined line', () => {
    const build = 'a\nb\nc'
    const map = LineMap.fromText(build)
    const t = ydoc(build, d => map.applyDelta(d))
    t.delete(1, 1) // "ab\nc"
    const now = t.toString()
    expect(map.toCurrent(2, now)).toBe(1)
    expect(map.toCurrent(3, now)).toBe(2)
    expect(map.toBuild(1, now)).toBe(1)
    expect(map.toBuild(2, now)).toBe(3)
  })

  it('anchors to the text the compile started from (edits during the compile are replayed)', () => {
    const t = ydoc(paragraphs(20), () => {})
    const log = new ChangeLog('f', t.toString())
    t.observe(ev => log.record(ev.delta as DeltaOp[]))
    t.insert(0, 'typed during the compile\n')
    const map = LineMap.fromChangeLog(log)
    const now = t.toString()
    expect(map.toCurrent(5, now)).toBe(6)
    expect(map.toBuild(6, now)).toBe(5)
  })

  it('SyncLines keeps a closed file as a line table and re-anchors it when reopened', () => {
    const build = paragraphs(10)
    const sync = new SyncLines()
    const t = ydoc(build, d => sync.applyDelta('f', d))
    sync.reset({ fileId: 'f', map: LineMap.fromText(build) })
    t.insert(0, 'x\ny\n')
    // Close: the table remembers that build line 5 is now line 7.
    sync.closed('f', t.toString())
    expect(sync.toCurrent('f', 5, null)).toBe(7)
    // Reopen, edit more.
    sync.opened('f', t.toString())
    t.insert(0, 'z\n')
    const now = t.toString()
    expect(sync.toCurrent('f', 5, now)).toBe(8)
    expect(sync.toBuild('f', 8, now)).toBe(5)
    // Another file, never opened since the build: unchanged numbers.
    expect(sync.toCurrent('other', 12, null)).toBe(12)
    expect(sync.toBuild('other', 12, 'whatever')).toBe(12)
  })

  it('SyncLines.reset (a new PDF) forgets the old offsets; a file opened later starts from its text then', () => {
    const sync = new SyncLines()
    const t = ydoc(paragraphs(10), d => sync.applyDelta('f', d))
    sync.reset({ fileId: 'f', map: LineMap.fromText(t.toString()) })
    t.insert(0, 'a\nb\n')
    expect(sync.toCurrent('f', 3, t.toString())).toBe(5)
    // The new build was made from the current text.
    sync.reset({ fileId: 'f', map: LineMap.fromText(t.toString()) })
    expect(sync.toCurrent('f', 3, t.toString())).toBe(3)
    // Nothing open at reset: opened() anchors to the text at that moment.
    sync.closed('f', t.toString())
    sync.reset(null)
    sync.opened('f', t.toString())
    t.insert(0, 'c\n')
    expect(sync.toCurrent('f', 3, t.toString())).toBe(4)
  })

  it('stays cheap on a large file (only lines after the change are mapped)', () => {
    const build = paragraphs(20000)
    const map = LineMap.fromText(build)
    const t = ydoc(build, d => map.applyDelta(d))
    const end = build.length
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) t.insert(end - 3, 'x')
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(map.toCurrent(20000, t.toString())).toBe(20000)
  })
})

describe('finding 5: "PDF is behind" belongs to the PDF on screen', () => {
  const snap = { treeVersion: 1, docs: {}, docSnapshots: {} }

  it('a build without a PDF keeps the tracker of the PDF still shown', () => {
    const current = new BehindTracker(snap)
    expect(trackerAfterBuild(current, { hasPdf: false, snapshot: snap })).toBe(current)
    expect(trackerAfterBuild(null, { hasPdf: false, snapshot: snap })).toBeNull()
  })

  it('a build with a PDF replaces it (null without a snapshot)', () => {
    const current = new BehindTracker(snap)
    const next = trackerAfterBuild(current, { hasPdf: true, snapshot: snap })
    expect(next).toBeInstanceOf(BehindTracker)
    expect(next).not.toBe(current)
    expect(trackerAfterBuild(current, { hasPdf: true })).toBeNull()
  })
})

describe('finding 3: Ctrl+S on any keyboard layout', () => {
  const key = (over: Partial<KeyboardEvent>) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over })

  it('matches the physical S key whatever character it types', () => {
    expect(isSaveShortcut(key({ key: 's', code: 'KeyS', ctrlKey: true }))).toBe(true)
    expect(isSaveShortcut(key({ key: 'ы', code: 'KeyS', ctrlKey: true }))).toBe(true) // Russian
    expect(isSaveShortcut(key({ key: 'σ', code: 'KeyS', ctrlKey: true }))).toBe(true) // Greek
    expect(isSaveShortcut(key({ key: 'S', code: 'KeyS', metaKey: true }))).toBe(true) // Cmd, caps lock
    expect(isSaveShortcut(key({ key: 's', code: 'Semicolon', ctrlKey: true }))).toBe(true) // Dvorak
  })

  it('does not match other combinations', () => {
    expect(isSaveShortcut(key({ key: 's', code: 'KeyS' }))).toBe(false)
    expect(isSaveShortcut(key({ key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isSaveShortcut(key({ key: 'ś', code: 'KeyS', ctrlKey: true, altKey: true }))).toBe(false)
    expect(isSaveShortcut(key({ key: 'ы', code: 'KeyD', ctrlKey: true }))).toBe(false)
  })

  it('Ctrl+Alt+J goes by the physical key', () => {
    expect(isShowInPdfShortcut(key({ key: '∆', code: 'KeyJ', ctrlKey: true, altKey: true }))).toBe(true)
    expect(isShowInPdfShortcut(key({ key: 'j', code: 'KeyJ', ctrlKey: true }))).toBe(false)
  })
})

describe('finding 4: the Project menu closes on an outside click and on Escape', () => {
  function setup() {
    const win = new EventTarget()
    let inside = false
    let closed = 0
    const seen: (EventTarget | null)[] = []
    const off = dismissMenu(win, t => { seen.push(t); return inside }, () => { closed++ })
    const key = (k: string) => Object.assign(new Event('keydown'), { key: k })
    return { win, setInside: (v: boolean) => { inside = v }, closed: () => closed, seen, off, key }
  }

  it('closes on a pointer press outside, not inside', () => {
    const s = setup()
    s.setInside(true)
    s.win.dispatchEvent(new Event('pointerdown'))
    expect(s.closed()).toBe(0)
    expect(s.seen[0]).toBe(s.win) // given the event target
    s.setInside(false)
    s.win.dispatchEvent(new Event('pointerdown'))
    expect(s.closed()).toBe(1)
  })

  it('closes on Escape only', () => {
    const s = setup()
    s.win.dispatchEvent(s.key('a'))
    expect(s.closed()).toBe(0)
    s.win.dispatchEvent(s.key('Escape'))
    expect(s.closed()).toBe(1)
  })

  it('stops listening once removed', () => {
    const s = setup()
    s.off()
    s.win.dispatchEvent(new Event('pointerdown'))
    s.win.dispatchEvent(s.key('Escape'))
    expect(s.closed()).toBe(0)
  })
})

describe('finding 2: a zoomed page can be scrolled to its left edge', () => {
  it('the pages box grows to the widest page instead of centring it into negative overflow', () => {
    const src = readFileSync(new URL('../src/lib/PdfView.svelte', import.meta.url), 'utf8')
    const rule = /\n {2}\.pages \{([^}]*)\}/.exec(src)?.[1] ?? ''
    expect(rule).toMatch(/width:\s*max-content/)
    expect(rule).toMatch(/min-width:\s*100%/)
  })
})

describe('finding 6: a collaborator trashing the open file', () => {
  it('the toast says "moved to the trash", like the notice', () => {
    const [a] = closeActions('file-deleted', 'file')
    expect(a).toEqual({ type: 'file-gone', notice: 'The open file was moved to the trash.' })
    expect(JSON.stringify(a)).not.toMatch(/was deleted/)
  })
})
