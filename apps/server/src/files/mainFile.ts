/**
 * Main-file detection (docs/M2.md §4), used at compile time when the project has no main file and
 * on zip import:
 *   1. `main.tex` at the root;
 *   2. else the only root `.tex` containing `\documentclass`;
 *   3. else the first (by path) `.tex` containing `\documentclass`.
 * A `\documentclass` that is commented out (`%` earlier on its line) does not count.
 */

export interface MainCandidate { path: string; text: string }

const DOCUMENTCLASS = /^[^%\n]*\\documentclass(?![A-Za-z])/m

/** True if `text` has an uncommented `\documentclass` (a plain substring search first: most files have none). */
export const hasDocumentClass = (text: string): boolean => text.includes('\\documentclass') && DOCUMENTCLASS.test(text)

const isTex = (path: string) => path.toLowerCase().endsWith('.tex')

/** Path of the detected main file among `files` (text files only), or null. */
export function detectMainFile(files: MainCandidate[]): string | null {
  if (files.some(f => f.path === 'main.tex')) return 'main.tex'
  return chooseMainFile(files.map(f => ({ path: f.path, hasClass: isTex(f.path) && hasDocumentClass(f.text) })))
}

/**
 * The same rules over precomputed `hasDocumentClass` results (bulk callers compute them in small steps).
 * `hasClass` is only looked at for `.tex` files.
 */
export function chooseMainFile(files: { path: string; hasClass: boolean }[]): string | null {
  if (files.some(f => f.path === 'main.tex')) return 'main.tex'
  const withClass = files.filter(f => isTex(f.path) && f.hasClass)
  const atRoot = withClass.filter(f => !f.path.includes('/'))
  if (atRoot.length === 1) return atRoot[0]!.path
  const sorted = withClass.map(f => f.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[0] ?? null
}
