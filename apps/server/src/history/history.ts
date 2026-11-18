import { randomUUID } from 'node:crypto'
import type * as Y from 'yjs'
import { parseDocName, type VersionKind } from '@ligature/shared'
import { TEXT_KEY } from '../collab/docStore.ts'
import { captureProject, withoutBytes } from './snapshot.ts'
import {
  addPendingAuthor, deleteVersions, hasAnyVersion, insertVersion, latestVersion, projectsWithVersions,
  takePendingAuthors, thinCandidates, type VersionRow,
} from './store.ts'
import { DEFAULT_RETENTION, planThinning, type RetentionPolicy } from './thinning.ts'
import type { CoreServices } from './types.ts'

/*
 * Versions: when they are taken and who is credited (docs/M3.md §1).
 *
 *  - Changes are noted by the persistence `update` listener (doc edits, with the user id of the origin) and
 *    by the tree operations: `dirty_since` (first unsnapshotted change), `last_change_at`, `pending_authors`.
 *  - A scheduler tick (every 30 s) takes an `auto` version of projects dirty for 5 min; the last client
 *    leaving a dirty project takes one too; a successful build takes a `compile` version (at most every
 *    10 min); `named`, `pre_restore` and `import` versions are taken by their operations.
 *  - The first change to a project without any version first takes a version of the state before it.
 *  - Automatic versions identical to the latest version (same manifest hash) are skipped.
 */

export interface HistoryConfig {
  /** A dirty project gets an `auto` version this long after its first unsnapshotted change (5 min). */
  autoDelayMs: number
  /** A successful build takes a `compile` version only if the latest version is older than this (10 min). */
  compileMinIntervalMs: number
  /** Scheduler period (30 s). */
  tickMs: number
  /** Thinning of automatic versions (run by the daily GC). */
  retention: RetentionPolicy
}

export const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
  autoDelayMs: 5 * 60 * 1000,
  compileMinIntervalMs: 10 * 60 * 1000,
  tickMs: 30 * 1000,
  retention: DEFAULT_RETENTION,
}

export interface TakeOptions {
  label?: string | null
  /** User id of whoever caused it (named, pre_restore, import). */
  createdBy?: string | null
  /** file id -> text to use instead of the doc's current text ("the state before this change"). */
  textOverrides?: ReadonlyMap<string, string>
  /** Timestamp (default: the history clock). */
  at?: number
}

/** Hooks the collab layer calls (see Collab.setChangeHooks). */
export interface DocChangeHooks {
  /** A transaction is about to run on a loaded file doc (not a load replay). */
  beforeTransaction(docName: string, doc: Y.Doc): void
  /** An update was applied to a file doc and logged; `userId` from its origin. */
  changed(docName: string, userId: string | null): void
  /** No doc of the project (files or meta) is loaded any more. */
  projectIdle(projectId: string): void
}

const AUTOMATIC: ReadonlySet<VersionKind> = new Set(['auto', 'compile'])

export interface HistoryOptions { clock?: () => number; config?: Partial<HistoryConfig> }

export function createHistory(s: CoreServices, opts: HistoryOptions = {}) {
  const { db } = s
  const clock = opts.clock ?? Date.now
  const config: HistoryConfig = { ...DEFAULT_HISTORY_CONFIG, ...opts.config }

  /* In-memory mirrors of DB state, so the per-update path writes only on transitions. */
  /** Projects whose `dirty_since` is known to be set. */
  const dirty = new Set<string>()
  /** Known `pending_authors` rows. */
  const pending = new Map<string, Set<string>>()
  /** `last_change_at` values not yet written. */
  const lastChange = new Map<string, number>()
  /** Projects known to have at least one version. */
  const versioned = new Set<string>()
  /** Doc text before the running transaction, for projects without a version yet. */
  const preText = new Map<string, string>()
  /** Per-project serialization of restores (and anything else that must not interleave with them). */
  const locks = new Map<string, Promise<void>>()
  /** Set by stop(): the server is shutting down, no idle versions (the docs being unloaded are not "leaving"). */
  let stopped = false

  const broadcastChanged = (projectId: string) => s.collab.broadcast(projectId, { type: 'versions-changed' })

  function hasVersion(projectId: string): boolean {
    if (versioned.has(projectId)) return true
    if (!hasAnyVersion(db, projectId)) return false
    versioned.add(projectId)
    return true
  }

  function clearDirty(projectId: string): void {
    db.prepare('UPDATE projects SET dirty_since = NULL WHERE id = ?').run(projectId)
  }

  /**
   * Snapshot the project now (synchronous: the barrier) and store it as a version. Returns the new
   * version, or null when an automatic version was skipped (identical to the latest one, or the project
   * is deleted). Text contents are written to the blob store first (deduplicated by hash).
   */
  function takeVersion(projectId: string, kind: VersionKind, o: TakeOptions = {}): VersionRow | null {
    const p = db.prepare('SELECT deleted_at AS deletedAt FROM projects WHERE id = ?').get(projectId) as { deletedAt: number | null } | undefined
    if (!p || (AUTOMATIC.has(kind) && p.deletedAt !== null)) return null
    const cap = captureProject(s, projectId, o.textOverrides)
    if (AUTOMATIC.has(kind) && latestVersion(db, projectId)?.manifestHash === cap.manifestHash) {
      // Nothing new to keep. The pending authors stay for the next version that has their changes.
      clearDirty(projectId)
      dirty.delete(projectId)
      versioned.add(projectId)
      return null
    }
    for (const f of cap.files) if (f.bytes) s.blobs.writeSync(f.bytes, f.hash)
    const row = db.transaction(() => {
      for (const f of cap.files) if (f.bytes) s.blobs.record(f.hash, f.size)
      const authors = takePendingAuthors(db, projectId)
      clearDirty(projectId)
      return insertVersion(db, {
        id: randomUUID(), projectId, kind, label: o.label ?? null, createdBy: o.createdBy ?? null,
        createdAt: o.at ?? clock(), treeVersion: cap.treeVersion, manifestHash: cap.manifestHash,
      }, withoutBytes(cap.files), authors)
    })()
    dirty.delete(projectId)
    pending.delete(projectId)
    versioned.add(projectId)
    broadcastChanged(projectId)
    return row
  }

  /** Record a change to the project's content by `userId` (null: unknown / the server). */
  function noteChange(projectId: string, userId: string | null): void {
    const now = clock()
    if (!dirty.has(projectId)) {
      db.prepare('UPDATE projects SET dirty_since = COALESCE(dirty_since, ?), last_change_at = ? WHERE id = ?').run(now, now, projectId)
      dirty.add(projectId)
      lastChange.delete(projectId)
    } else {
      lastChange.set(projectId, now)
    }
    if (userId !== null) {
      let users = pending.get(projectId)
      if (!users) pending.set(projectId, users = new Set())
      if (!users.has(userId)) {
        addPendingAuthor(db, projectId, userId)
        users.add(userId)
      }
    }
  }

  /**
   * Call right before changing a project's content (inside the operation's transaction, after its checks):
   * a project without any version first gets one of its current state, so history starts with it.
   */
  function beforeChange(projectId: string): void {
    if (!hasVersion(projectId)) takeVersion(projectId, 'auto')
  }

  function flushLastChange(): void {
    if (lastChange.size === 0 || !db.open) return
    const rows = [...lastChange]
    lastChange.clear()
    const upd = db.prepare('UPDATE projects SET last_change_at = MAX(COALESCE(last_change_at, 0), ?) WHERE id = ?')
    db.transaction(() => { for (const [id, at] of rows) upd.run(at, id) })()
  }

  const isBusy = (projectId: string) => locks.has(projectId)

  /** Run `fn` with the project's lock held (restores are serialized per project). */
  async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(projectId) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>(r => { release = r })
    const chained = prev.then(() => mine)
    locks.set(projectId, chained)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (locks.get(projectId) === chained) locks.delete(projectId)
    }
  }

  const safely = (what: string, fn: () => void) => {
    try { fn() } catch (e) { if (db.open) console.error(`[history] ${what} failed`, e) }
  }

  const docHooks: DocChangeHooks = {
    beforeTransaction(docName, doc) {
      const ref = parseDocName(docName)
      if (ref?.kind !== 'file') return
      safely('beforeTransaction', () => {
        if (hasVersion(ref.projectId)) preText.delete(docName)
        else preText.set(docName, doc.getText(TEXT_KEY).toString())
      })
    },
    changed(docName, userId) {
      const ref = parseDocName(docName)
      if (ref?.kind !== 'file') return
      const before = preText.get(docName)
      preText.delete(docName)
      safely('change tracking', () => {
        if (before !== undefined && !hasVersion(ref.projectId)) {
          takeVersion(ref.projectId, 'auto', { textOverrides: new Map([[ref.fileId, before]]) })
        }
        noteChange(ref.projectId, userId)
      })
    },
    projectIdle(projectId) {
      for (const k of preText.keys()) if (k.startsWith(`proj/${projectId}/`)) preText.delete(k)
      if (stopped || isBusy(projectId) || !db.open) return
      safely('idle version', () => {
        const r = db.prepare('SELECT dirty_since AS d FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId) as { d: number | null } | undefined
        if (r && r.d !== null) takeVersion(projectId, 'auto')
      })
    },
  }

  /** After a successful build: a `compile` version, if the latest version is old enough and something changed. */
  function onCompileSuccess(projectId: string): VersionRow | null {
    if (isBusy(projectId) || !db.open) return null
    const latest = latestVersion(db, projectId)
    if (latest && clock() - latest.createdAt < config.compileMinIntervalMs) return null
    return takeVersion(projectId, 'compile')
  }

  /** One scheduler pass: `auto` versions of projects dirty for `autoDelayMs`. Returns versions taken. */
  function tick(now: number = clock()): number {
    if (!db.open) return 0
    flushLastChange()
    const due = db.prepare(`SELECT id FROM projects WHERE deleted_at IS NULL AND dirty_since IS NOT NULL AND dirty_since <= ?
      ORDER BY dirty_since`).all(now - config.autoDelayMs) as { id: string }[]
    let n = 0
    for (const { id } of due) {
      if (isBusy(id)) continue
      safely('auto version', () => { if (takeVersion(id, 'auto', { at: now })) n++ })
    }
    return n
  }

  /** Apply the retention policy to one project. Returns the number of versions removed. */
  function thin(projectId: string, now: number = clock(), policy: RetentionPolicy = config.retention): number {
    const doomed = planThinning(thinCandidates(db, projectId), now, policy)
    if (doomed.length === 0) return 0
    const n = db.transaction(() => deleteVersions(db, projectId, doomed))()
    if (n > 0) broadcastChanged(projectId)
    return n
  }

  /** Thinning for every project with versions (the daily GC). */
  function thinAll(now: number = clock(), policy: RetentionPolicy = config.retention): number {
    let n = 0
    for (const id of projectsWithVersions(db)) if (!isBusy(id)) n += thin(id, now, policy)
    return n
  }

  let timer: NodeJS.Timeout | null = null
  let first: NodeJS.Timeout | null = null
  const runTick = () => safely('tick', () => { tick() })

  return {
    clock,
    config,
    takeVersion,
    noteChange,
    beforeChange,
    hasVersion,
    docHooks,
    onCompileSuccess,
    tick,
    thin,
    thinAll,
    withProjectLock,
    isBusy,
    /** Start the scheduler: a first pass right away (pre-M3 projects get their first version), then every `tickMs`. */
    start(): void {
      if (timer) return
      first = setTimeout(runTick, 0)
      first.unref()
      timer = setInterval(runTick, config.tickMs)
      timer.unref()
    },
    stop(): void {
      stopped = true
      if (first) clearTimeout(first)
      if (timer) clearInterval(timer)
      first = timer = null
      safely('flush', flushLastChange)
    },
  }
}

export type History = ReturnType<typeof createHistory>
