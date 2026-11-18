import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { GcReport, StorageReport } from '@ligature/shared'
import {
  copyText, hasLocalChanges, RECOVERY_TITLE, recoveryMessage, recoveryOutcome, SyncTracker, trackDoc, type LocalState,
} from '../src/lib/recovery.ts'
import {
  ariaSort, DEFAULT_SORT, formatBytes, formatDuration, gcLines, gcSummary, plural, projectBytes, sortProjects, storageTotals,
  toggleSort, type StorageProject,
} from '../src/lib/storage.ts'
import { authFailedActions } from '../src/lib/projectEvents.ts'
import { openFileOutcome } from '../src/lib/treeOps.ts'

/* ------------------------------------------------------------------ recovery (M3 §4) */

/** A doc wired like collab.ts: `server` is the provider's origin for updates received from the server. */
function session(initial = '') {
  const server = { name: 'provider' }
  const doc = new Y.Doc()
  const ytext = doc.getText('content')
  const tracker = trackDoc(doc, ytext, server)
  // The server's initial state arrives through the provider.
  if (initial) {
    const seed = new Y.Doc()
    seed.getText('content').insert(0, initial)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), server)
  }
  const remoteInsert = (index: number, s: string) => {
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    const sv = Y.encodeStateVector(other)
    other.getText('content').insert(index, s)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, sv), server)
  }
  const type = (index: number, s: string) => ytext.insert(index, s) // origin null = local, like CodeMirror's
  return { doc, ytext, tracker, server, remoteInsert, type, state: () => tracker.state(ytext.toString()) }
}

describe('recovery: SyncTracker fed by a Y.Doc', () => {
  it('a session that never finished syncing has no known synced text', () => {
    const s = session('hello')
    expect(s.state()).toEqual({ text: 'hello', unsynced: false, lastSyncedText: null })
    expect(hasLocalChanges(s.state())).toBe(false)
  })

  it('after the acknowledgement, the synced text follows the text (remote edits included)', () => {
    const s = session('hello')
    s.tracker.acknowledged()
    expect(s.state()).toEqual({ text: 'hello', unsynced: false, lastSyncedText: 'hello' })
    s.remoteInsert(5, ' world')
    expect(s.state()).toEqual({ text: 'hello world', unsynced: false, lastSyncedText: 'hello world' })
    expect(hasLocalChanges(s.state())).toBe(false)
  })

  it('local edits are unsynced until the server acknowledges them, and remember the text before them', () => {
    const s = session('hello')
    s.tracker.acknowledged()
    s.type(5, '!')
    s.type(6, '?')
    expect(s.state()).toEqual({ text: 'hello!?', unsynced: true, lastSyncedText: 'hello' })
    expect(hasLocalChanges(s.state())).toBe(true)
    // A collaborator's edit arriving meanwhile does not move the synced text.
    s.remoteInsert(0, '>')
    expect(s.state()).toEqual({ text: '>hello!?', unsynced: true, lastSyncedText: 'hello' })
    s.tracker.acknowledged()
    expect(s.state()).toEqual({ text: '>hello!?', unsynced: false, lastSyncedText: '>hello!?' })
    expect(hasLocalChanges(s.state())).toBe(false)
  })

  it('edits that cancel out (typed, then deleted, offline) are not local changes', () => {
    const s = session('abc')
    s.tracker.acknowledged()
    s.type(3, 'd')
    s.ytext.delete(3, 1)
    expect(s.state()).toEqual({ text: 'abc', unsynced: true, lastSyncedText: 'abc' })
    expect(hasLocalChanges(s.state())).toBe(false)
  })

  it('undo is a local edit too (the UndoManager is its own origin)', () => {
    const s = session('abc')
    const um = new Y.UndoManager(s.ytext, { captureTimeout: 0 })
    s.tracker.acknowledged()
    s.type(3, 'd')
    s.tracker.acknowledged()
    um.undo()
    expect(s.state()).toEqual({ text: 'abc', unsynced: true, lastSyncedText: 'abcd' })
    expect(hasLocalChanges(s.state())).toBe(true)
  })

  it('a transaction that changes nothing does not count as an edit', () => {
    const s = session('abc')
    s.tracker.acknowledged()
    s.doc.transact(() => {}, 'local')
    expect(s.state().unsynced).toBe(false)
    s.remoteInsert(0, 'x')
    expect(s.state()).toEqual({ text: 'xabc', unsynced: false, lastSyncedText: 'xabc' })
  })

  it('edits made before the first acknowledgement count, with no synced text known', () => {
    const s = session('abc')
    s.type(0, 'z')
    expect(s.state()).toEqual({ text: 'zabc', unsynced: true, lastSyncedText: null })
    expect(hasLocalChanges(s.state())).toBe(true)
  })

  it('an observer that starts another transaction before the update event of the edit does not move the synced text', () => {
    // Yjs emits 'update' after the observers; in the browser a no-op local transaction starts in between.
    const s = session('abc')
    s.ytext.observe(() => { s.doc.transact(() => {}) })
    s.tracker.acknowledged()
    s.type(3, 'xy')
    expect(s.state()).toEqual({ text: 'abcxy', unsynced: true, lastSyncedText: 'abc' })
    expect(hasLocalChanges(s.state())).toBe(true)
  })

  it('after a remote update while clean, the next edit takes the new text as its base', () => {
    const s = session('abc')
    s.tracker.acknowledged()
    s.doc.transact(() => {}) // no-op local transaction: takes 'abc'
    s.remoteInsert(0, 'R')
    s.type(4, '!')
    expect(s.state()).toEqual({ text: 'Rabc!', unsynced: true, lastSyncedText: 'Rabc' })
  })

  it('the plain tracker: the text is read once per clean period, and not before the first sync', () => {
    const t = new SyncTracker()
    let reads = 0
    t.beforeLocalTransaction(() => { reads++; return 'never' })
    expect(reads).toBe(0)
    t.acknowledged()
    t.beforeLocalTransaction(() => { reads++; return 'a' })
    t.beforeLocalTransaction(() => { reads++; return 'a2' })
    t.localUpdate()
    t.beforeLocalTransaction(() => { reads++; return 'ab' })
    t.localUpdate()
    t.remoteUpdate() // while dirty: keeps the base
    expect(reads).toBe(1)
    expect(t.state('abc')).toEqual({ text: 'abc', unsynced: true, lastSyncedText: 'a' })
    t.acknowledged()
    expect(t.state('abc')).toEqual({ text: 'abc', unsynced: false, lastSyncedText: 'abc' })
  })
})

describe('recovery: dialog or silent re-open', () => {
  const st = (over: Partial<LocalState>): LocalState => ({ text: 'mine', unsynced: true, lastSyncedText: 'base', ...over })

  it('re-opens silently without unsynced changes, whatever the server has', () => {
    expect(recoveryOutcome(st({ unsynced: false, text: 'base' }), 'other')).toBe('reopen')
    expect(recoveryOutcome(st({ unsynced: false, text: 'base' }), null)).toBe('reopen')
    // Unsynced edits that net to nothing.
    expect(recoveryOutcome(st({ text: 'base' }), 'other')).toBe('reopen')
  })

  it('shows the dialog when our edits are not on the server', () => {
    expect(recoveryOutcome(st({}), 'base')).toBe('dialog')
    expect(recoveryOutcome(st({}), 'base plus a collaborator')).toBe('dialog')
    expect(recoveryOutcome(st({ lastSyncedText: null }), 'base')).toBe('dialog')
  })

  it('shows the dialog when the server text cannot be loaded', () => {
    expect(recoveryOutcome(st({}), null)).toBe('dialog')
  })

  it('re-opens silently when the server already has exactly our text', () => {
    expect(recoveryOutcome(st({}), 'mine')).toBe('reopen')
    expect(recoveryOutcome(st({ lastSyncedText: null }), 'mine')).toBe('reopen')
  })

  it('reload-required on the open file refetches the project, which sees the new epoch', () => {
    expect(authFailedActions('reload-required', 'file')).toEqual([{ type: 'file-reload' }])
    const tree = [
      { id: 'root', parentId: null, name: '', kind: 'folder' as const },
      { id: 'f', parentId: 'root', name: 'main.tex', kind: 'text' as const, epoch: 2 },
    ]
    expect(openFileOutcome(tree, 'f', 1)).toBe('reopen')
    expect(openFileOutcome(tree, 'f', 2)).toBe('keep')
  })

  it('texts of the dialog', () => {
    expect(RECOVERY_TITLE).toBe('Your latest changes could not be merged automatically')
    expect(recoveryMessage('chapters/intro.tex')).toMatch(/^"chapters\/intro\.tex" was rebuilt on the server/)
    expect(recoveryMessage('')).toMatch(/^This file was rebuilt/)
  })
})

describe('recovery: Copy my text', () => {
  it('uses the async clipboard when it works', async () => {
    const writeText = vi.fn(async () => {})
    const execCopy = vi.fn(() => true)
    expect(await copyText('x', { clipboard: { writeText }, execCopy })).toBe(true)
    expect(writeText).toHaveBeenCalledWith('x')
    expect(execCopy).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when the clipboard refuses or is missing', async () => {
    const execCopy = vi.fn(() => true)
    const writeText = vi.fn(async () => { throw new Error('denied') })
    expect(await copyText('y', { clipboard: { writeText }, execCopy })).toBe(true)
    expect(execCopy).toHaveBeenCalledWith('y')
    expect(await copyText('z', { execCopy })).toBe(true)
  })

  it('reports failure when nothing works', async () => {
    expect(await copyText('z', {})).toBe(false)
    expect(await copyText('z', { execCopy: () => false })).toBe(false)
    expect(await copyText('z', { execCopy: () => { throw new Error('no') } })).toBe(false)
  })
})

/* ------------------------------------------------------------------ admin storage (M3 §5) */

function proj(over: Partial<StorageProject>): StorageProject {
  return { id: 'p', name: 'P', owner: 'Alice', deleted: false, liveFiles: 1, liveBytes: 0, trashBytes: 0, versions: 0, ...over }
}

const GC: GcReport = { at: 0, durationMs: 1234, blobsRemoved: 3, bytesFreed: 3 * 1024 * 1024, orphanDocsRemoved: 1, versionsThinned: 0, projectsPurged: 2 }

describe('storage: formatting', () => {
  it('formats bytes with 1024-based units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024 + 600)).toBe('11 KB')
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB')
    expect(formatBytes(5.25 * 1024 ** 3)).toBe('5.3 GB')
    expect(formatBytes(2 * 1024 ** 5)).toBe('2048 TB')
    expect(formatBytes(-1)).toBe('?')
    expect(formatBytes(Number.NaN)).toBe('?')
  })

  it('formats durations and plurals', () => {
    expect(formatDuration(12.4)).toBe('12 ms')
    expect(formatDuration(1234)).toBe('1.2 s')
    expect(formatDuration(75_000)).toBe('1 min 15 s')
    // Rounded once, then split: never "60 s" or "1 min 60 s".
    expect(formatDuration(999.6)).toBe('1 s')
    expect(formatDuration(59_940)).toBe('59.9 s')
    expect(formatDuration(59_960)).toBe('1 min 0 s')
    expect(formatDuration(119_600)).toBe('2 min 0 s')
    expect(formatDuration(3_599_600)).toBe('60 min 0 s')
    expect(formatDuration(3_599_400)).toBe('59 min 59 s')
    expect(plural(1, 'blob')).toBe('1 blob')
    expect(plural(0, 'blob')).toBe('0 blobs')
    expect(plural(2, 'entry', 'entries')).toBe('2 entries')
  })
})

describe('storage: per-project table', () => {
  const ps = [
    proj({ id: 'a', name: 'beta', owner: 'Zoe', liveFiles: 5, liveBytes: 100, trashBytes: 900, versions: 3 }),
    proj({ id: 'b', name: 'Alpha', owner: 'bob', liveFiles: 9, liveBytes: 500, trashBytes: 0, versions: 10 }),
    proj({ id: 'c', name: 'gamma', owner: 'Alice', liveFiles: 1, liveBytes: 700, trashBytes: 0, versions: 1, deleted: true }),
    proj({ id: 'd', name: 'Delta 10', owner: 'Alice', liveFiles: 1, liveBytes: 500, trashBytes: 0, versions: 1 }),
    proj({ id: 'e', name: 'Delta 9', owner: 'Alice', liveFiles: 1, liveBytes: 500, trashBytes: 0, versions: 1 }),
  ]
  const ids = (s: Parameters<typeof sortProjects>[1]) => sortProjects(ps, s).map(p => p.id)

  it('sorts by total size by default, biggest first, ties by name', () => {
    expect(DEFAULT_SORT).toEqual({ key: 'total', dir: 'desc' })
    expect(projectBytes(ps[0]!)).toBe(1000)
    expect(ids(DEFAULT_SORT)).toEqual(['a', 'c', 'b', 'e', 'd'])
    expect(ids({ key: 'total', dir: 'asc' })).toEqual(['b', 'e', 'd', 'c', 'a'])
  })

  it('sorts by any column, text case-insensitively and with numbers in names', () => {
    expect(ids({ key: 'name', dir: 'asc' })).toEqual(['b', 'a', 'e', 'd', 'c'])
    expect(ids({ key: 'owner', dir: 'asc' })).toEqual(['e', 'd', 'c', 'b', 'a'])
    expect(ids({ key: 'liveBytes', dir: 'desc' })).toEqual(['c', 'b', 'e', 'd', 'a'])
    expect(ids({ key: 'trashBytes', dir: 'desc' })[0]).toBe('a')
    expect(ids({ key: 'versions', dir: 'desc' })).toEqual(['b', 'a', 'e', 'd', 'c'])
    expect(ids({ key: 'liveFiles', dir: 'asc' })).toEqual(['e', 'd', 'c', 'a', 'b'])
  })

  it('does not change the input', () => {
    const before = ps.map(p => p.id)
    sortProjects(ps, { key: 'name', dir: 'desc' })
    expect(ps.map(p => p.id)).toEqual(before)
  })

  it('toggles: same column flips, a new one starts A-Z for text and largest first for numbers', () => {
    expect(toggleSort(DEFAULT_SORT, 'total')).toEqual({ key: 'total', dir: 'asc' })
    expect(toggleSort({ key: 'total', dir: 'asc' }, 'total')).toEqual({ key: 'total', dir: 'desc' })
    expect(toggleSort(DEFAULT_SORT, 'name')).toEqual({ key: 'name', dir: 'asc' })
    expect(toggleSort({ key: 'name', dir: 'asc' }, 'versions')).toEqual({ key: 'versions', dir: 'desc' })
    expect(ariaSort(DEFAULT_SORT, 'total')).toBe('descending')
    expect(ariaSort({ key: 'name', dir: 'asc' }, 'name')).toBe('ascending')
    expect(ariaSort(DEFAULT_SORT, 'name')).toBe('none')
  })
})

describe('storage: totals and GC report', () => {
  it('adds up the projects, counting deleted ones separately', () => {
    const r: StorageReport = {
      databaseBytes: 4096, blobs: { count: 3, bytes: 300 }, unreferenced: { count: 1, bytes: 10 }, lastGc: null,
      projects: [
        proj({ id: 'a', liveFiles: 2, liveBytes: 20, trashBytes: 5, versions: 4 }),
        proj({ id: 'b', liveFiles: 3, liveBytes: 30, trashBytes: 7, versions: 1, deleted: true }),
        proj({ id: 'c', liveFiles: 1, liveBytes: 1, trashBytes: 2, versions: 3 }),
      ],
    }
    // Files, trash and versions count live projects only; the deleted project is reported on its own line.
    expect(storageTotals(r)).toEqual({ projects: 2, deletedProjects: 1, deletedBytes: 37, liveFiles: 3, liveBytes: 21, trashBytes: 7, versions: 7 })
    expect(storageTotals({ ...r, projects: [] }))
      .toEqual({ projects: 0, deletedProjects: 0, deletedBytes: 0, liveFiles: 0, liveBytes: 0, trashBytes: 0, versions: 0 })
  })

  it('describes a GC run', () => {
    expect(gcLines(GC)).toEqual([
      '3 unreferenced blobs removed (3 MB freed)',
      '1 orphaned document removed',
      '0 old automatic versions thinned',
      '2 deleted projects purged',
    ])
    expect(gcSummary(GC)).toBe('Garbage collection finished in 1.2 s: 3 MB freed (3 blobs), 1 orphaned document, 2 projects purged.')
    expect(gcSummary({ ...GC, blobsRemoved: 0, bytesFreed: 0, orphanDocsRemoved: 0, projectsPurged: 0, versionsThinned: 1, durationMs: 40 }))
      .toBe('Garbage collection finished in 40 ms: 1 version thinned.')
    expect(gcSummary({ ...GC, blobsRemoved: 0, orphanDocsRemoved: 0, projectsPurged: 0 })).toMatch(/: nothing to remove\.$/)
  })
})
