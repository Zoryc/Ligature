import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VersionDiff, VersionSummary } from '@ligature/shared'
import {
  appendPage, authorsText, changeBadge, changeRows, changeSummary, changeWord, contentChanged, dayKey, dayTitle, filterVersions,
  groupByDay, isLatexLike, isNamed, kindIcon, kindName, labelProblem, reloadLimit, restoreConfirmText, restoreFileConfirmText,
  sameAsCurrent, sideSource, undoConfirmText, undoPaths, versionRef, versionTitle,
} from '../src/lib/history.ts'
import { RESHOW_MIN_MS, RestoreNotices, restoredText, showRestoredToast, UNDO_MS } from '../src/lib/restoreToast.ts'
import { dismiss, runAction, toast, toasts } from '../src/lib/toasts.svelte.ts'
import { metaEventActions, parseMetaEvent } from '../src/lib/projectEvents.ts'
import { versionFileUrl, versionZipUrl } from '../src/lib/api.ts'
import { errorMessage } from '../src/lib/errors.ts'

// Local times, so the tests do not depend on the machine's time zone.
const NOW = new Date(2026, 10, 18, 15, 30).getTime()
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()

function version(over: Partial<VersionSummary>): VersionSummary {
  return {
    id: 'v', kind: 'auto', label: null, createdAt: NOW, createdBy: '', authors: [], fileCount: 3,
    changes: { added: 0, removed: 0, modified: 0 }, ...over,
  }
}

const fmt = (ts: number) => `D${new Date(ts).getDate()}`

describe('history: grouping by day', () => {
  it('uses the local calendar day as key', () => {
    expect(dayKey(at(18, 0, 0))).toBe('2026-11-18')
    expect(dayKey(at(18, 23, 59))).toBe('2026-11-18')
    expect(dayKey(at(19, 0, 0))).toBe('2026-11-19')
    expect(dayKey(new Date(2026, 0, 5, 10).getTime())).toBe('2026-01-05')
  })

  it('titles today, yesterday and older days', () => {
    expect(dayTitle(at(18, 0, 1), NOW, fmt)).toBe('Today')
    expect(dayTitle(at(17, 23, 59), NOW, fmt)).toBe('Yesterday')
    expect(dayTitle(at(17, 0, 0), NOW, fmt)).toBe('Yesterday')
    expect(dayTitle(at(16, 23, 59), NOW, fmt)).toBe('D16')
    // Yesterday across a month boundary.
    expect(dayTitle(new Date(2026, 9, 31, 22).getTime(), new Date(2026, 10, 1, 8).getTime(), fmt)).toBe('Yesterday')
  })

  it('groups consecutive versions (newest first) and keeps their order', () => {
    const list = [
      version({ id: 'a', createdAt: at(18, 15) }),
      version({ id: 'b', createdAt: at(18, 9) }),
      version({ id: 'c', createdAt: at(17, 20) }),
      version({ id: 'd', createdAt: at(12, 11) }),
      version({ id: 'e', createdAt: at(12, 10) }),
    ]
    const groups = groupByDay(list, NOW, fmt)
    expect(groups.map(g => [g.title, g.items.map(v => v.id)])).toEqual([
      ['Today', ['a', 'b']], ['Yesterday', ['c']], ['D12', ['d', 'e']],
    ])
    expect(groups.map(g => g.key)).toEqual(['2026-11-18', '2026-11-17', '2026-11-12'])
    expect(groupByDay([], NOW)).toEqual([])
  })
})

describe('history: display texts', () => {
  it('names kinds and titles versions', () => {
    for (const k of ['auto', 'compile', 'named', 'pre_restore', 'import'] as const) {
      expect(kindIcon(k)).not.toBe('')
      expect(kindName(k)).not.toBe('')
      expect(versionTitle({ kind: k, label: null })).not.toBe('')
    }
    expect(versionTitle({ kind: 'auto', label: 'Submitted' })).toBe('Submitted')
    expect(versionTitle({ kind: 'auto', label: null })).toBe('Automatic version')
  })

  it('refers to a version by label, else by date', () => {
    expect(versionRef({ label: 'Draft 1', createdAt: NOW }, fmt)).toBe('"Draft 1"')
    expect(versionRef({ label: null, createdAt: at(12, 9) }, fmt)).toBe('the version of D12')
  })

  it('lists authors and the creator', () => {
    expect(authorsText({ authors: [], createdBy: '' })).toBe('')
    expect(authorsText({ authors: ['Alice', 'Bob'], createdBy: '' })).toBe('Alice, Bob')
    expect(authorsText({ authors: ['Alice'], createdBy: 'Alice' })).toBe('Alice')
    expect(authorsText({ authors: ['Bob'], createdBy: 'Alice' })).toBe('Bob · by Alice')
    expect(authorsText({ authors: [], createdBy: 'Carol' })).toBe('by Carol')
    expect(authorsText({ authors: ['A', 'B', 'C', 'D', 'E'], createdBy: '' })).toBe('A, B, C +2')
  })

  it('summarizes change counts', () => {
    expect(changeSummary({ added: 0, removed: 0, modified: 0 })).toBe('no changes')
    expect(changeSummary({ added: 2, removed: 1, modified: 3 })).toBe('2 added, 1 removed, 3 changed')
    expect(changeSummary({ added: 0, removed: 0, modified: 1 })).toBe('1 changed')
    expect(changeBadge({ added: 0, removed: 0, modified: 0 })).toBe('')
    expect(changeBadge({ added: 2, removed: 1, modified: 3 })).toBe('+2 −1 ~3')
    expect(changeBadge({ added: 1, removed: 0, modified: 0 })).toBe('+1')
  })

  it('explains a whole restore: backup first, missing files go to the trash', () => {
    const t = restoreConfirmText({ label: 'V1', createdAt: NOW, fileCount: 4 }, fmt)
    expect(t).toContain('"V1"')
    expect(t).toContain('4 files')
    expect(t).toMatch(/backup/i)
    expect(t).toMatch(/undone/)
    expect(t).toMatch(/not in that version are moved to the trash/)
    expect(restoreConfirmText({ label: null, createdAt: at(12, 9), fileCount: 1 }, fmt)).toContain('the version of D12 (1 file)')
    expect(restoreFileConfirmText('a/b.tex', { label: 'V1', createdAt: NOW }, fmt)).toContain('"a/b.tex" as it was in "V1"')
  })

  it('validates labels like the server', () => {
    expect(labelProblem('  ')).toBe('Enter a name.')
    expect(labelProblem('x'.repeat(201))).toMatch(/200/)
    expect(labelProblem(` ${'x'.repeat(200)} `)).toBeNull()
    expect(labelProblem('a\u0007b')).toMatch(/control/)
    expect(labelProblem('Submitted to journal')).toBeNull()
  })
})

describe('history: list paging and filter', () => {
  it('named only = a named kind or a label', () => {
    const list = [
      version({ id: 'a' }), version({ id: 'b', kind: 'named', label: 'N' }), version({ id: 'c', kind: 'compile', label: 'L' }),
      version({ id: 'd', kind: 'pre_restore', label: 'Before restoring "N"' }), version({ id: 'e', kind: 'import' }),
      version({ id: 'f', kind: 'pre_restore', label: 'Before restoring "Before restoring "N""' }),
      version({ id: 'g', kind: 'pre_restore', label: 'Good state before the merge' }),
    ]
    expect(isNamed(list[0]!)).toBe(false)
    expect(filterVersions(list, false).map(v => v.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    // Pre-restore backups carry an automatic label: hidden under "Named only" unless someone renamed one.
    expect(filterVersions(list, true).map(v => v.id)).toEqual(['b', 'c', 'g'])
  })

  it('appends pages without duplicates', () => {
    const one = [version({ id: 'a' }), version({ id: 'b' })]
    expect(appendPage(one, [version({ id: 'b' }), version({ id: 'c' })]).map(v => v.id)).toEqual(['a', 'b', 'c'])
    expect(appendPage([], [version({ id: 'x' })]).map(v => v.id)).toEqual(['x'])
  })

  it('reloads as many versions as were loaded, within the server limit', () => {
    expect(reloadLimit(0)).toBe(50)
    expect(reloadLimit(30)).toBe(50)
    expect(reloadLimit(80)).toBe(80)
    expect(reloadLimit(500)).toBe(100)
  })
})

describe('history: change list', () => {
  const file = (over: Partial<VersionDiff['files'][number]>): VersionDiff['files'][number] => ({
    change: 'modified', path: 'a.tex', oldPath: 'a.tex', kind: 'text', oldHash: 'h1', newHash: 'h2', modified: false, ...over,
  })

  it('sorts changed files first and separates unchanged ones', () => {
    const { changed, unchanged } = changeRows({
      files: [
        file({ change: 'unchanged', path: 'z.tex', oldPath: 'z.tex', newHash: 'h1' }),
        file({ change: 'removed', path: '', oldPath: 'old.tex', newHash: null }),
        file({ change: 'added', path: 'img.png', oldPath: '', kind: 'binary', oldHash: null }),
        file({ change: 'renamed', path: 'b/new.tex', oldPath: 'old-name.tex', modified: true }),
        file({ change: 'modified', path: 'main.tex', oldPath: 'main.tex' }),
        file({ change: 'modified', path: 'intro.tex', oldPath: 'intro.tex' }),
      ],
    })
    expect(changed.map(r => [r.change, r.path, r.detail, r.inNew])).toEqual([
      ['modified', 'intro.tex', '', true],
      ['modified', 'main.tex', '', true],
      ['renamed', 'b/new.tex', 'from old-name.tex', true],
      ['added', 'img.png', '', true],
      // A removed file is not in the new side: shown by its old path, and "Restore this file" does not apply.
      ['removed', 'old.tex', '', false],
    ])
    expect(unchanged.map(r => r.path)).toEqual(['z.tex'])
    expect(new Set([...changed, ...unchanged].map(r => r.key)).size).toBe(6)
  })

  it('words changes', () => {
    expect(changeWord({ change: 'renamed', modified: true })).toBe('renamed + changed')
    expect(changeWord({ change: 'renamed', modified: false })).toBe('renamed')
    expect(changeWord({ change: 'modified', modified: false })).toBe('changed')
    expect(contentChanged(file({ change: 'renamed', oldHash: 'h', newHash: 'h', modified: false }))).toBe(false)
    expect(contentChanged(file({ change: 'renamed', modified: true }))).toBe(true)
    expect(contentChanged(file({ change: 'unchanged' }))).toBe(false)
    expect(contentChanged(file({ change: 'added' }))).toBe(true)
  })

  it('finds where each side of a comparison comes from', () => {
    const live = new Map([['main.tex', 'f1']])
    expect(sideSource('v1', 'main.tex', live)).toEqual({ type: 'version', versionId: 'v1', path: 'main.tex' })
    expect(sideSource('current', 'main.tex', live)).toEqual({ type: 'live', fileId: 'f1', path: 'main.tex' })
    expect(sideSource('current', 'gone.tex', live)).toEqual({ type: 'none' })
    expect(sideSource('', 'main.tex', live)).toEqual({ type: 'none' }) // first version: no previous one
    expect(sideSource('v1', '', live)).toEqual({ type: 'none' }) // not on that side (added/removed)
  })

  it('highlights LaTeX-like files', () => {
    expect(isLatexLike('a/main.TEX')).toBe(true)
    expect(isLatexLike('refs.bib')).toBe(true)
    expect(isLatexLike('notes.txt')).toBe(false)
  })
})

describe('restore notices: each restore announced once', () => {
  const ev = (pre: string, by = 'Bob') => ({ versionId: 'v', preRestoreVersionId: pre, by })

  it('announces a collaborator\'s restore once', () => {
    const n = new RestoreNotices()
    expect(n.event(ev('p1'))).toEqual(ev('p1'))
    expect(n.event(ev('p1'))).toBeNull()
    expect(n.event(ev('p2'))).toEqual(ev('p2'))
  })

  it('our own restore: the response wins even when the broadcast comes first', () => {
    const n = new RestoreNotices()
    n.begin()
    expect(n.event(ev('mine', 'Alice'))).toBeNull() // held back while ours is in flight
    expect(n.event(ev('other'))).toBeNull()
    const r = n.finish('mine')
    expect(r.own).toBe(true)
    expect(r.others).toEqual([ev('other')]) // ours is not announced twice
    // The broadcast arriving after the response is ignored.
    expect(n.event(ev('mine', 'Alice'))).toBeNull()
  })

  it('a failed restore of ours releases held events', () => {
    const n = new RestoreNotices()
    n.begin()
    expect(n.event(ev('x'))).toBeNull()
    expect(n.finish(null)).toEqual({ own: false, others: [ev('x')] })
  })

  it('holds events until every restore of ours finished', () => {
    const n = new RestoreNotices()
    n.begin()
    n.begin()
    n.event(ev('x'))
    expect(n.finish('a')).toEqual({ own: true, others: [] })
    expect(n.finish('b')).toEqual({ own: true, others: [ev('x')] })
  })

  it('forgets old ids beyond its capacity', () => {
    const n = new RestoreNotices(2)
    n.claim('a')
    n.claim('b')
    n.claim('c')
    expect(n.claim('a')).toBe(true)
    expect(n.claim('c')).toBe(false)
  })

  it('words the toast', () => {
    expect(restoredText('to "V1"', 'Bob', false)).toBe('Restored to "V1" by Bob.')
    expect(restoredText('to "V1"', 'Alice', true, '2 files changed')).toBe('Restored to "V1" by you (2 files changed).')
    expect(restoredText('to "V1"', '', false)).toBe('Restored to "V1" by a collaborator.')
  })
})

describe('restore toast timing (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    toasts.splice(0)
  })
  afterEach(() => {
    toasts.splice(0)
    vi.useRealTimers()
  })

  it('offers Undo for 30 s, then the toast is gone', () => {
    const onUndo = vi.fn()
    const id = showRestoredToast({ what: 'to "V1"', by: 'Bob', mine: false, canUndo: true, onUndo })
    expect(UNDO_MS).toBe(30_000)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.text).toBe('Restored to "V1" by Bob.')
    expect(toasts[0]?.action?.label).toBe('Undo')
    vi.advanceTimersByTime(UNDO_MS - 1)
    expect(toasts.map(t => t.id)).toEqual([id])
    vi.advanceTimersByTime(1)
    expect(toasts).toHaveLength(0)
    expect(onUndo).not.toHaveBeenCalled()
    runAction(id) // too late: nothing happens
    expect(onUndo).not.toHaveBeenCalled()
  })

  it('Undo runs once and closes the toast', () => {
    const onUndo = vi.fn()
    const id = showRestoredToast({ what: 'to "V1"', by: 'Alice', mine: true, canUndo: true, onUndo })
    vi.advanceTimersByTime(10_000)
    runAction(id)
    runAction(id)
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(toasts).toHaveLength(0)
    vi.advanceTimersByTime(UNDO_MS) // the pending timeout is harmless
    expect(toasts).toHaveLength(0)
  })

  it('viewers get the notice without Undo', () => {
    showRestoredToast({ what: 'to "V1"', by: 'Bob', mine: false, canUndo: false, onUndo: () => {} })
    expect(toasts[0]?.action).toBeUndefined()
    vi.advanceTimersByTime(8000)
    expect(toasts).toHaveLength(0)
  })

  it('plain toasts still work and can be dismissed', () => {
    const id = toast('hello')
    expect(toasts[0]).toEqual({ id, text: 'hello', kind: 'info' })
    dismiss(id)
    expect(toasts).toHaveLength(0)
  })
})

describe('version events', () => {
  const ctx = { meId: 'me', treeVersion: 1, membersOpen: false }

  it('parses versions-changed and version-restored', () => {
    expect(parseMetaEvent('{"type":"versions-changed"}')).toEqual({ type: 'versions-changed' })
    expect(parseMetaEvent('{"type":"version-restored","versionId":"v","preRestoreVersionId":"p","by":"Bob"}'))
      .toEqual({ type: 'version-restored', versionId: 'v', preRestoreVersionId: 'p', by: 'Bob' })
    expect(parseMetaEvent('{"type":"version-restored","versionId":"v","by":"Bob"}')).toBeNull()
    expect(parseMetaEvent('{"type":"version-restored","versionId":1,"preRestoreVersionId":"p","by":"Bob"}')).toBeNull()
  })

  it('maps them to actions', () => {
    expect(metaEventActions({ type: 'versions-changed' }, ctx)).toEqual([{ type: 'refresh-versions' }])
    expect(metaEventActions({ type: 'version-restored', versionId: 'v', preRestoreVersionId: 'p', by: 'Bob' }, ctx))
      .toEqual([{ type: 'version-restored', versionId: 'v', preRestoreVersionId: 'p', by: 'Bob' }])
  })
})

describe('history API URLs and errors', () => {
  it('encodes version file paths and builds the zip URL', () => {
    expect(versionFileUrl('p1', 'v1', 'chapters/a b&c.tex')).toBe('/api/projects/p1/versions/v1/file?path=chapters%2Fa%20b%26c.tex')
    expect(versionFileUrl('p1', 'v1', 'img.png', true)).toBe('/api/projects/p1/versions/v1/file?path=img.png&inline=1')
    expect(versionZipUrl('p1', 'v1')).toBe('/api/projects/p1/versions/v1/export.zip')
  })

  it('explains restore errors', () => {
    expect(errorMessage({ code: 'content-missing' })).toMatch(/missing/)
    expect(errorMessage({ code: 'project-too-large', message: 'too many files' })).toBe('Too many files.')
  })
})

describe('undo of a partial restore: only the files it touched', () => {
  const vf = (path: string, fileId: string) => ({ path, fileId })

  it('maps a restored file back to its path before the restore (a rename is reverted)', () => {
    // V1 had chapters/intro.tex (f2); it was renamed to chapters/introduction.tex, then "Restore this file" from V1.
    const v1 = [vf('main.tex', 'f1'), vf('chapters/intro.tex', 'f2')]
    const before = [vf('main.tex', 'f1'), vf('chapters/introduction.tex', 'f2'), vf('bob-notes.tex', 'f9')]
    expect(undoPaths(v1, ['chapters/intro.tex'], before)).toEqual(['chapters/introduction.tex'])
    // A file restored in place: only that path, never the files created since (bob-notes.tex stays).
    expect(undoPaths(v1, ['main.tex'], before)).toEqual(['main.tex'])
  })

  it('brings back what a name clash moved to the trash (also a file where a folder is needed)', () => {
    const v1 = [vf('a.tex', 'f1'), vf('fig/x.png', 'f3')]
    // Before the restore f1 was at b.tex and another file (f5) sat at A.TEX; a file "fig" sat where the folder goes.
    const before = [vf('b.tex', 'f1'), vf('A.TEX', 'f5'), vf('fig', 'f6')]
    expect(undoPaths(v1, ['a.tex'], before)).toEqual(['A.TEX', 'b.tex'])
    expect(undoPaths(v1, ['fig/x.png'], before)).toEqual(['fig'])
  })

  it('is empty when the restored files were not in the project before (from the trash, or re-created)', () => {
    expect(undoPaths([vf('old.tex', 'f7')], ['old.tex'], [vf('main.tex', 'f1')])).toEqual([])
    expect(undoPaths([], ['unknown.tex'], [vf('main.tex', 'f1')])).toEqual([])
  })

  it('knows when the project is still exactly the restored version', () => {
    const f = (change: VersionDiff['files'][number]['change']) =>
      ({ change, path: 'a', oldPath: 'a', kind: 'text' as const, oldHash: 'h', newHash: 'h', modified: false })
    expect(sameAsCurrent({ files: [f('unchanged'), f('unchanged')] })).toBe(true)
    expect(sameAsCurrent({ files: [] })).toBe(true)
    for (const c of ['added', 'removed', 'modified', 'renamed'] as const) expect(sameAsCurrent({ files: [f('unchanged'), f(c)] })).toBe(false)
  })

  it('words the confirmation of a whole-project undo', () => {
    const mine = undoConfirmText(null)
    expect(mine).toMatch(/^Undo puts the whole project back/)
    expect(mine).toMatch(/moved to the trash/)
    expect(mine).not.toMatch(/Restore this file/)
    expect(undoConfirmText('Bob')).toMatch(/If Bob restored only some files, use "Restore this file" in History instead\./)
    expect(undoConfirmText('')).toMatch(/If your collaborator restored/)
  })
})

describe('a failed or cancelled Undo keeps the Undo (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    toasts.splice(0)
  })
  afterEach(() => {
    toasts.splice(0)
    vi.useRealTimers()
  })

  it('shows the toast again with Undo for the rest of the 30 s', async () => {
    const results = [false, true]
    const onUndo = vi.fn(() => Promise.resolve(results.shift()!))
    const id = showRestoredToast({ what: 'to "V1"', by: 'Alice', mine: false, canUndo: true, onUndo })
    vi.advanceTimersByTime(10_000)
    runAction(id)
    expect(toasts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0) // the undo failed (e.g. rate limited)
    expect(toasts).toHaveLength(1)
    const again = toasts[0]!
    expect(again.id).not.toBe(id)
    expect(again.text).toBe('Restored to "V1" by Alice.')
    expect(again.action?.label).toBe('Undo')
    // Only the remaining 20 s, not a fresh 30 s.
    vi.advanceTimersByTime(UNDO_MS - 10_000 - 1)
    expect(toasts.map(t => t.id)).toEqual([again.id])
    runAction(again.id)
    await vi.advanceTimersByTimeAsync(0) // succeeded this time: no toast comes back
    expect(onUndo).toHaveBeenCalledTimes(2)
    expect(toasts).toHaveLength(0)
  })

  it('also when the undo throws, but not once the time is (almost) up', async () => {
    const onUndo = vi.fn(() => Promise.reject(new Error('boom')))
    const id = showRestoredToast({ what: 'to "V1"', by: 'Alice', mine: true, canUndo: true, onUndo })
    runAction(id)
    await vi.advanceTimersByTimeAsync(0)
    expect(toasts).toHaveLength(1)
    vi.advanceTimersByTime(UNDO_MS - RESHOW_MIN_MS + 1)
    runAction(toasts[0]!.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(toasts).toHaveLength(0)
  })

  it('a slow failure past the 30 s does not bring the toast back', async () => {
    let fail!: (ok: boolean) => void
    const onUndo = vi.fn(() => new Promise<boolean>(r => { fail = r }))
    const id = showRestoredToast({ what: 'to "V1"', by: 'Bob', mine: false, canUndo: true, onUndo })
    runAction(id)
    vi.advanceTimersByTime(UNDO_MS)
    fail(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(toasts).toHaveLength(0)
  })
})
