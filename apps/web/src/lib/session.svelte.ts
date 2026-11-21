import type { InstanceInfo, Me, SignupRequest } from '@ligature/shared'
import { api, ApiError, setUnauthenticatedHandler } from './api.ts'
import { go, goNow, router } from './router.svelte.ts'
import { loginPath, PUBLIC_ROUTES, routePath } from './routes.ts'

export const session = $state<{ me: Me | null; instance: InstanceInfo | null; checked: boolean }>({
  me: null, instance: null, checked: false,
})

/** Drop the session and show the login page, coming back to the current page afterwards. */
export function sessionLost(): void {
  session.me = null
  const r = router.route
  if (!PUBLIC_ROUTES.has(r.name)) go(loginPath(routePath(r)))
}

setUnauthenticatedHandler(sessionLost)

export async function loadInstance(): Promise<void> {
  try {
    session.instance = await api.instance()
  } catch (e) {
    console.error('GET /api/instance failed', e)
  }
}

export async function loadMe(): Promise<void> {
  try {
    session.me = await api.me()
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) console.error('GET /api/me failed', e)
    session.me = null
  } finally {
    session.checked = true
  }
}

export async function login(username: string, password: string): Promise<void> {
  session.me = await api.login(username, password)
}

export async function signup(req: SignupRequest): Promise<void> {
  session.me = await api.signup(req)
  void loadInstance() // hasUsers is now true
}

export async function devLogin(username: string): Promise<void> {
  await api.devLogin(username)
  await loadMe()
}

/**
 * Show the plain login page (no ?next=) and drop the session. The route changes first, in the same step:
 * otherwise App's effect would still see the private page and redirect to /login?next=<that page>.
 */
function toLogin(): void {
  goNow('/login')
  session.me = null
}

/**
 * After deleting your own account: the server already ended the session and cleared its cookie, so only
 * the page state goes. No ?next=: the pages you could come back to went with the account.
 */
export function accountDeleted(): void {
  toLogin()
}

export async function logout(): Promise<void> {
  try {
    await api.logout()
  } catch {
    // already logged out
  }
  toLogin()
}
