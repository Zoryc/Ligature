/**
 * Pure helpers for file tree operations on the flat `ProjectDetail.tree`
 * (paths, name checks, move targets, drop targets, upload planning).
 * The server enforces all of this too; these give early, friendly feedback.
 */
import { isValidName, isValidRelPath, MAX_DEPTH, MAX_PATH_LEN, type TreeEntry } from '@ligature/shared'

export type Tree = readonly TreeEntry[]

function byId(tree: Tree): Map<string, TreeEntry> {
  return new Map(tree.map(e => [e.id, e]))
}

/** Path relative to the root ('' for the root itself), or null if the id is unknown or the chain is broken. */
export function entryPath(tree: Tree, id: string): string | null {
  const map = byId(tree)
  const parts: string[] = []
  const seen = new Set<string>()
  let cur = map.get(id)
  while (cur) {
    if (seen.has(cur.id)) return null // defensive: cycle
    seen.add(cur.id)
    if (cur.parentId === null) return parts.reverse().join('/')
    parts.push(cur.name)
    cur = map.get(cur.parentId)
  }
  return null
}

/** Display form of a folder path: '/' for the root, 'a/b/' otherwise. */
export function folderLabel(path: string): string {
  return path === '' ? '/' : `${path}/`
}

/** Live child of `parentId` whose name matches case-insensitively (the server's uniqueness rule). */
export function childNamed(tree: Tree, parentId: string, name: string, exceptId?: string): TreeEntry | undefined {
  const lower = name.toLowerCase()
  return tree.find(e => e.parentId === parentId && e.id !== exceptId && e.name.toLowerCase() === lower)
}

/** Is `id` the same as, or inside, `ancestorId`? */
export function isSameOrInside(tree: Tree, id: string, ancestorId: string): boolean {
  const map = byId(tree)
  const seen = new Set<string>()
  let cur = map.get(id)
  while (cur && !seen.has(cur.id)) {
    if (cur.id === ancestorId) return true
    seen.add(cur.id)
    cur = cur.parentId === null ? undefined : map.get(cur.parentId)
  }
  return false
}

/**
 * Why `name` cannot be used for a new or renamed entry in `parentId`, or null if it is fine.
 * `selfId` is the entry being renamed/moved (excluded from the duplicate check; its subtree depth counts).
 */
export function nameProblem(tree: Tree, parentId: string, name: string, selfId?: string): string | null {
  if (name.trim() === '') return 'Enter a name.'
  if (name !== name.trim()) return 'Names cannot start or end with spaces.'
  if (!isValidName(name)) return 'Names cannot contain / \\ : * ? " < > | or control characters, and cannot be "." or "..".'
  if (childNamed(tree, parentId, name, selfId)) return `"${name}" already exists in this folder.`
  const parentPath = entryPath(tree, parentId)
  if (parentPath === null) return 'The folder no longer exists.'
  const path = parentPath === '' ? name : `${parentPath}/${name}`
  const deepest = selfId ? deepestSuffix(tree, selfId) : { depth: 0, length: 0 }
  if (path.length + deepest.length > MAX_PATH_LEN || path.split('/').length + deepest.depth > MAX_DEPTH || !isValidRelPath(path)) {
    return 'The path would be too long or too deeply nested.'
  }
  return null
}

/** Longest '/child/grandchild...' suffix below a node (for path-length checks on folder moves). */
function deepestSuffix(tree: Tree, id: string): { depth: number; length: number } {
  const best = { depth: 0, length: 0 }
  const walk = (parentId: string, depth: number, length: number) => {
    if (depth > MAX_DEPTH + 1) return // defensive: never loop on a malformed tree
    for (const c of tree) {
      if (c.parentId !== parentId) continue
      const d = depth + 1
      const l = length + 1 + c.name.length
      best.depth = Math.max(best.depth, d)
      best.length = Math.max(best.length, l)
      if (c.kind === 'folder') walk(c.id, d, l)
    }
  }
  walk(id, 0, 0)
  return best
}

export interface FolderOption { id: string; path: string; label: string; disabled: boolean; reason?: string }

/**
 * Folders `id` could be moved into, sorted by path. The node itself and its descendants are disabled
 * (cycle), as is its current parent (no-op) and any folder that already has a child of the same name.
 */
export function moveTargets(tree: Tree, id: string): FolderOption[] {
  const node = tree.find(e => e.id === id)
  if (!node) return []
  const out: FolderOption[] = []
  for (const f of tree) {
    if (f.kind !== 'folder') continue
    const path = entryPath(tree, f.id)
    if (path === null) continue
    let reason: string | undefined
    if (isSameOrInside(tree, f.id, id)) reason = 'inside the item itself'
    else if (f.id === node.parentId) reason = 'current folder'
    else if (childNamed(tree, f.id, node.name, node.id)) reason = 'name already used there'
    out.push({ id: f.id, path, label: folderLabel(path), disabled: reason !== undefined, ...(reason ? { reason } : {}) })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * The folder new files go into: the selected folder, the parent of the selected file, or the root.
 * Also used for drag-and-drop: dropping onto a file means "into the file's folder".
 */
export function targetFolder(tree: Tree, rootId: string, targetId: string | null | undefined): string {
  if (!targetId) return rootId
  const e = tree.find(x => x.id === targetId)
  if (!e) return rootId
  if (e.kind === 'folder') return e.id
  return e.parentId && tree.some(x => x.id === e.parentId && x.kind === 'folder') ? e.parentId : rootId
}

/** Image types the browser may show inline (the server serves these inline with ?inline=1). Never SVG. */
const INLINE_IMAGE = /\.(png|jpe?g|gif|webp)$/i

export function isInlineImage(name: string): boolean {
  return INLINE_IMAGE.test(name)
}

/** Text files that can be the main file (the server requires a `.tex` text file). */
export function mainFileCandidates(tree: Tree): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = []
  for (const e of tree) {
    if (e.kind !== 'text' || !e.name.toLowerCase().endsWith('.tex')) continue
    const path = entryPath(tree, e.id)
    if (path !== null) out.push({ id: e.id, path })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export type UploadPlanItem =
  | { name: string; action: 'create' }
  | { name: string; action: 'replace'; existing: TreeEntry }
  | { name: string; action: 'skip'; reason: string }

/** Decide, per dropped/selected file, whether it is new, replaces an existing file, or cannot be uploaded. */
export function planUploads(tree: Tree, folderId: string, files: readonly { name: string; size: number }[], maxBytes: number): UploadPlanItem[] {
  const seen = new Set<string>()
  return files.map((f): UploadPlanItem => {
    const name = f.name
    if (!isValidName(name)) return { name, action: 'skip', reason: 'invalid file name' }
    if (seen.has(name.toLowerCase())) return { name, action: 'skip', reason: 'selected twice' }
    seen.add(name.toLowerCase())
    if (f.size > maxBytes) return { name, action: 'skip', reason: `larger than ${Math.round(maxBytes / 1048576)} MB` }
    const existing = childNamed(tree, folderId, name)
    if (!existing) {
      const parent = entryPath(tree, folderId)
      if (parent === null) return { name, action: 'skip', reason: 'the folder no longer exists' }
      if (!isValidRelPath(parent === '' ? name : `${parent}/${name}`)) return { name, action: 'skip', reason: 'path too long' }
      return { name, action: 'create' }
    }
    if (existing.kind === 'folder') return { name, action: 'skip', reason: 'a folder with that name exists' }
    if (existing.name !== name) return { name, action: 'skip', reason: `"${existing.name}" exists (names are not case-sensitive)` }
    return { name, action: 'replace', existing }
  })
}

/** What happened to the open file after the tree was refetched. */
export type OpenFileOutcome = 'keep' | 'deleted' | 'reopen'

export function openFileOutcome(tree: Tree, fileId: string, epoch: number): OpenFileOutcome {
  const e = tree.find(x => x.id === fileId)
  if (!e || e.kind !== 'text') return 'deleted'
  return e.epoch === epoch ? 'keep' : 'reopen'
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}
