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

/* ------------------------------------------------------------------ trash (M2) */

/**
 * GET /api/projects/:id/trash  (member)
 * One entry per deletion: deleting a folder puts ONE entry in the trash (the folder), whose descendants
 * are restored or purged with it.
 */
export interface TrashEntry {
  /** File id of the deleted item (the folder itself for a folder deletion). */
  id: string
  name: string
  kind: FileKind
  /** Project-relative path the item had when it was deleted (e.g. "chapters/intro.tex"). */
  originalPath: string
  deletedAt: number
  /** Display name of who deleted it ('' if that account no longer exists). */
  deletedBy: string
  /** Number of files (not folders) inside, including itself if it is a file. */
  fileCount: number
  /** Total bytes of binary files + text files inside. */
  size: number
  /** Unix ms after which the entry is purged automatically. */
  expiresAt: number
}

/** POST /api/projects/:id/trash/:fileId/restore  (owner/editor) */
export interface RestoreRequest {
  /** Folder to restore into. Default: the original parent if it is still live, else the project root. */
  parentId?: string
}
/** The restored item. Its name may carry a " (restored)" / " (restored 2)" suffix if the original name is taken. */
export type RestoreResponse = TreeEntry

/* ------------------------------------------------------------------ compile results (M2) */

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

/** One problem found in the TeX/latexmk log, mapped to a project file where possible. */
export interface Diagnostic {
  severity: DiagnosticSeverity
  /** e.g. 'latex', 'package:hyperref', 'bibtex', 'badbox', 'undefined-reference', 'undefined-citation' */
  kind: string
  message: string
  /** File id in the project, when the location maps to a project file of this build. */
  fileId?: string
  /** Project-relative path as seen in the build (also set when fileId is not). */
  path?: string
  /** 1-based line. */
  line?: number
  /** For bad boxes: last line of the range ("at lines 12--15"). */
  endLine?: number
}

/** POST /api/projects/:id/compile response (also stored per build). */
export interface BuildResult {
  buildId: string
  status: CompileStatus
  durationMs: number
  log: string
  hasPdf: boolean
  /** Parsed from the log; at most 500, errors first. */
  diagnostics: Diagnostic[]
  /** Who started the build (display name). */
  startedBy: string
  /**
   * treeVersion + per-file (by file id) base64 Yjs state vectors and snapshots the build was made from,
   * so the client can tell whether the PDF is behind the editor.
   */
  snapshot: { treeVersion: number; docs: Record<string, string>; docSnapshots: Record<string, string> }
}

/** GET /api/projects/:id/builds/latest -> BuildResult of the most recent finished build, or 404 'no-build'. */

/* ------------------------------------------------------------------ SyncTeX (M2) */

/** A rectangle on a PDF page, in PDF points (1/72 in), origin at the TOP-left of the page. */
export interface PdfRect { page: number; x: number; y: number; width: number; height: number }

/** GET /api/projects/:id/builds/:buildId/synctex/view?fileId=&line=&column=  (member) — source -> PDF */
export interface SynctexViewResponse {
  /** Boxes to highlight, all on the first page that has a match (empty array if no match). */
  boxes: PdfRect[]
}

/** GET /api/projects/:id/builds/:buildId/synctex/edit?page=&x=&y=  (member) — PDF -> source; x/y as in PdfRect */
export interface SynctexEditResponse {
  fileId: string
  path: string
  /** 1-based line. */
  line: number
  /** 0-based column, or -1 when SyncTeX doesn't know it (the usual case). */
  column: number
}

/* ------------------------------------------------------------------ zip (M2) */

/** POST /api/projects/import?name=<project name>  body: raw zip bytes -> ProjectDetail of the new project */
export interface ImportReport {
  /** Entries skipped on purpose (e.g. __MACOSX/, .DS_Store, empty folders), with the reason. */
  skipped: { path: string; reason: string }[]
  /** Set when the main file was guessed (file containing \documentclass, preferring main.tex at the root). */
  detectedMainFile: string | null
}
export interface ImportResponse { project: ProjectDetail; report: ImportReport }

/** GET /api/projects/:id/export.zip  (member) -> application/zip, current live files (text from the live docs) */

/* ------------------------------------------------------------------ events */

/** Stateless messages broadcast on the project meta doc. */
export type MetaEvent =
  | { type: 'tree-changed'; treeVersion: number }
  | { type: 'project-changed' }                         // name / engine / main file changed
  | { type: 'members-changed' }
  | { type: 'compile-finished'; buildId: string; status: CompileStatus }
  | { type: 'access-revoked'; userId: string }
  | { type: 'project-deleted' }
  | { type: 'trash-changed' }                           // M2: something was deleted, restored or purged
