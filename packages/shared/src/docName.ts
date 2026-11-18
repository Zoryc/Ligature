/**
 * Yjs document names. Paths never appear in doc names, so renames/moves never touch sync state.
 * The epoch (generation) is part of the name, so a stale client cache can never merge into a rebuilt doc.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const FILE_RE = new RegExp(`^proj/(${UUID})/file/(${UUID})/g([1-9][0-9]{0,8})$`)
const META_RE = new RegExp(`^proj/(${UUID})/meta$`)

export type DocRef =
  | { kind: 'file'; projectId: string; fileId: string; epoch: number }
  | { kind: 'meta'; projectId: string }

export function fileDocName(projectId: string, fileId: string, epoch: number): string {
  return `proj/${projectId}/file/${fileId}/g${epoch}`
}

export function metaDocName(projectId: string): string {
  return `proj/${projectId}/meta`
}

export function parseDocName(name: string): DocRef | null {
  const f = FILE_RE.exec(name)
  if (f) return { kind: 'file', projectId: f[1]!, fileId: f[2]!, epoch: Number(f[3]) }
  const m = META_RE.exec(name)
  if (m) return { kind: 'meta', projectId: m[1]! }
  return null
}
