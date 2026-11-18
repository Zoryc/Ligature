import type { Role } from './roles.ts'
import type { CompileStatus, Engine } from './compile.ts'

/* ------------------------------------------------------------------ accounts */

export type RegistrationMode = 'open' | 'invite-only' | 'closed'

export interface Me {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
}

/** GET /api/instance (public) */
export interface InstanceInfo {
  registration: RegistrationMode
  /** false until the first account exists; the first signup becomes instance admin. */
  hasUsers: boolean
  /** true only in development builds (enables /api/dev/login). */
  devLogin: boolean
}

/** POST /api/auth/signup */
export interface SignupRequest {
  username: string
  displayName: string
  password: string
  /** Required when registration is 'invite-only' (unless this is the very first account). */
  inviteToken?: string
}
/** POST /api/auth/login */
export interface LoginRequest { username: string; password: string }
/** PATCH /api/me */
export interface UpdateMeRequest { displayName: string }
/** POST /api/me/password */
export interface ChangePasswordRequest { currentPassword: string; newPassword: string }

/** Admin: GET /api/admin/users */
export interface AdminUser {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
  disabled: boolean
  createdAt: number
}
/** Admin: POST /api/admin/users */
export interface AdminCreateUserRequest { username: string; displayName: string; password: string; isAdmin?: boolean }
/** Admin: PATCH /api/admin/users/:id */
export interface AdminUpdateUserRequest { displayName?: string; isAdmin?: boolean; disabled?: boolean; password?: string }
/** Admin: GET/PATCH /api/admin/settings */
export interface InstanceSettings { registration: RegistrationMode }

/* ------------------------------------------------------------------ projects */

export interface ProjectSummary {
  id: string
  name: string
  role: Role
  ownerName: string
  updatedAt: number
}

export type FileKind = 'folder' | 'text' | 'binary'

export interface TreeEntry {
  id: string
  parentId: string | null
  name: string
  kind: FileKind
  /** Only for text files: current doc epoch, used in the Yjs doc name. */
  epoch?: number
  /** Only for binary files: byte size. */
  size?: number
}

export interface ProjectDetail {
  id: string
  name: string
  role: Role
  rootId: string
  mainFileId: string | null
  engine: Engine
  treeVersion: number
  tree: TreeEntry[]
}

/** POST /api/projects */
export interface CreateProjectRequest { name: string }
/** PATCH /api/projects/:id  (name: owner; engine/mainFileId: owner or editor) */
export interface UpdateProjectRequest { name?: string; engine?: Engine; mainFileId?: string }

export interface Member { userId: string; username: string; displayName: string; role: Role }
/** PATCH /api/projects/:id/members/:userId  (owner only; 'owner' is not assignable here, use transfer) */
export interface UpdateMemberRequest { role: Exclude<Role, 'owner'> }
/** POST /api/projects/:id/transfer  (owner only; the previous owner becomes editor) */
export interface TransferOwnershipRequest { userId: string }

export interface Invite {
  id: string
  role: Exclude<Role, 'owner'>
  createdBy: string
  createdAt: number
  expiresAt: number
  maxUses: number | null
  uses: number
}
/** POST /api/projects/:id/invites  (owner only) */
export interface CreateInviteRequest { role: Exclude<Role, 'owner'>; expiresInHours?: number; maxUses?: number | null }
/** Response of POST /api/projects/:id/invites. The token is shown once; only its hash is stored. */
export interface CreatedInvite extends Invite { token: string }
/** GET /api/invites/:token  (public preview) */
export interface InvitePreview { projectName: string; role: Exclude<Role, 'owner'>; invitedBy: string; expiresAt: number }
/** POST /api/invites/:token/accept  (logged in) */
export interface AcceptInviteResponse { projectId: string }

/* ------------------------------------------------------------------ files */

/** POST /api/projects/:id/files  (owner/editor) */
export interface CreateFileRequest {
  parentId: string
  name: string
  kind: 'folder' | 'text'
  /** Initial content for text files (server seeds the Yjs doc). */
  content?: string
}
/** PATCH /api/projects/:id/files/:fileId  (owner/editor) — rename and/or move */
export interface UpdateFileRequest { name?: string; parentId?: string }

/**
 * POST /api/projects/:id/upload?parentId=<uuid>&name=<name>   body: raw bytes (application/octet-stream)
 * If a live file with that name exists in that folder it is replaced:
 *  - text  -> text : applied as a minimal diff to the live Yjs doc (collaborators see an ordinary edit)
 *  - binary-> binary: new blob
 *  - kind change   : 409 'kind-mismatch'
 * Returns the resulting TreeEntry.
 */
export type UploadResponse = TreeEntry

/* ------------------------------------------------------------------ events */

/** Stateless messages broadcast on the project meta doc. */
export type MetaEvent =
  | { type: 'tree-changed'; treeVersion: number }
  | { type: 'project-changed' }                         // name / engine / main file changed
  | { type: 'members-changed' }
  | { type: 'compile-finished'; buildId: string; status: CompileStatus }
  | { type: 'access-revoked'; userId: string }
  | { type: 'project-deleted' }
