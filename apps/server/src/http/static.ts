import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { MiddlewareHandler } from 'hono'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
}

/**
 * CSP for the app shell. CodeMirror injects <style> elements (style-src 'unsafe-inline');
 * PDF.js runs in a worker and renders to canvas from blob: URLs; images come from our API.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** Hashed build output (Vite: `assets/name-<hash>.ext`) may be cached forever. */
const isHashedAsset = (rel: string) => rel.startsWith('assets/')

/**
 * Serve the built SPA for every GET/HEAD that is not /api or /collab. Unknown paths fall back to
 * index.html (client-side routing), except under /assets/ where a miss is a real 404.
 */
export function serveSpa(distDir: string): MiddlewareHandler {
  const root = resolve(distDir)
  const indexFile = join(root, 'index.html')
  return async (c, next) => {
    const method = c.req.method
    const path = c.req.path
    if ((method !== 'GET' && method !== 'HEAD') || path === '/api' || path.startsWith('/api/') || path === '/collab') return next()

    let rel: string
    try { rel = decodeURIComponent(path).replace(/^\/+/, '') } catch { return c.text('Bad Request', 400) }
    if (rel.includes('\0')) return c.text('Bad Request', 400)
    let file = resolve(root, rel)
    if (file !== root && !file.startsWith(root + sep)) return c.text('Not Found', 404)

    let isFile = false
    try { isFile = statSync(file).isFile() } catch { /* missing */ }
    if (!isFile) {
      if (isHashedAsset(rel) || !existsSync(indexFile)) return c.text('Not Found', 404)
      file = indexFile
      rel = 'index.html'
    }

    const isIndex = file === indexFile
    const headers: Record<string, string> = {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(statSync(file).size),
      'x-content-type-options': 'nosniff',
      'cache-control': isIndex ? 'no-cache' : isHashedAsset(rel) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'referrer-policy': 'same-origin',
    }
    if (isIndex) {
      headers['content-security-policy'] = APP_CSP
      headers['x-frame-options'] = 'DENY'
    }
    if (method === 'HEAD') return new Response(null, { headers })
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers })
  }
}
