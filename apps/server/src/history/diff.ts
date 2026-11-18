import type { FileChange, VersionDiff, VersionFile } from '@ligature/shared'

/*
 * Comparing two file lists (docs/M3.md §2): files are matched by file id first (so a moved or renamed
 * file is `renamed`, possibly also modified), then, among the files left over, by path (a file that was
 * deleted and re-created at the same place is `modified` or `unchanged`). Pure.
 */

export type DiffEntry = VersionDiff['files'][number]

type Side = Pick<VersionFile, 'path' | 'fileId' | 'kind' | 'hash'>

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function diffFiles(oldFiles: readonly Side[], newFiles: readonly Side[]): DiffEntry[] {
  const oldById = new Map(oldFiles.map(f => [f.fileId, f]))
  const matched = new Map<Side, Side>() // new -> old
  const usedOld = new Set<Side>()
  for (const n of newFiles) {
    const o = oldById.get(n.fileId)
    if (o && !usedOld.has(o)) { matched.set(n, o); usedOld.add(o) }
  }
  const oldByPath = new Map(oldFiles.filter(f => !usedOld.has(f)).map(f => [f.path, f]))
  for (const n of newFiles) {
    if (matched.has(n)) continue
    const o = oldByPath.get(n.path)
    if (o && !usedOld.has(o)) { matched.set(n, o); usedOld.add(o) }
  }

  const out: DiffEntry[] = []
  for (const n of newFiles) {
    const o = matched.get(n)
    if (!o) {
      out.push({ change: 'added', path: n.path, oldPath: '', kind: n.kind, oldHash: null, newHash: n.hash, modified: false })
      continue
    }
    const contentChanged = o.hash !== n.hash || o.kind !== n.kind
    const change: FileChange = o.path !== n.path ? 'renamed' : contentChanged ? 'modified' : 'unchanged'
    out.push({ change, path: n.path, oldPath: o.path, kind: n.kind, oldHash: o.hash, newHash: n.hash, modified: contentChanged })
  }
  for (const o of oldFiles) {
    if (usedOld.has(o)) continue
    out.push({ change: 'removed', path: '', oldPath: o.path, kind: o.kind, oldHash: o.hash, newHash: null, modified: false })
  }
  return out.sort((a, b) => cmp(a.path || a.oldPath, b.path || b.oldPath) || cmp(a.change, b.change))
}

/** VersionSummary.changes: renamed files count as modified (their path changed). */
export function changeCounts(oldFiles: readonly Side[], newFiles: readonly Side[]): { added: number; removed: number; modified: number } {
  const c = { added: 0, removed: 0, modified: 0 }
  for (const e of diffFiles(oldFiles, newFiles)) {
    if (e.change === 'added') c.added++
    else if (e.change === 'removed') c.removed++
    else if (e.change === 'modified' || e.change === 'renamed') c.modified++
  }
  return c
}
