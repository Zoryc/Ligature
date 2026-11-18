/** Display logic of the admin Storage section (docs/M3.md §5). Pure, so it can be unit-tested. */
import type { GcReport, StorageReport } from '@ligature/shared'

export type StorageProject = StorageReport['projects'][number]

/** Bytes for people: 1024-based, one decimal below 10 (e.g. "0 B", "512 B", "1.5 KB", "23 MB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  if (i === 0) return `${Math.round(v)} B`
  const shown = v < 10 ? Math.round(v * 10) / 10 : Math.round(v)
  // 1023.96 KB rounds to 1024 KB: show the next unit instead.
  if (shown >= 1024 && i < units.length - 1) return `1 ${units[i + 1]}`
  return `${shown} ${units[i]}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Live plus trashed bytes of a project. */
export function projectBytes(p: StorageProject): number {
  return p.liveBytes + p.trashBytes
}

export type SortKey = 'name' | 'owner' | 'liveFiles' | 'liveBytes' | 'trashBytes' | 'total' | 'versions'
export type SortDir = 'asc' | 'desc'
export interface SortState { key: SortKey; dir: SortDir }

/** Default: biggest projects first. */
export const DEFAULT_SORT: SortState = { key: 'total', dir: 'desc' }

const TEXT_KEYS: ReadonlySet<SortKey> = new Set(['name', 'owner'])

/** Clicking a column: the same column flips the direction; a new one starts A–Z for text, largest first for numbers. */
export function toggleSort(cur: SortState, key: SortKey): SortState {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: TEXT_KEYS.has(key) ? 'asc' : 'desc' }
}

function sortValue(p: StorageProject, key: SortKey): string | number {
  switch (key) {
    case 'name': return p.name
    case 'owner': return p.owner
    case 'total': return projectBytes(p)
    default: return p[key]
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** A sorted copy; ties broken by name, then id, so the order is stable between reloads. */
export function sortProjects(projects: readonly StorageProject[], s: SortState): StorageProject[] {
  const sign = s.dir === 'asc' ? 1 : -1
  return [...projects].sort((a, b) => {
    const va = sortValue(a, s.key)
    const vb = sortValue(b, s.key)
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb))
    if (c !== 0) return sign * c
    return collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

/** aria-sort value of a column header. */
export function ariaSort(s: SortState, key: SortKey): 'ascending' | 'descending' | 'none' {
  return s.key !== key ? 'none' : s.dir === 'asc' ? 'ascending' : 'descending'
}

export interface StorageTotals {
  /** Live (not deleted) projects; the file, trash and version totals below count only these. */
  projects: number
  /** Soft-deleted projects waiting to be purged, and their bytes (live + trash), shown apart. */
  deletedProjects: number
  deletedBytes: number
  liveFiles: number
  liveBytes: number
  trashBytes: number
  versions: number
}

export function storageTotals(r: StorageReport): StorageTotals {
  const t: StorageTotals = { projects: 0, deletedProjects: 0, deletedBytes: 0, liveFiles: 0, liveBytes: 0, trashBytes: 0, versions: 0 }
  for (const p of r.projects) {
    if (p.deleted) {
      t.deletedProjects++
      t.deletedBytes += projectBytes(p)
      continue
    }
    t.projects++
    t.liveFiles += p.liveFiles
    t.liveBytes += p.liveBytes
    t.trashBytes += p.trashBytes
    t.versions += p.versions
  }
  return t
}

/** "340 ms", "1.2 s", "1 min 5 s" (rounded once, so never "60 s"). */
export function formatDuration(ms: number): string {
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`
  if (ms < 59_950) return `${Math.round(ms / 100) / 10} s`
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)} min ${total % 60} s`
}

/** One line per GC result, for the "Last garbage collection" list and the toast after "Run GC now". */
export function gcLines(g: GcReport): string[] {
  return [
    `${plural(g.blobsRemoved, 'unreferenced blob')} removed (${formatBytes(g.bytesFreed)} freed)`,
    `${plural(g.orphanDocsRemoved, 'orphaned document')} removed`,
    `${plural(g.versionsThinned, 'old automatic version')} thinned`,
    `${plural(g.projectsPurged, 'deleted project')} purged`,
  ]
}

/** Short summary for a toast. */
export function gcSummary(g: GcReport): string {
  const parts: string[] = []
  if (g.blobsRemoved) parts.push(`${formatBytes(g.bytesFreed)} freed (${plural(g.blobsRemoved, 'blob')})`)
  if (g.orphanDocsRemoved) parts.push(plural(g.orphanDocsRemoved, 'orphaned document'))
  if (g.versionsThinned) parts.push(plural(g.versionsThinned, 'version') + ' thinned')
  if (g.projectsPurged) parts.push(plural(g.projectsPurged, 'project') + ' purged')
  const what = parts.length ? parts.join(', ') : 'nothing to remove'
  return `Garbage collection finished in ${formatDuration(g.durationMs)}: ${what}.`
}
