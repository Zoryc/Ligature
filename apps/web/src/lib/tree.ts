import type { TreeEntry } from '@ligature/shared'

export interface TreeRow { entry: TreeEntry; depth: number; path: string }

function sortEntries(a: TreeEntry, b: TreeEntry): number {
  if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name)
}

/** Turn the flat tree into display rows (depth-first, folders first). The root row itself is not shown. */
export function treeRows(tree: TreeEntry[], rootId: string): TreeRow[] {
  const children = new Map<string, TreeEntry[]>()
  for (const e of tree) {
    if (e.parentId === null) continue
    const list = children.get(e.parentId) ?? []
    list.push(e)
    children.set(e.parentId, list)
  }
  const rows: TreeRow[] = []
  const seen = new Set<string>()
  const walk = (parentId: string, depth: number, prefix: string) => {
    const list = (children.get(parentId) ?? []).slice().sort(sortEntries)
    for (const e of list) {
      if (seen.has(e.id)) continue // defensive: never loop on a malformed tree
      seen.add(e.id)
      const path = prefix ? `${prefix}/${e.name}` : e.name
      rows.push({ entry: e, depth, path })
      if (e.kind === 'folder') walk(e.id, depth + 1, path)
    }
  }
  walk(rootId, 0, '')
  return rows
}

/** path ('chapters/intro.tex') -> text file entry */
export function textFilesByPath(rows: TreeRow[]): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>()
  for (const r of rows) if (r.entry.kind === 'text') map.set(r.path, r.entry)
  return map
}
