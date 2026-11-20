import type {
  AcceptInviteResponse, AdminAbout, AdminCreateUserRequest, AdminUpdateUserRequest, AdminUser, AuditCategory, AuditPage, BuildResult, CreatedInvite,
  CreateFileRequest, CreateInviteRequest, GcReport, ImportResponse, InstanceInfo, InstanceSettings, Invite, InvitePreview, Me,
  Member, OutputName, ProjectDetail, ProjectSummary, RestoreRequest, RestoreResponse, SignupRequest,
  SynctexEditResponse, SynctexViewResponse, TrashEntry, TreeEntry, UpdateFileRequest, UpdateProjectRequest,
  UploadResponse, RestoreVersionRequest, RestoreVersionResponse, StorageReport, VersionDetail, VersionDiff, VersionPage,
  VersionSummary,
} from '@ligature/shared'

export type { BuildResult }

/** Filters of GET /api/admin/audit (docs/M4.md §2). `since` inclusive, `until` exclusive (ms). */
export interface AuditQuery {
  before?: number
  limit?: number
  category?: AuditCategory
  actor?: string
  project?: string
  since?: number
  until?: number
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
  adminAbout: () => request<AdminAbout>('GET', '/api/admin/about'),
  adminUsers: () => request<AdminUser[]>('GET', '/api/admin/users'),
  adminCreateUser: (req: AdminCreateUserRequest) => request<AdminUser>('POST', '/api/admin/users', req),
  adminUpdateUser: (id: string, req: AdminUpdateUserRequest) => request<AdminUser>('PATCH', `/api/admin/users/${enc(id)}`, req),
  adminSettings: () => request<InstanceSettings>('GET', '/api/admin/settings'),
  adminUpdateSettings: (s: InstanceSettings) => request<InstanceSettings>('PATCH', '/api/admin/settings', s),
  adminStorage: () => request<StorageReport>('GET', '/api/admin/storage'),
  /** Runs the garbage collection now (or joins the run in progress) and returns its report. */
  adminRunGc: () => request<GcReport>('POST', '/api/admin/gc'),
  /** One page of the audit log, newest first; pass the previous page's `next` as `before` for older entries. */
  adminAudit: (q: AuditQuery = {}) => {
    const s = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v !== undefined) s.set(k, String(v))
    const qs = s.toString()
    return request<AuditPage>('GET', `/api/admin/audit${qs ? `?${qs}` : ''}`)
  },

  // projects
  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  createProject: (name: string) => request<ProjectDetail>('POST', '/api/projects', { name }),
  project: (id: string) => request<ProjectDetail>('GET', p(id)),
  updateProject: (id: string, req: UpdateProjectRequest) => request<ProjectDetail>('PATCH', p(id), req),
  deleteProject: (id: string) => request<{ ok: true }>('DELETE', p(id)),
  compile: (id: string) => request<BuildResult>('POST', `${p(id)}/compile`),
  /** The most recent finished build; 404 'no-build' when there is none. */
  latestBuild: (id: string) => request<BuildResult>('GET', `${p(id)}/builds/latest`),
  synctexView: (id: string, buildId: string, fileId: string, line: number, column?: number) =>
    request<SynctexViewResponse>('GET', `${p(id)}/builds/${enc(buildId)}/synctex/view?fileId=${enc(fileId)}&line=${line}`
      + (column !== undefined ? `&column=${column}` : '')),
  synctexEdit: (id: string, buildId: string, page: number, x: number, y: number) =>
    request<SynctexEditResponse>('GET', `${p(id)}/builds/${enc(buildId)}/synctex/edit?page=${page}&x=${x}&y=${y}`),

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

  // trash
  trash: (id: string) => request<TrashEntry[]>('GET', `${p(id)}/trash`),
  restore: (id: string, fileId: string, req: RestoreRequest = {}) =>
    request<RestoreResponse>('POST', `${p(id)}/trash/${enc(fileId)}/restore`, req),
  purge: (id: string, fileId: string) => request<{ ok: true }>('DELETE', `${p(id)}/trash/${enc(fileId)}`),
  emptyTrash: (id: string) => request<{ ok: true }>('DELETE', `${p(id)}/trash`),

  // history (M3)
  versions: (id: string, before?: string, limit?: number) => {
    const q = new URLSearchParams()
    if (before) q.set('before', before)
    if (limit !== undefined) q.set('limit', String(limit))
    const qs = q.toString()
    return request<VersionPage>('GET', `${p(id)}/versions${qs ? `?${qs}` : ''}`)
  },
  createVersion: (id: string, label: string) => request<VersionSummary>('POST', `${p(id)}/versions`, { label }),
  labelVersion: (id: string, versionId: string, label: string | null) =>
    request<VersionSummary>('PATCH', `${p(id)}/versions/${enc(versionId)}`, { label }),
  version: (id: string, versionId: string) => request<VersionDetail>('GET', `${p(id)}/versions/${enc(versionId)}`),
  /** `against`: a version id or 'current' (old side); default the previous version. */
  versionDiff: (id: string, versionId: string, against?: string) =>
    request<VersionDiff>('GET', `${p(id)}/versions/${enc(versionId)}/diff${against ? `?against=${enc(against)}` : ''}`),
  restoreVersion: (id: string, versionId: string, req: RestoreVersionRequest = {}) =>
    request<RestoreVersionResponse>('POST', `${p(id)}/versions/${enc(versionId)}/restore`, req),
}

/** A file's content in a version (`inline` only has an effect for png/jpg/gif/webp, never SVG). */
export function versionFileUrl(projectId: string, versionId: string, path: string, inline = false): string {
  return `${p(projectId)}/versions/${enc(versionId)}/file?path=${enc(path)}${inline ? '&inline=1' : ''}`
}

/** Download URL of a version as a zip. */
export function versionZipUrl(projectId: string, versionId: string): string {
  return `${p(projectId)}/versions/${enc(versionId)}/export.zip`
}

/** Fetch a text file's content (a version's file or a live raw file) as text. */
export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) {
    if (res.status === 401) onUnauthenticated()
    const data = (await res.json().catch(() => null)) as unknown
    throw toApiError(res.status, data)
  }
  return res.text()
}

/** Download URL of the project as a zip (the server sends it as an attachment). */
export function exportZipUrl(projectId: string): string {
  return `${p(projectId)}/export.zip`
}

/** URL of a file's raw bytes. `inline` only has an effect for png/jpg/gif/webp (never SVG). */
export function rawFileUrl(projectId: string, fileId: string, inline = false): string {
  return `${p(projectId)}/files/${enc(fileId)}/raw${inline ? '?inline=1' : ''}`
}

export interface UploadHandle<T> {
  promise: Promise<T>
  abort(): void
}

/** POST a raw body with XHR (rather than fetch, because XHR reports upload progress). */
function sendRaw<T>(url: string, body: Blob, contentType: string, onProgress?: (loaded: number, total: number) => void): UploadHandle<T> {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', url)
    xhr.withCredentials = true
    xhr.setRequestHeader('content-type', contentType)
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) onProgress?.(ev.loaded, ev.total) }
    xhr.onload = () => {
      let data: unknown = null
      try {
        data = JSON.parse(xhr.responseText) as unknown
      } catch {
        // non-JSON error page
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T)
      else {
        if (xhr.status === 401) onUnauthenticated()
        reject(toApiError(xhr.status, data))
      }
    }
    xhr.onerror = () => reject(new TypeError('network error'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'))
    xhr.send(body)
  })
  return { promise, abort: () => xhr.abort() }
}

/** Upload one file as the raw request body (streamed by the browser, with Content-Length). */
export function uploadFile(projectId: string, parentId: string, file: Blob, name: string,
  onProgress?: (loaded: number, total: number) => void): UploadHandle<UploadResponse> {
  return sendRaw(`${p(projectId)}/upload?parentId=${enc(parentId)}&name=${enc(name)}`, file, 'application/octet-stream', onProgress)
}

/** Import a zip as a new project owned by the caller. */
export function importZip(name: string, zip: Blob, onProgress?: (loaded: number, total: number) => void): UploadHandle<ImportResponse> {
  return sendRaw(`/api/projects/import?name=${enc(name)}`, zip, 'application/zip', onProgress)
}

export function buildFileUrl(projectId: string, buildId: string, name: OutputName): string {
  return `${p(projectId)}/builds/${enc(buildId)}/${name}`
}

/** Fetch a build's log as text (used for builds started by someone else). */
export async function fetchBuildLog(projectId: string, buildId: string): Promise<string> {
  const res = await fetch(buildFileUrl(projectId, buildId, 'output.log'), { credentials: 'same-origin' })
  if (!res.ok) throw new ApiError(res.status, `http-${res.status}`)
  return res.text()
}

/** Does this build have that output file? (HEAD is treated like GET by the server's router.) */
export async function buildHasOutput(projectId: string, buildId: string, name: OutputName): Promise<boolean> {
  const res = await fetch(buildFileUrl(projectId, buildId, name), { method: 'HEAD', credentials: 'same-origin' })
  return res.ok
}
