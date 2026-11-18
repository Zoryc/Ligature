import { describe, expect, it } from 'vitest'
import type { VersionFile } from '@ligature/shared'
import { changeCounts, diffFiles } from '../src/history/diff.ts'
import { manifestHash } from '../src/history/manifest.ts'
import { planThinning, type ThinCandidate } from '../src/history/thinning.ts'
import { planRestore } from '../src/history/restore.ts'

const vf = (path: string, fileId: string, hash: string, kind: 'text' | 'binary' = 'text', size = 1): VersionFile => ({ path, fileId, hash, kind, size })

describe('manifest hash', () => {
  it('depends on path, file id and content, not on order', () => {
    const a = [vf('a.tex', 'A', 'h1'), vf('b/c.tex', 'B', 'h2')]
    expect(manifestHash(a)).toBe(manifestHash([...a].reverse()))
    expect(manifestHash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(manifestHash(a)).not.toBe(manifestHash([vf('a.tex', 'A', 'h1'), vf('b/c.tex', 'B', 'h3')])) // content
    expect(manifestHash(a)).not.toBe(manifestHash([vf('a.tex', 'A', 'h1'), vf('b/d.tex', 'B', 'h2')])) // path
    expect(manifestHash(a)).not.toBe(manifestHash([vf('a.tex', 'A', 'h1'), vf('b/c.tex', 'X', 'h2')])) // id (re-created file)
    expect(manifestHash([])).toBe(manifestHash([]))
  })
})

describe('diff: matched by file id first, then by path', () => {
  it('added, removed, modified, unchanged', () => {
    const d = diffFiles([vf('a.tex', 'A', '1'), vf('b.tex', 'B', '2'), vf('c.tex', 'C', '3')],
      [vf('a.tex', 'A', '1'), vf('b.tex', 'B', '9'), vf('d.png', 'D', '4', 'binary')])
    expect(d).toEqual([
      { change: 'unchanged', path: 'a.tex', oldPath: 'a.tex', kind: 'text', oldHash: '1', newHash: '1', modified: false },
      { change: 'modified', path: 'b.tex', oldPath: 'b.tex', kind: 'text', oldHash: '2', newHash: '9', modified: true },
      { change: 'removed', path: '', oldPath: 'c.tex', kind: 'text', oldHash: '3', newHash: null, modified: false },
      { change: 'added', path: 'd.png', oldPath: '', kind: 'binary', oldHash: null, newHash: '4', modified: false },
    ])
  })

  it('renames (with and without content changes), swaps, and a re-created file at the same path', () => {
    const d = diffFiles(
      [vf('old.tex', 'A', '1'), vf('x.tex', 'B', '2'), vf('y.tex', 'C', '3'), vf('fig.png', 'D', '4', 'binary'), vf('keep.tex', 'E', '5')],
      [vf('ch/new.tex', 'A', '1'), vf('y.tex', 'B', '2'), vf('x.tex', 'C', '30'), vf('fig.png', 'Z', '4', 'binary'), vf('moved.tex', 'E', '6')])
    const byPath = Object.fromEntries(d.map(e => [e.path || e.oldPath, [e.change, e.oldPath, e.modified]]))
    expect(byPath).toEqual({
      'ch/new.tex': ['renamed', 'old.tex', false],
      'y.tex': ['renamed', 'x.tex', false], // swap: by id, not by path
      'x.tex': ['renamed', 'y.tex', true],
      'fig.png': ['unchanged', 'fig.png', false], // other id, same path and content
      'moved.tex': ['renamed', 'keep.tex', true],
    })
    expect(changeCounts([vf('old.tex', 'A', '1')], [vf('new.tex', 'A', '1'), vf('n.tex', 'N', '2')])).toEqual({ added: 1, removed: 0, modified: 1 })
    expect(changeCounts([], [])).toEqual({ added: 0, removed: 0, modified: 0 })
  })

  it('an id match wins over a path match; leftover files then match by path', () => {
    // A moved from a.tex to b.tex; a new file N now sits at a.tex.
    // B, the only leftover, sat at b.tex: N (at a.tex) matches nothing by path.
    const d = diffFiles([vf('a.tex', 'A', '1'), vf('b.tex', 'B', '2')], [vf('b.tex', 'A', '1'), vf('a.tex', 'N', '7')])
    expect(d.map(e => [e.change, e.oldPath, e.path])).toEqual([
      ['added', '', 'a.tex'],
      ['removed', 'b.tex', ''],
      ['renamed', 'a.tex', 'b.tex'],
    ])
    // Leftovers match by path: B deleted, N created at b.tex.
    const e = diffFiles([vf('a.tex', 'A', '1'), vf('b.tex', 'B', '2')], [vf('a.tex', 'A', '1'), vf('b.tex', 'N', '2')])
    expect(e.map(x => [x.change, x.oldPath, x.path])).toEqual([['unchanged', 'a.tex', 'a.tex'], ['unchanged', 'b.tex', 'b.tex']])
  })
})

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1000 * DAY + 12 * HOUR // mid-day, so bucket boundaries are easy to reason about

describe('thinning (pure)', () => {
  let seq = 0
  const v = (id: string, ageMs: number, kind: ThinCandidate['kind'] = 'auto', label: string | null = null): ThinCandidate =>
    ({ id, kind, label, createdAt: NOW - ageMs, seq: ++seq })

  it('keeps everything from the last 24 h, then the newest per hour / day / week', () => {
    const versions = [
      v('fresh1', 1 * HOUR), v('fresh2', 1 * HOUR + 60_000), v('fresh3', 23 * HOUR),
      // 2 days old: three in one hour bucket, one in the next
      v('h-old', 2 * DAY + 40 * 60_000), v('h-mid', 2 * DAY + 30 * 60_000), v('h-new', 2 * DAY + 10 * 60_000), v('h-other', 2 * DAY + 90 * 60_000),
      // 10 days old: two the same day, one the day before
      v('d-old', 10 * DAY + 2 * HOUR), v('d-new', 10 * DAY + 1 * HOUR), v('d-prev', 11 * DAY + 1 * HOUR),
      // 200 days: two in the same epoch week
      v('w-a', 200 * DAY + 1 * HOUR, 'compile'), v('w-b', 200 * DAY + 2 * HOUR),
    ]
    const doomed = planThinning(versions, NOW).sort()
    expect(doomed).toEqual(['d-old', 'h-mid', 'h-old', 'w-b'].sort())
  })

  it('never thins named, pre_restore, import or labelled versions, nor the latest one', () => {
    const versions = [
      v('named', 30 * DAY, 'named', 'Submitted'), v('pre', 30 * DAY + 1, 'pre_restore', 'Before restoring'),
      v('imp', 30 * DAY + 2, 'import'), v('labelled-auto', 30 * DAY + 3, 'auto', 'mine'),
      v('auto-a', 30 * DAY + 4), v('auto-b', 30 * DAY + 5),
    ]
    expect(planThinning(versions, NOW)).toEqual(['auto-b'])
    // The latest version is never thinned (and, being the newest of its week, the older one in that week goes).
    const only = [v('old-latest', 400 * DAY), v('older', 400 * DAY + 1000)]
    expect(planThinning(only, NOW)).toEqual(['older'])
    const tie = [v('t1', 50 * DAY), v('t2', 50 * DAY)] // same timestamp: the later insert is newer
    expect(planThinning(tie, NOW)).toEqual(['t1'])
    expect(planThinning([], NOW)).toEqual([])
  })

  it('honours a custom policy', () => {
    const versions = [v('a', 2 * HOUR), v('b', 2 * HOUR - 1000), v('c', 0)]
    expect(planThinning(versions, NOW, { keepAllMs: HOUR, hourlyMs: 7 * DAY, dailyMs: 90 * DAY })).toEqual(['a'])
    expect(planThinning(versions, NOW)).toEqual([]) // default: all younger than 24 h
  })
})

/* ------------------------------------------------------------------ restore planning */

type Row = Parameters<typeof planRestore>[0][number]
const ROOT = 'root'
const row = (id: string, parentId: string | null, name: string, kind: Row['kind'], extra: Partial<Row> = {}): Row =>
  ({ id, parentId, name, kind, epoch: 1, blobHash: null, size: kind === 'folder' ? null : 1, deletedAt: null, wasMain: 0, orphan: 0, batch: null, ...extra })
const LIMITS = { maxFiles: 2000, maxBinaryBytes: 500 * 1024 * 1024 }

describe('restore planning (pure)', () => {
  it('rename back, from the trash, purged -> re-created in a new folder, clash -> trash', () => {
    const rows = [
      row(ROOT, null, '', 'folder'),
      row('A', ROOT, 'renamed.tex', 'text'), // version: a.tex
      row('B', ROOT, 'b.tex', 'text', { deletedAt: 5 }), // trashed; version: b.tex
      row('X', ROOT, 'c.tex', 'text'), // another file now at the version's c.tex path (C was purged)
      row('Y', ROOT, 'other.tex', 'text'), // not in the version
    ]
    const files = [vf('a.tex', 'A', '1'), vf('b.tex', 'B', '2'), vf('c.tex', 'C', '3'), vf('sub/d.tex', 'D', '4')]
    const partial = planRestore(rows, files, false, LIMITS)
    const s = Object.fromEntries(partial.subjects.map(x => [x.vf.path, x.mode]))
    expect(s).toEqual({ 'a.tex': 'live', 'b.tex': 'trash', 'c.tex': 'create', 'sub/d.tex': 'create' })
    expect(partial.subjects.find(x => x.vf.path === 'c.tex')!.id).not.toBe('C') // new id
    expect(partial.folders.map(f => f.name)).toEqual(['sub'])
    expect(partial.batches).toEqual([{ top: 'X', ids: ['X'] }]) // the clash
    expect(partial.trashedFiles).toBe(1)

    const whole = planRestore(rows, files, true, LIMITS)
    expect(whole.batches.map(b => b.top).sort()).toEqual(['X', 'Y'])
    expect(whole.trashedFiles).toBe(2)
  })

  it('a file where the version has a folder goes to the trash; folders left empty by a whole restore go with their files', () => {
    const rows = [
      row(ROOT, null, '', 'folder'),
      row('F', ROOT, 'ch', 'text'), // a file named like the version's folder
      row('G', ROOT, 'figs', 'folder'), row('P', 'G', 'new.png', 'binary'), row('E', 'G', 'empty', 'folder'),
      row('K', ROOT, 'keep-empty', 'folder'), // was empty already: stays
      row('M', ROOT, 'main.tex', 'text'),
    ]
    const plan = planRestore(rows, [vf('main.tex', 'M', '1'), vf('ch/intro.tex', 'I', '2')], true, LIMITS)
    const tops = plan.batches.map(b => [b.top, [...b.ids].sort()])
    expect(tops.sort()).toEqual([['F', ['F']], ['G', ['E', 'G', 'P']]])
    expect(plan.folders.map(f => f.name)).toEqual(['ch'])
    expect(plan.trashedFiles).toBe(2)
  })

  it('swapped names and case-only renames are planned without clashes', () => {
    const rows = [row(ROOT, null, '', 'folder'), row('A', ROOT, 'b.tex', 'text'), row('B', ROOT, 'a.tex', 'text'), row('C', ROOT, 'Readme.md', 'text')]
    const plan = planRestore(rows, [vf('a.tex', 'A', '1'), vf('b.tex', 'B', '2'), vf('README.md', 'C', '3')], true, LIMITS)
    expect(plan.batches).toEqual([])
    expect(plan.subjects.map(x => [x.id, x.name])).toEqual([['C', 'README.md'], ['A', 'a.tex'], ['B', 'b.tex']])
  })

  it('refuses before anything changes when the result would exceed the project limits', () => {
    const rows = [row(ROOT, null, '', 'folder'), row('A', ROOT, 'a.tex', 'text')]
    const files = [vf('a.tex', 'A', '1'), vf('x/b.tex', 'B', '2'), vf('big.bin', 'Z', '3', 'binary', 900)]
    expect(() => planRestore(rows, files, true, { maxFiles: 3, maxBinaryBytes: 10_000 })).toThrow(expect.objectContaining({ status: 413, code: 'project-too-large' }))
    expect(() => planRestore(rows, files, true, { maxFiles: 10, maxBinaryBytes: 800 })).toThrow(expect.objectContaining({ code: 'project-too-large' }))
    expect(planRestore(rows, files, true, { maxFiles: 4, maxBinaryBytes: 900 }).subjects).toHaveLength(3)
  })
})
