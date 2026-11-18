/** Minimal hash router: #/login, #/projects, #/project/:id */

export type Route =
  | { name: 'login' }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'not-found' }

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/projects'
  if (path === '/login') return { name: 'login' }
  if (path === '/projects' || path === '/') return { name: 'projects' }
  const m = /^\/project\/([^/]+)$/.exec(path)
  if (m) return { name: 'project', id: decodeURIComponent(m[1]!) }
  return { name: 'not-found' }
}

export const router = $state<{ route: Route }>({ route: parseHash(location.hash) })

window.addEventListener('hashchange', () => {
  router.route = parseHash(location.hash)
})

export function go(path: string): void {
  location.hash = path
}
