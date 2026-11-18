import type {
  AcceptInviteResponse, AdminCreateUserRequest, AdminUpdateUserRequest, AdminUser, CompileStatus, CreatedInvite,
  CreateFileRequest, CreateInviteRequest, InstanceInfo, InstanceSettings, Invite, InvitePreview, Me, Member,
  ProjectDetail, ProjectSummary, SignupRequest, TreeEntry, UpdateFileRequest, UpdateProjectRequest, UploadResponse,
} from '@ligature/shared'

/** Mirror of the server's BuildResult (apps/server/src/compile/orchestrator.ts). */
export interface BuildResult {
  buildId: string
  status: CompileStatus
  durationMs: number
  log: string
  hasPdf: boolean
  /**
   * treeVersion + per-file (by file id) base64 Yjs state vectors the build was made from.
   * docSnapshots (optional; base64 Y.encodeSnapshot, i.e. state vector + delete set) lets the client
   * also notice deletion-only edits; see behind.ts. Older servers do not send it.
   */
  snapshot: { treeVersion: number; docs: Record<string, string>; docSnapshots?: Record<string, string> }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

/** Called on a 401 from an authenticated route, so the app can drop back to the login page. */
let onUnauthenticated: () => void = () => {}
export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn
}

interface RequestOptions {
  /** false for login/signup/me probes: a 401 there is an answer, not an expired session. */
  redirectOn401?: boolean
}

function toApiError(status: number, data: unknown): ApiError {
  const err = data as { error?: unknown; message?: unknown } | null
  const code = typeof err?.error === 'string' ? err.error : `http-${status}`
  return new ApiError(status, code, typeof err?.message === 'string' ? err.message : undefined)
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(path, init)
  const data = (await res.json().catch(() => null)) as unknown
  if (!res.ok) {
    if (res.status === 401 && opts.redirectOn401 !== false) onUnauthenticated()
    throw toApiError(res.status, data)
  }
  return data as T
}

const enc = encodeURIComponent
const p = (id: string) => `/api/projects/${enc(id)}`

export const api = {
  // accounts
  instance: () => request<InstanceInfo>('GET', '/api/instance'),
  me: () => request<Me>('GET', '/api/me', undefined, { redirectOn401: false }),
  login: (username: string, password: string) =>
    request<Me>('POST', '/api/auth/login', { username, password }, { redirectOn401: false }),
  signup: (req: SignupRequest) => request<Me>('POST', '/api/auth/signup', req, { redirectOn401: false }),
  devLogin: (username: string) => request<{ ok: true }>('POST', '/api/dev/login', { username }, { redirectOn401: false }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', undefined, { redirectOn401: false }),
  updateMe: (displayName: string) => request<Me>('PATCH', '/api/me', { displayName }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/me/password', { currentPassword, newPassword }),

  // admin
  adminUsers: () => request<AdminUser[]>('GET', '/api/admin/users'),
  adminCreateUser: (req: AdminCreateUserRequest) => request<AdminUser>('POST', '/api/admin/users', req),
  adminUpdateUser: (id: string, req: AdminUpdateUserRequest) => request<AdminUser>('PATCH', `/api/admin/users/${enc(id)}`, req),
  adminSettings: () => request<InstanceSettings>('GET', '/api/admin/settings'),
  adminUpdateSettings: (s: InstanceSettings) => request<InstanceSettings>('PATCH', '/api/admin/settings', s),

  // projects
  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  createProject: (name: string) => request<ProjectDetail>('POST', '/api/projects', { name }),
  project: (id: string) => request<ProjectDetail>('GET', p(id)),
  updateProject: (id: string, req: UpdateProjectRequest) => request<ProjectDetail>('PATCH', p(id), req),
  deleteProject: (id: string) => request<{ ok: true }>('DELETE', p(id)),
  compile: (id: string) => request<BuildResult>('POST', `${p(id)}/compile`),

  // members + invites
  members: (id: string) => request<Member[]>('GET', `${p(id)}/members`),
  setMemberRole: (id: string, userId: string, role: 'editor' | 'viewer') =>
    request<Member[]>('PATCH', `${p(id)}/members/${enc(userId)}`, { role }),
  removeMember: (id: string, userId: string) => request<{ ok: true }>('DELETE', `${p(id)}/members/${enc(userId)}`),
  transfer: (id: string, userId: string) => request<Member[]>('POST', `${p(id)}/transfer`, { userId }),
  invites: (id: string) => request<Invite[]>('GET', `${p(id)}/invites`),
  createInvite: (id: string, req: CreateInviteRequest) => request<CreatedInvite>('POST', `${p(id)}/invites`, req),
  revokeInvite: (id: string, inviteId: string) => request<{ ok: true }>('DELETE', `${p(id)}/invites/${enc(inviteId)}`),
  previewInvite: (token: string) => request<InvitePreview>('GET', `/api/invites/${enc(token)}`, undefined, { redirectOn401: false }),
  acceptInvite: (token: string) => request<AcceptInviteResponse>('POST', `/api/invites/${enc(token)}/accept`),

  // files
  createFile: (id: string, req: CreateFileRequest) => request<TreeEntry>('POST', `${p(id)}/files`, req),
  updateFile: (id: string, fileId: string, req: UpdateFileRequest) => request<TreeEntry>('PATCH', `${p(id)}/files/${enc(fileId)}`, req),
  deleteFile: (id: string, fileId: string) => request<{ ok: true }>('DELETE', `${p(id)}/files/${enc(fileId)}`),
}

/** URL of a file's raw bytes. `inline` only has an effect for png/jpg/gif/webp (never SVG). */
export function rawFileUrl(projectId: string, fileId: string, inline = false): string {
  return `${p(projectId)}/files/${enc(fileId)}/raw${inline ? '?inline=1' : ''}`
}

export interface UploadHandle {
  promise: Promise<UploadResponse>
  abort(): void
}

/**
 * Upload one file as the raw request body (streamed by the browser, with Content-Length).
 * XHR rather than fetch because it reports upload progress.
 */
export function uploadFile(projectId: string, parentId: string, file: Blob, name: string,
  onProgress?: (loaded: number, total: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<UploadResponse>((resolve, reject) => {
    xhr.open('POST', `${p(projectId)}/upload?parentId=${enc(parentId)}&name=${enc(name)}`)
    xhr.withCredentials = true
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) onProgress?.(ev.loaded, ev.total) }
    xhr.onload = () => {
      let data: unknown = null
      try {
        data = JSON.parse(xhr.responseText) as unknown
      } catch {
        // non-JSON error page
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as UploadResponse)
      else {
        if (xhr.status === 401) onUnauthenticated()
        reject(toApiError(xhr.status, data))
      }
    }
    xhr.onerror = () => reject(new TypeError('network error'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'))
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}

export function buildFileUrl(projectId: string, buildId: string, name: 'output.pdf' | 'output.log'): string {
  return `${p(projectId)}/builds/${enc(buildId)}/${name}`
}

/** Fetch a build's log as text (used for builds started by someone else). */
export async function fetchBuildLog(projectId: string, buildId: string): Promise<string> {
  const res = await fetch(buildFileUrl(projectId, buildId, 'output.log'), { credentials: 'same-origin' })
  if (!res.ok) throw new ApiError(res.status, `http-${res.status}`)
  return res.text()
}

/** Does this build have a PDF? (HEAD is treated like GET by the server's router.) */
export async function buildHasPdf(projectId: string, buildId: string): Promise<boolean> {
  const res = await fetch(buildFileUrl(projectId, buildId, 'output.pdf'), { method: 'HEAD', credentials: 'same-origin' })
  return res.ok
}
