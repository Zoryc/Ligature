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
