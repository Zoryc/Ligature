import type { Role } from './roles.ts'
import type { CompileStatus } from './compile.ts'

export interface Me { id: string; username: string; displayName: string }

export interface ProjectSummary { id: string; name: string; role: Role }

export type FileKind = 'folder' | 'text' | 'binary'

export interface TreeEntry {
  id: string
  parentId: string | null
  name: string
  kind: FileKind
  /** Only for text files: current doc epoch, used in the Yjs doc name. */
  epoch?: number
}

export interface ProjectDetail {
  id: string
  name: string
  role: Role
  rootId: string
  mainFileId: string | null
  treeVersion: number
  tree: TreeEntry[]
}

/** Stateless messages broadcast on the project meta doc. */
export type MetaEvent =
  | { type: 'tree-changed'; treeVersion: number }
  | { type: 'compile-finished'; buildId: string; status: CompileStatus }
  | { type: 'access-revoked'; userId: string }
