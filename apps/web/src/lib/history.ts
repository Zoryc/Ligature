/**
 * Pure helpers for the History panel (docs/M3.md §7): grouping versions by day, display texts,
 * change summaries, the change list of a diff, paging. The server does the real work; these only present it.
 */
import type { FileChange, VersionDiff, VersionFile, VersionKind, VersionSummary } from '@ligature/shared'
import { FORMER_MEMBER, personName } from './people.ts'

/** Short symbol + name of each kind (plain text symbols, no images). */
export const KINDS: Record<VersionKind, { icon: string; name: string }> = {
  auto: { icon: '◷', name: 'Automatic' },
  compile: { icon: '▶', name: 'After compile' },
  named: { icon: '★', name: 'Named' },
  pre_restore: { icon: '↺', name: 'Before restore' },
  import: { icon: '⇩', name: 'Imported' },
}

export function kindIcon(kind: VersionKind): string {
  return KINDS[kind]?.icon ?? '•'
}

export function kindName(kind: VersionKind): string {
  return KINDS[kind]?.name ?? kind
}

/** Local calendar day of a timestamp: 'YYYY-MM-DD'. */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** The day `n` days before the day of `ts` (local calendar, DST-safe). */
function dayKeyBefore(ts: number, n: number): string {
  const d = new Date(ts)
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12).getTime())
}

export function defaultDayTitle(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

/** "Today", "Yesterday", or a full date. */
export function dayTitle(ts: number, now: number, format: (ts: number) => string = defaultDayTitle): string {
  const key = dayKey(ts)
  if (key === dayKey(now)) return 'Today'
  if (key === dayKeyBefore(now, 1)) return 'Yesterday'
  return format(ts)
}

export interface DayGroup<T> { key: string; title: string; items: T[] }

/** Versions (newest first) grouped by local day, keeping their order. */
export function groupByDay<T extends { createdAt: number }>(items: readonly T[], now: number,
  format: (ts: number) => string = defaultDayTitle): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  for (const it of items) {
    const key = dayKey(it.createdAt)
    const last = groups.at(-1)
    if (last && last.key === key) last.items.push(it)
    else groups.push({ key, title: dayTitle(it.createdAt, now, format), items: [it] })
  }
  return groups
}

export function timeText(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function dateTimeText(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Title of a version in the list: its label, or what kind of version it is. */
export function versionTitle(v: Pick<VersionSummary, 'kind' | 'label'>): string {
  if (v.label) return v.label
  switch (v.kind) {
    case 'auto': return 'Automatic version'
    case 'compile': return 'Version after a compile'
    case 'named': return 'Named version'
    case 'pre_restore': return 'Before a restore'
    case 'import': return 'Imported project'
  }
}

/** How a version is referred to in texts (toasts, confirmations): its label in quotes, or its date and time. */
export function versionRef(v: Pick<VersionSummary, 'label' | 'createdAt'>, fmt: (ts: number) => string = dateTimeText): string {
  return v.label ? `"${v.label}"` : `the version of ${fmt(v.createdAt)}`
}

/** Kinds a person creates: there an empty createdBy means the account was deleted, not "automatic". */
const CREATED_BY_SOMEONE: ReadonlySet<VersionKind> = new Set(['named', 'pre_restore', 'import'])

/**
 * Version authors as shown: deleted accounts become "a former member", once however many there were.
 * Only those are merged: two living people may share a display name and both count (as on the server).
 */
function authorNames(authors: readonly string[]): string[] {
  const out: string[] = []
  for (const name of authors.map(personName)) {
    if (name !== FORMER_MEMBER || !out.includes(FORMER_MEMBER)) out.push(name)
  }
  return out
}

/** "Alice, Bob" / "by Alice" / "" — who changed something, and who created it (named, restore). */
export function authorsText(v: Pick<VersionSummary, 'authors' | 'createdBy'> & { kind?: VersionKind }): string {
  const authors = authorNames(v.authors)
  const createdBy = v.createdBy || (v.kind && CREATED_BY_SOMEONE.has(v.kind) ? FORMER_MEMBER : '')
  const parts: string[] = []
  if (authors.length > 0) {
    const shown = authors.slice(0, 3).join(', ')
    parts.push(authors.length > 3 ? `${shown} +${authors.length - 3}` : shown)
  }
  if (createdBy && !authors.includes(createdBy)) parts.push(`by ${createdBy}`)
  return parts.join(' · ')
}

/** "2 added, 1 removed, 3 changed", or "no changes". */
export function changeSummary(c: VersionSummary['changes']): string {
  const parts: string[] = []
  if (c.added) parts.push(`${c.added} added`)
  if (c.removed) parts.push(`${c.removed} removed`)
  if (c.modified) parts.push(`${c.modified} changed`)
  return parts.length ? parts.join(', ') : 'no changes'
}

/** Compact form for the list: "+2 −1 ~3" (empty when nothing changed). */
export function changeBadge(c: VersionSummary['changes']): string {
  const parts: string[] = []
  if (c.added) parts.push(`+${c.added}`)
  if (c.removed) parts.push(`−${c.removed}`)
  if (c.modified) parts.push(`~${c.modified}`)
  return parts.join(' ')
}

/** Start of the label the server gives every pre-restore backup (docs/M3.md §2). */
export const PRE_RESTORE_LABEL_PREFIX = 'Before restoring '

/**
 * "Named only": versions a person named (a label, or the named kind). Pre-restore backups carry an automatic
 * label (`Before restoring "…"`), so they count only when someone renamed them to something else.
 */
export function isNamed(v: Pick<VersionSummary, 'kind' | 'label'>): boolean {
  if (v.kind === 'named') return true
  if (v.label === null) return false
  return v.kind !== 'pre_restore' || !v.label.startsWith(PRE_RESTORE_LABEL_PREFIX)
}

export function filterVersions<T extends Pick<VersionSummary, 'kind' | 'label'>>(list: readonly T[], namedOnly: boolean): T[] {
  return namedOnly ? list.filter(isNamed) : list.slice()
}

/** Append a page to the loaded list (newest first), dropping ids we already have. */
export function appendPage<T extends { id: string }>(loaded: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(loaded.map(v => v.id))
  return [...loaded, ...page.filter(v => !seen.has(v.id))]
}

/** Page size to use when reloading the list after versions-changed: what was loaded, within the server's 1..100. */
export function reloadLimit(loadedCount: number, pageSize = 50): number {
  return Math.min(100, Math.max(pageSize, loadedCount))
}

/** Label validation as on the server: 1–200 characters after trimming, no control characters. */
export function labelProblem(raw: string): string | null {
  const t = raw.trim()
  if (t.length === 0) return 'Enter a name.'
  if (t.length > 200) return 'At most 200 characters.'
  if (/[\u0000-\u001f\u007f]/.test(t)) return 'No control characters.'
  return null
}

export type DiffFile = VersionDiff['files'][number]

export interface ChangeRow {
  /** Stable key for the list. */
  key: string
  change: FileChange
  /** Path to show (new side, or old side when removed). */
  path: string
  /** "renamed from a.tex" etc. */
  detail: string
  kind: 'text' | 'binary'
  /** The file is in the version on the new side, so "Restore this file" applies. */
  inNew: boolean
  file: DiffFile
}

const ORDER: Record<FileChange, number> = { modified: 0, renamed: 1, added: 2, removed: 3, unchanged: 4 }

export function changeWord(f: Pick<DiffFile, 'change' | 'modified'>): string {
  switch (f.change) {
    case 'added': return 'added'
    case 'removed': return 'removed'
    case 'modified': return 'changed'
    case 'renamed': return f.modified ? 'renamed + changed' : 'renamed'
    case 'unchanged': return 'unchanged'
  }
}

/** The change list of a diff: changed files first (modified, renamed, added, removed), then by path. */
export function changeRows(diff: Pick<VersionDiff, 'files'>): { changed: ChangeRow[]; unchanged: ChangeRow[] } {
  const rows = diff.files.map((f): ChangeRow => {
    const path = f.path || f.oldPath
    return {
      key: `${f.change}:${f.oldPath}->${f.path}`,
      change: f.change,
      path,
      detail: f.change === 'renamed' ? `from ${f.oldPath}` : '',
      kind: f.kind,
      inNew: f.path !== '',
      file: f,
    }
  })
  rows.sort((a, b) => ORDER[a.change] - ORDER[b.change] || a.path.localeCompare(b.path))
  return { changed: rows.filter(r => r.change !== 'unchanged'), unchanged: rows.filter(r => r.change === 'unchanged') }
}

/** Was the content changed (not just the path)? Text changes get a merge view; unchanged ones too, read-only. */
export function contentChanged(f: Pick<DiffFile, 'change' | 'modified' | 'oldHash' | 'newHash'>): boolean {
  if (f.change === 'renamed') return f.modified || f.oldHash !== f.newHash
  return f.change !== 'unchanged'
}

/** Confirmation text of "Restore this version". */
export function restoreConfirmText(v: Pick<VersionSummary, 'label' | 'createdAt' | 'fileCount'>, fmt: (ts: number) => string = dateTimeText): string {
  return [
    `Restore the project to ${versionRef(v, fmt)} (${v.fileCount} file${v.fileCount === 1 ? '' : 's'})?`,
    'A backup of the current state is saved in the history first, so this can be undone.',
    'Files that are not in that version are moved to the trash (you can get them back from there).',
    'Open files are updated for everyone working on the project.',
  ].join('\n\n')
}

export function restoreFileConfirmText(path: string, v: Pick<VersionSummary, 'label' | 'createdAt'>, fmt: (ts: number) => string = dateTimeText): string {
  return `Restore "${path}" as it was in ${versionRef(v, fmt)}? A backup of the current state is saved in the history first.`
}

/**
 * Paths (in the pre-restore version) that undo a restore of only `paths` of `restored`, so Undo puts back just
 * what that restore touched instead of the whole project:
 * - each restored file (matched by file id) at the path it had before (a rename is reverted);
 * - whatever sat at a restored path, or at one of its folders, before: a name clash moved it to the trash, and
 *   restoring it from the pre-restore version brings it back (case-insensitive, as names are on the server).
 * Empty when none of the restored files existed before the restore (they came from the trash or were re-created).
 */
export function undoPaths(restored: readonly Pick<VersionFile, 'path' | 'fileId'>[], paths: readonly string[],
  before: readonly Pick<VersionFile, 'path' | 'fileId'>[]): string[] {
  const restoredByPath = new Map(restored.map(f => [f.path, f]))
  const beforeById = new Map(before.map(f => [f.fileId, f]))
  const beforeByPath = new Map(before.map(f => [f.path.toLowerCase(), f]))
  const out = new Set<string>()
  for (const p of paths) {
    const f = restoredByPath.get(p)
    const was = f ? beforeById.get(f.fileId) : undefined
    if (was) out.add(was.path)
    const segs = p.split('/')
    for (let i = 1; i <= segs.length; i++) {
      const occupant = beforeByPath.get(segs.slice(0, i).join('/').toLowerCase())
      if (occupant) out.add(occupant.path)
    }
  }
  return [...out].sort()
}

/** Nothing differs between a version and the live state (a `diff?against=current` with only unchanged files). */
export function sameAsCurrent(diff: Pick<VersionDiff, 'files'>): boolean {
  return diff.files.every(f => f.change === 'unchanged')
}

/**
 * Confirmation before an Undo that restores the whole project while it has changed since the restore.
 * `by`: who restored (null: we did, in this tab — then we know it was a whole-project restore).
 */
export function undoConfirmText(by: string | null): string {
  return [
    'Undo puts the whole project back as it was just before the restore.',
    'Changes made since the restore are replaced, and files that were not in the project then are moved to the trash.',
    ...(by === null ? [] : [`If ${by || 'your collaborator'} restored only some files, use "Restore this file" in History instead.`]),
    'A backup of the current state is saved in the history first, so this can be undone too.',
  ].join('\n\n')
}

/** Short text of a restore result. */
export function restoreResultText(r: { restored: number; trashed: number }): string {
  const parts = [`${r.restored} file${r.restored === 1 ? '' : 's'} changed`]
  if (r.trashed) parts.push(`${r.trashed} moved to the trash`)
  return parts.join(', ')
}

/** Where one side of a file comparison comes from. */
export type SideSource =
  | { type: 'version'; versionId: string; path: string }
  | { type: 'live'; fileId: string; path: string }
  | { type: 'none' }

/**
 * Source of one side: `ref` is a version id, 'current' (the live project: the file with that path now),
 * or '' (no version: the first version has no previous one). `path` '' means the file is not on that side.
 */
export function sideSource(ref: string, path: string, liveIdByPath: ReadonlyMap<string, string>): SideSource {
  if (ref === '' || path === '') return { type: 'none' }
  if (ref === 'current') {
    const fileId = liveIdByPath.get(path)
    return fileId ? { type: 'live', fileId, path } : { type: 'none' }
  }
  return { type: 'version', versionId: ref, path }
}

/** Language hint for the merge view: LaTeX-like files get stex highlighting. */
export function isLatexLike(path: string): boolean {
  return /\.(tex|sty|cls|bib|bbx|cbx|dtx|ins|ltx)$/i.test(path)
}

/** A file comparison to show: the change row and where each side's content comes from. */
export interface DiffRequest { row: ChangeRow; left: SideSource; right: SideSource; leftTitle: string; rightTitle: string }
