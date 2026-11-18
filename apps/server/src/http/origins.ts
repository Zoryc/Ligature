/**
 * Origin allow-list used for CSRF protection on the API and on the WebSocket upgrade.
 *
 * Production: exact matches from ALLOWED_ORIGINS only.
 * Development: also any `http://<sub>.localhost:<port>` / `http://localhost:<port>`, so several users can be
 * tested side by side in one browser (each subdomain gets its own cookie jar, e.g. alice.localhost, bob.localhost).
 */
const DEV_LOCALHOST = /^http:\/\/([a-z0-9-]+\.)*localhost(:[0-9]{1,5})?$/

export function originChecker(exact: Iterable<string>, dev: boolean): (origin: string | null | undefined) => boolean {
  const set = new Set(exact)
  return origin => {
    if (!origin) return false
    if (set.has(origin)) return true
    return dev && DEV_LOCALHOST.test(origin)
  }
}
