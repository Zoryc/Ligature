/**
 * Normalises a path as written by TeX: `\` becomes `/`, empty and `.` segments are dropped, `..` is
 * resolved where possible. A leading `/` and a drive letter (`C:`) are kept.
 *   `/build/src/./chapters//intro.tex` -> `/build/src/chapters/intro.tex`
 *   `./main.tex` -> `main.tex`
 */
export function normalizePath(path: string): string {
  const s = path.replace(/\\/g, '/')
  const absolute = s.startsWith('/')
  const out: string[] = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      const last = out[out.length - 1]
      if (last !== undefined && last !== '..' && !/^[A-Za-z]:$/.test(last)) {
        out.pop()
        continue
      }
      if (absolute && out.length === 0) continue
    }
    out.push(seg)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/**
 * The input tags whose path is `path`: an exact match of the normalised paths, else (for a relative
 * `path`) the inputs ending with `/<path>`, keeping only the shortest such paths (so `intro.tex` prefers
 * `/src/intro.tex` over `/src/chapters/intro.tex`). Several tags can share a path (a file input twice).
 */
export function tagsForPath(inputs: ReadonlyMap<number, string>, path: string): Set<number> {
  const want = normalizePath(path)
  const tags = new Set<number>()
  if (want === '') return tags
  for (const [tag, p] of inputs) if (p === want) tags.add(tag)
  if (tags.size > 0 || want.startsWith('/')) return tags

  const suffix = '/' + want
  let best = Infinity
  for (const [tag, p] of inputs) {
    if (!p.endsWith(suffix)) continue
    if (p.length < best) {
      best = p.length
      tags.clear()
    }
    if (p.length === best) tags.add(tag)
  }
  return tags
}
