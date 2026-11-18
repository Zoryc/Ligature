import type { CompileStatus, Me, ProjectDetail, ProjectSummary } from '@ligature/shared'

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

/** Called on any 401, so the app can drop back to the login page. */
let onUnauthenticated: () => void = () => {}
export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(path, init)
  const data = (await res.json().catch(() => null)) as unknown
  if (!res.ok) {
    const err = data as { error?: string; message?: string } | null
    if (res.status === 401) onUnauthenticated()
    throw new ApiError(res.status, err?.error ?? `http-${res.status}`, err?.message)
  }
  return data as T
}

export const api = {
  devLogin: (username: string) => request<{ ok: true }>('POST', '/api/dev/login', { username }),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),
  me: () => request<Me>('GET', '/api/me'),
  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  project: (id: string) => request<ProjectDetail>('GET', `/api/projects/${encodeURIComponent(id)}`),
  compile: (id: string) => request<BuildResult>('POST', `/api/projects/${encodeURIComponent(id)}/compile`),
}

export function buildFileUrl(projectId: string, buildId: string, name: 'output.pdf' | 'output.log'): string {
  return `/api/projects/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(buildId)}/${name}`
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
