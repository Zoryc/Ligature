/**
 * Hash routes (pure; the reactive router lives in router.svelte.ts):
 *   #/login[?next=/path]   #/signup[?invite=TOKEN]   #/invite/:token
 *   #/projects   #/project/:id   #/account   #/admin   #/admin/storage   #/admin/audit
 */

export type Route =
  | { name: 'login'; next: string | null }
  | { name: 'signup'; invite: string | null }
  | { name: 'invite'; token: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'account' }
  | { name: 'admin'; tab: AdminTab }
  | { name: 'not-found' }

/** Tabs of the admin page; 'users' is the plain #/admin. */
export type AdminTab = 'users' | 'storage' | 'audit'
export const ADMIN_TABS: readonly AdminTab[] = ['users', 'storage', 'audit']

/** Routes that work without a session. */
export const PUBLIC_ROUTES: ReadonlySet<Route['name']> = new Set(['login', 'signup', 'invite'])

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/projects'
  const q = raw.indexOf('?')
  const path = q >= 0 ? raw.slice(0, q) : raw
  const params = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '')
  if (path === '/login') return { name: 'login', next: safeNext(params.get('next')) }
  if (path === '/signup') return { name: 'signup', invite: params.get('invite') || null }
  if (path === '/projects' || path === '/') return { name: 'projects' }
  if (path === '/account') return { name: 'account' }
  if (path === '/admin') return { name: 'admin', tab: 'users' }
  if (path === '/admin/storage') return { name: 'admin', tab: 'storage' }
  if (path === '/admin/audit') return { name: 'admin', tab: 'audit' }
  const project = /^\/project\/([^/]+)$/.exec(path)
  if (project) {
    const id = decode(project[1]!)
    return id ? { name: 'project', id } : { name: 'not-found' }
  }
  const invite = /^\/invite\/([^/]+)$/.exec(path)
  if (invite) {
    const token = decode(invite[1]!)
    return token ? { name: 'invite', token } : { name: 'not-found' }
  }
  return { name: 'not-found' }
}

/**
 * Where to go after logging in. Only in-app hash paths are accepted ('/projects', '/invite/x', ...),
 * never URLs or protocol-relative paths, and never the auth pages themselves (no loops).
 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null
  const r = parseHash(`#${next}`)
  if (r.name === 'not-found' || r.name === 'login' || r.name === 'signup') return null
  return next
}

/** Current route as a path for ?next= (e.g. '/project/abc'). */
export function routePath(r: Route): string {
  switch (r.name) {
    case 'login': return '/login'
    case 'signup': return '/signup'
    case 'invite': return `/invite/${encodeURIComponent(r.token)}`
    case 'projects': return '/projects'
    case 'project': return `/project/${encodeURIComponent(r.id)}`
    case 'account': return '/account'
    case 'admin': return adminPath(r.tab)
    case 'not-found': return '/projects'
  }
}

export function adminPath(tab: AdminTab): string {
  return tab === 'users' ? '/admin' : `/admin/${tab}`
}

export function loginPath(next: string | null): string {
  const n = safeNext(next)
  return n && n !== '/projects' ? `/login?next=${encodeURIComponent(n)}` : '/login'
}

export function signupPath(invite: string | null): string {
  return invite ? `/signup?invite=${encodeURIComponent(invite)}` : '/signup'
}

/** The shareable link for an invite token. */
export function inviteUrl(origin: string, token: string): string {
  return `${origin}/#/invite/${encodeURIComponent(token)}`
}
