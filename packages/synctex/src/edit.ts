import { area, contains, gaps, recordBox } from './geometry.ts'
import { Kind, type SynctexIndex } from './types.ts'

export interface EditQuery {
  /** 1-based page. */
  page: number
  /** PDF points from the left edge of the page. */
  x: number
  /** PDF points from the top edge of the page. */
  y: number
}

export interface EditResult {
  /** The input path as recorded by TeX (normalised, see `normalizePath`). */
  path: string
  /** 1-based line. */
  line: number
  /** 0-based column, or -1 when TeX did not record one (the usual case). */
  column: number
}

export interface EditOptions {
  /** Only return records of inputs for which this returns true (e.g. project files, not TeX Live
   *  files). When the best record is rejected, the nearest accepted record on the page is returned. */
  accept?: (path: string) => boolean
}

/**
 * Inverse search (PDF -> source), following the synctex tool's strategy:
 *  1. The smallest line of text (hbox) on `page` containing the point, then the deepest box inside it
 *     that still contains the point.
 *  2. In a line of text, the nearest record to the left and the nearest to the right of the point
 *     (horizontal distance, 0 inside; a kern containing the point counts on the side of its nearer edge
 *     and loses ties); of two different records the one with the smaller line wins (where the clicked
 *     text starts). In a vertical box, the nearest child. A child box with content is entered and the
 *     same is repeated inside it. A box holding only math/position markers from another source line
 *     (LuaTeX tags those with the line that shipped the page) answers with its own line.
 *  3. Outside every line of text: the nearest line of text, then as in 2.
 * With `accept`, rejected inputs are skipped at every step; when nothing accepted is found that way, the
 * nearest accepted record on the page is returned. Null when the page has no usable records.
 */
export function edit(ix: SynctexIndex, q: EditQuery, opts: EditOptions = {}): EditResult | null {
  if (!Number.isFinite(q.page) || !Number.isFinite(q.x) || !Number.isFinite(q.y)) return null
  const page = Math.floor(q.page)
  if (page < 1) return null
  const { x, y } = q

  const acceptCache = new Map<number, boolean>()
  const ok = (i: number): boolean => {
    if (ix.line[i]! < 1) return false
    const tag = ix.tag[i]!
    let r = acceptCache.get(tag)
    if (r === undefined) {
      const path = ix.inputs.get(tag)
      r = path !== undefined && (opts.accept ? opts.accept(path) : true)
      acceptCache.set(tag, r)
    }
    return r
  }
  const dist = (i: number): number => {
    const { dx, dy } = gaps(recordBox(ix, i), x, y)
    return Math.hypot(dx, dy)
  }
  /** The record among `cands` nearest to the point that passes `eligible`, or -1. */
  const nearest = (cands: Iterable<number>, eligible: (i: number) => boolean): number => {
    let best = -1
    let bestD = Infinity
    for (const i of cands) {
      if (!eligible(i)) continue
      const d = dist(i)
      if (d < bestD) {
        best = i
        bestD = d
      }
    }
    return best
  }

  const ids: number[] = []
  for (let i = 0; i < ix.count; i++) if (ix.page[i] === page) ids.push(i)
  if (ids.length === 0) return null

  const kidsOf = new Map<number, number[]>()
  for (const i of ids) {
    const p = ix.parent[i]!
    if (p < 0) continue
    const list = kidsOf.get(p)
    if (list) list.push(i)
    else kidsOf.set(p, [i])
  }
  const isContainer = (i: number) => (ix.kind[i] === Kind.HBox || ix.kind[i] === Kind.VBox) && kidsOf.has(i)

  /** Step 2 for one box: the child for the point, or -1 (boxes with content are always candidates). */
  const pickChild = (box: number): number => {
    const kids = kidsOf.get(box) ?? []
    if (ix.kind[box] === Kind.VBox) return nearest(kids, (i) => isContainer(i) || ok(i))
    let left = -1
    let leftD = Infinity
    let right = -1
    let rightD = Infinity
    for (const i of kids) {
      if (!ok(i) && !isContainer(i)) continue
      const b = recordBox(ix, i)
      // signed horizontal distance: > 0 when the record is left of the point
      let d = x < b.left ? x - b.left : x > b.right ? x - b.right : 0
      let both = d === 0
      if (both && ix.kind[i] === Kind.Kern && b.right > b.left) {
        // inside a kern: it counts on the side of its nearer edge, at the distance to that edge
        d = x > (b.left + b.right) / 2 ? x - b.right : x - b.left
        both = d === 0
      }
      const penalty = ix.kind[i] === Kind.Kern ? KERN_PENALTY : 0
      if ((d > 0 || (d === 0 && both)) && d + penalty < leftD) {
        left = i
        leftD = d + penalty
      }
      if ((d < 0 || (d === 0 && both)) && -d + penalty < rightD) {
        right = i
        rightD = -d + penalty
      }
    }
    if (left >= 0 && right >= 0) {
      // of two different records, the one with the smaller line (where the clicked text starts)
      const ll = ix.line[left]!
      const rl = ix.line[right]!
      if (ll !== rl) return ll < rl ? left : right
      return leftD <= rightD ? left : right
    }
    return left >= 0 ? left : right
  }

  /**
   * LuaTeX tags the math-on/off and position records inside a math box with the line that shipped the page
   * (often a `\clearpage` in another file), while the box itself carries the right line. True when the usable
   * children of `box` are math records and position records only (at least one math record), all from another
   * source line than the box. Position records alone are ordinary text (they carry the real lines; the box
   * carries the end of the paragraph), so they never trigger this.
   */
  const onlyForeignMarkers = (box: number): boolean => {
    let math = false
    for (const i of kidsOf.get(box) ?? []) {
      if (!ok(i) && !isContainer(i)) continue
      const k = ix.kind[i]
      if (k !== Kind.Math && k !== Kind.Boundary) return false
      if (ix.tag[i] === ix.tag[box] && ix.line[i] === ix.line[box]) return false
      if (k === Kind.Math) math = true
    }
    return math
  }

  /** Step 2: descends from `box` through the chosen children to a record (-1 if none is accepted). */
  const inBox = (box: number): number => {
    let fallback = ok(box) ? box : -1
    // each step goes one level deeper, so this ends; the bound only guards against damaged input
    for (let guard = 0; guard <= ix.count; guard++) {
      const pick = pickChild(box)
      if (pick < 0) return fallback
      if (!isContainer(pick)) {
        if (!ok(pick)) return fallback
        return ok(box) && onlyForeignMarkers(box) ? box : pick
      }
      if (ok(pick)) fallback = pick
      box = pick
    }
    return fallback
  }

  // 1. the smallest line of text containing the point, then the deepest box in it containing the point
  let line = -1
  let lineArea = Infinity
  for (const i of ids) {
    if (ix.kind[i] !== Kind.HBox) continue
    const b = recordBox(ix, i)
    if (!contains(b, x, y)) continue
    const a = area(b)
    if (a < lineArea) {
      line = i
      lineArea = a
    }
  }

  let hit = -1
  if (line >= 0) {
    let container = line
    let depth = ix.depth[line]!
    const sub = new Set<number>([line])
    for (const i of ids) {
      if (i <= line || !sub.has(ix.parent[i]!)) continue
      sub.add(i)
      const k = ix.kind[i]!
      if ((k === Kind.HBox || k === Kind.VBox) && ix.depth[i]! > depth && contains(recordBox(ix, i), x, y)) {
        container = i
        depth = ix.depth[i]!
      }
    }
    hit = inBox(container)
  }

  // 3. outside every line of text: the nearest line of text (the innermost one on ties), then as in 2.
  if (hit < 0 && line < 0) {
    let best = -1
    let bestD = Infinity
    let bestArea = Infinity
    for (const i of ids) {
      if (ix.kind[i] !== Kind.HBox) continue
      const b = recordBox(ix, i)
      const { dx, dy } = gaps(b, x, y)
      const d = Math.hypot(dx, dy)
      const a = area(b)
      if (d < bestD || (d === bestD && a < bestArea)) {
        best = i
        bestD = d
        bestArea = a
      }
    }
    if (best >= 0) hit = inBox(best)
  }
  if (hit < 0) hit = nearest(ids, (i) => ix.kind[i] !== Kind.HBox && ix.kind[i] !== Kind.VBox && ok(i))
  // fallback (with `accept`): anything accepted on the page, vboxes last
  if (hit < 0) hit = nearest(ids, (i) => ix.kind[i] !== Kind.VBox && ok(i))
  if (hit < 0) hit = nearest(ids, ok)
  if (hit < 0) return null

  return { path: ix.inputs.get(ix.tag[hit]!)!, line: ix.line[hit]!, column: Math.max(-1, ix.column[hit]!) }
}

/** Points of distance added to kerns, so that glyph runs and glue win over kerns they overlap. */
const KERN_PENALTY = 0.01
