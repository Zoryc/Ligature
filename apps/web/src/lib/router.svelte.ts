/** Minimal reactive hash router; parsing lives in routes.ts. */
import { parseHash, type Route } from './routes.ts'

export type { Route }

export const router = $state<{ route: Route }>({ route: parseHash(location.hash) })

window.addEventListener('hashchange', () => {
  router.route = parseHash(location.hash)
})

export function go(path: string): void {
  location.hash = path
}

/**
 * go(), with the route changed right away instead of on the later hashchange event. Needed when the same step
 * also changes the session: App's "needs login" effect runs before hashchange and would otherwise still see
 * the old route (and send you to the login page with ?next= pointing back at it).
 */
export function goNow(path: string): void {
  go(path)
  router.route = parseHash(`#${path}`)
}
