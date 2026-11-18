/**
 * Pure helpers for the trash can panel (docs/M2.md §1): sorting, display texts, the "Restore to…"
 * folder list. The server does the real work (naming on clash, limits); these only present it.
 */
import type { TrashEntry, TreeEntry } from '@ligature/shared'
import { entryPath, folderLabel, formatBytes } from './treeOps.ts'

const DAY = 24 * 60 * 60 * 1000

/** Newest deletion first; ties by path so the order is stable. */
export function sortTrash(entries: readonly TrashEntry[]): TrashEntry[] {
  return entries.slice().sort((a, b) => b.deletedAt - a.deletedAt || a.originalPath.localeCompare(b.originalPath))
}

/** Label of the trash button in the file tree. */
export function trashButtonLabel(count: number): string {
  return count > 0 ? `Trash (${count})` : 'Trash'
}

/** Whole days left before the automatic purge (rounded up, never negative). */
export function daysLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / DAY))
}

export function expiryText(expiresAt: number, now: number): string {
  const d = daysLeft(expiresAt, now)
  if (expiresAt - now <= 0) return 'deleted forever soon'
  if (d <= 1) return 'deleted forever within a day'
  return `deleted forever in ${d} days`
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", or a date for anything older than a week. */
export function agoText(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d <= 7) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ts).toLocaleDateString()
}

export interface TrashRow {
  id: string
  /** Name as shown: folders end with '/'. */
  label: string
  /** Where it was: the folder part of the original path ('/' for the root). */
  from: string
  /** "by Alice, 5 min ago" */
  deleted: string
  /** "3 files, 12.5 KB" or "4.0 KB" */
  size: string
  expiry: string
  /** Fewer than 3 days left */
  expiresSoon: boolean
}

/** Folder part of a project-relative path, as a folder label ('/' for the root; '…/x/' stays as is). */
export function parentLabel(originalPath: string): string {
  const i = originalPath.lastIndexOf('/')
  return i < 0 ? '/' : folderLabel(originalPath.slice(0, i))
}

export function trashRow(e: TrashEntry, now: number): TrashRow {
  const who = e.deletedBy ? `by ${e.deletedBy}, ` : ''
  const size = e.kind === 'folder'
    ? `${e.fileCount} file${e.fileCount === 1 ? '' : 's'}, ${formatBytes(e.size)}`
    : formatBytes(e.size)
  return {
    id: e.id,
    label: e.kind === 'folder' ? `${e.name}/` : e.name,
    from: parentLabel(e.originalPath),
    deleted: `${who}${agoText(e.deletedAt, now)}`,
    size,
    expiry: expiryText(e.expiresAt, now),
    expiresSoon: e.expiresAt - now < 3 * DAY,
  }
}

export interface RestoreTarget { id: string; label: string }

/** Live folders, root first, then by path: the choices of "Restore to…". */
export function restoreTargets(tree: readonly TreeEntry[]): RestoreTarget[] {
  const out: { id: string; path: string }[] = []
  for (const e of tree) {
    if (e.kind !== 'folder') continue
    const path = entryPath(tree, e.id)
    if (path !== null) out.push({ id: e.id, path })
  }
  out.sort((a, b) => (a.path === '' ? -1 : b.path === '' ? 1 : a.path.localeCompare(b.path)))
  return out.map(o => ({ id: o.id, label: folderLabel(o.path) }))
}

/** Toast after a restore; mentions a rename when the server had to add a "(restored)" suffix. */
export function restoredText(originalName: string, restored: Pick<TreeEntry, 'name'>, where: string): string {
  return restored.name === originalName
    ? `Restored "${restored.name}" to ${where}.`
    : `Restored "${originalName}" to ${where} as "${restored.name}" (the name was taken).`
}

/** Ids of the folders that contain `id` (to expand them so a restored item is visible). */
export function ancestorIds(tree: readonly TreeEntry[], id: string): string[] {
  const byId = new Map(tree.map(e => [e.id, e]))
  const out: string[] = []
  const seen = new Set<string>()
  let cur = byId.get(id)
  while (cur && cur.parentId !== null && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.push(cur.parentId)
    cur = byId.get(cur.parentId)
  }
  return out
}
