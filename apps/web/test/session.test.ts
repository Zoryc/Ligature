import { beforeAll, describe, expect, it, vi } from 'vitest'

// The router reads location.hash and listens for hashchange when it loads: give it a minimal browser.
// hashchange is not fired by assigning the hash here, like in a browser where it only comes later as its own
// task — after Svelte's effects (App's "needs login" redirect) have already run.
const listeners: (() => void)[] = []
const fakeLocation = { hash: '#/account' }
vi.stubGlobal('location', fakeLocation)
vi.stubGlobal('window', { addEventListener: (_: string, fn: () => void) => listeners.push(fn) })
vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))

let router: typeof import('../src/lib/router.svelte.ts').router
let session: typeof import('../src/lib/session.svelte.ts')
let routes: typeof import('../src/lib/routes.ts')

beforeAll(async () => {
  router = (await import('../src/lib/router.svelte.ts')).router
  session = await import('../src/lib/session.svelte.ts')
  routes = await import('../src/lib/routes.ts')
})

/** What App.svelte's effect would do now: null, or where it redirects. */
function appRedirect(): string | null {
  const s = session.session
  const needsLogin = s.checked && !s.me && !routes.PUBLIC_ROUTES.has(router.route.name)
  return needsLogin ? routes.loginPath(routes.routePath(router.route)) : null
}

function signedInOn(hash: string): void {
  fakeLocation.hash = hash
  router.route = routes.parseHash(hash)
  session.session.me = { id: 'u1', username: 'alice', displayName: 'Alice', isAdmin: false }
  session.session.checked = true
}

describe('leaving for the login page', () => {
  it('after deleting your account: the route is the plain login page at once, so App adds no ?next=', () => {
    signedInOn('#/account')
    session.accountDeleted()
    expect(session.session.me).toBeNull()
    expect(router.route).toEqual({ name: 'login', next: null })
    expect(appRedirect()).toBeNull()
    expect(fakeLocation.hash).toBe('/login')
    // The hashchange that follows reads the same plain hash.
    for (const fn of listeners) fn()
    expect(router.route).toEqual({ name: 'login', next: null })
  })

  it('logging out too (even when the server cannot be reached)', async () => {
    signedInOn('#/project/p-1')
    await session.logout()
    expect(session.session.me).toBeNull()
    expect(router.route).toEqual({ name: 'login', next: null })
    expect(appRedirect()).toBeNull()
  })

  it('a lost session still comes back to the page afterwards', () => {
    signedInOn('#/project/p-1')
    session.sessionLost()
    expect(fakeLocation.hash).toBe('/login?next=%2Fproject%2Fp-1')
  })
})
