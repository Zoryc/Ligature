/**
 * Origin allow-list used for CSRF protection on the API and on the WebSocket upgrade.
 *
 * Production: exact matches from ALLOWED_ORIGINS only.
 * Development: also any `http://<sub>.localhost:<port>` / `http://localhost:<port>`, so several users can be
 * tested side by side in one browser (each subdomain gets its own cookie jar, e.g. alice.localhost, bob.localhost).
 */
const DEV_LOCALHOST = /^http:\/\/([a-z0-9-]+\.)*localhost(:[0-9]{1,5})?$/

/**
 * Parse ALLOWED_ORIGINS (comma-separated). Browsers send `Origin` as `scheme://host[:port]` with a lowercase
 * host and no default port, and originChecker compares exactly, so an entry in any other form
 * ("https://x.org/", "https://X.org", "x.org", "https://x.org/app") would refuse every request while
 * the server looks healthy. Such entries are an error naming the entry and its corrected form.
 */
export function parseAllowedOrigins(raw: string): string[] {
  const entries = raw.split(',').map(s => s.trim()).filter(Boolean)
  for (const e of entries) checkOrigin(e)
  return entries
}

function checkOrigin(entry: string): void {
  const url = tryUrl(entry)
  const isWeb = url !== null && (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  if (isWeb && url.origin === entry) return
  const fix = isWeb ? url.origin : suggestOrigin(entry)
  throw new Error(`ALLOWED_ORIGINS entry "${entry}" is not an origin (scheme://host[:port], lowercase, ` +
    `no path or trailing slash)${fix ? `; use "${fix}"` : ''}`)
}

function tryUrl(s: string): URL | null {
  try {
    return new URL(s)
  } catch {
    return null
  }
}

/** A bare "host[:port][/path]" most likely meant https://host[:port] (http:// for a local test). */
function suggestOrigin(entry: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) return null // some other scheme: no guess
  const url = tryUrl(`https://${entry}`)
  if (!url || url.hostname === '') return null
  return LOCAL_HOST.test(url.hostname) ? `http://${url.host}` : url.origin
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/

export function originChecker(exact: Iterable<string>, dev: boolean): (origin: string | null | undefined) => boolean {
  const set = new Set(exact)
  return origin => {
    if (!origin) return false
    if (set.has(origin)) return true
    return dev && DEV_LOCALHOST.test(origin)
  }
}
