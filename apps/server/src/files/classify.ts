/** Text vs binary classification for uploads (docs/M1.md §4). */

export const MAX_TEXT_BYTES = 1024 * 1024

export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.dtx', '.ins', '.txt', '.md', '.csv', '.tsv',
  '.dat', '.tikz', '.pgf', '.lua', '.cfg', '.def', '.clo', '.fd', '.ist', '.gst', '.bbl',
])

/** Lowercased extension including the dot, or '' (a leading dot alone, as in `.latexmkrc`, is not an extension). */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/**
 * Decode strict UTF-8 (BOM stripped). Returns null for invalid UTF-8.
 * Line endings are normalised to `\n`: CodeMirror treats `\r\n` as one line break,
 * so a `\r` in the Yjs text would desynchronise editor and doc positions.
 */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    return normalizeNewlines(decoder.decode(bytes))
  } catch {
    return null
  }
}

export function normalizeNewlines(s: string): string {
  return s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s
}

export type Classified = { kind: 'text'; text: string } | { kind: 'binary' }

/** Text iff allow-listed extension AND valid UTF-8 AND ≤ 1 MB; everything else is binary. */
export function classifyUpload(name: string, bytes: Uint8Array): Classified {
  if (!TEXT_EXTENSIONS.has(extensionOf(name)) || bytes.byteLength > MAX_TEXT_BYTES) return { kind: 'binary' }
  const text = decodeText(bytes)
  return text === null ? { kind: 'binary' } : { kind: 'text', text }
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
}
const OTHER_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.eps': 'application/postscript', '.zip': 'application/zip',
}

/** Images that may be shown inline (never SVG: it can carry script). */
export function inlineImageType(name: string): string | null {
  return IMAGE_TYPES[extensionOf(name)] ?? null
}

export function contentTypeOf(name: string): string {
  const ext = extensionOf(name)
  return IMAGE_TYPES[ext] ?? OTHER_TYPES[ext] ?? 'application/octet-stream'
}
