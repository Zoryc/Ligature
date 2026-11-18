import type { PdfRect } from '@ligature/shared'
import { recordBox, type Box } from './geometry.ts'
import { tagsForPath } from './paths.ts'
import { Kind, type SynctexIndex } from './types.ts'

export interface ViewQuery {
  /** Input path: as recorded (absolute), or relative (matched as a suffix, see `tagsForPath`). */
  path: string
  /** 1-based line. */
  line: number
  /** Accepted for API symmetry; TeX engines do not record columns, so it does not affect the result. */
  column?: number
}

/**
 * Forward search (source -> PDF). Picks the line of `path` nearest to `line` that has typeset records
 * (`line` itself if it has any; on a tie the later line, as the synctex tool does), takes the lines of
 * text (hboxes) holding that line's records, and returns one rectangle per line of text, merged, all on
 * the first page that has any. Empty if nothing matches.
 */
export function view(ix: SynctexIndex, q: ViewQuery): PdfRect[] {
  const tags = tagsForPath(ix.inputs, q.path)
  if (tags.size === 0 || !Number.isFinite(q.line)) return []
  const want = Math.floor(q.line)

  // Records inside lines of text (glyph runs, kerns, glue, math, rules) say best where a source line
  // went; box records carry the line where TeX built the box (e.g. where the paragraph ended), so they
  // are used only when the file has no other records at all.
  let found = collect(ix, tags, want, false)
  if (found.owners.size === 0) found = collect(ix, tags, want, true)
  const { owners, firstPage } = found
  if (owners.size === 0) return []

  // Prefer lines of text; whole vboxes (a page body, a float) only when there is nothing else.
  const onPage = [...owners].filter((o) => ix.page[o] === firstPage)
  const textLines = onPage.filter((o) => ix.kind[o] !== Kind.VBox)
  const chosen = textLines.length > 0 ? textLines : onPage
  const merged = mergeLines(chosen.map((o) => recordBox(ix, o)))
  return merged.map((b) => ({
    page: firstPage,
    x: b.left,
    y: b.top,
    width: b.right - b.left,
    height: b.bottom - b.top,
  }))
}

const isBoxKind = (k: number) => k === Kind.VBox || k === Kind.HBox || k === Kind.VoidHBox || k === Kind.VoidVBox

/**
 * The record that represents record `i` on the page: boxes stand for themselves and records in vertical
 * lists for their vbox (both only when `boxes`), rules for themselves, any other record for its
 * enclosing line of text. -1 if `i` does not count.
 */
function owner(ix: SynctexIndex, i: number, boxes: boolean): number {
  if (ix.page[i]! <= 0) return -1
  if (isBoxKind(ix.kind[i]!)) return boxes ? i : -1
  if (ix.kind[i] === Kind.Rule) return i
  const parent = ix.parent[i]!
  if (parent < 0) return -1
  // vertical glue/kerns between paragraphs: only when nothing else is known about the file
  return ix.kind[parent] === Kind.VBox && !boxes ? -1 : parent
}

/**
 * Picks the line nearest to `want` that has counting records (the later one on a tie) and returns the
 * owners of that line's records on the first page that has any.
 */
function collect(ix: SynctexIndex, tags: Set<number>, want: number, boxes: boolean): { owners: Set<number>; firstPage: number } {
  let after = Infinity
  let before = -Infinity
  for (let i = 0; i < ix.count; i++) {
    if (!tags.has(ix.tag[i]!) || owner(ix, i, boxes) < 0) continue
    const l = ix.line[i]!
    if (l >= want) {
      if (l < after) after = l
    } else if (l > before) {
      before = l
    }
  }
  // the nearest line with records; on a tie the later one (SyncTeX tries L, L+1, L-1, L+2, ...)
  const target = after - want <= want - before ? after : before
  const owners = new Set<number>()
  let firstPage = Infinity
  if (!Number.isFinite(target)) return { owners, firstPage }
  for (let i = 0; i < ix.count; i++) {
    if (ix.line[i]! !== target || !tags.has(ix.tag[i]!)) continue
    const o = owner(ix, i, boxes)
    if (o < 0) continue
    owners.add(o)
    if (ix.page[o]! < firstPage) firstPage = ix.page[o]!
  }
  return { owners, firstPage }
}

/**
 * Merges boxes that belong to the same line of text: a box inside another disappears, boxes whose
 * vertical extents mostly overlap and that touch horizontally (gap <= 1 pt) become one.
 * Sorted top to bottom, then left to right.
 */
export function mergeLines(input: Box[]): Box[] {
  // Bounded work on hostile input: a real source line never spans this many lines of text.
  let boxes = input.slice(0, MAX_BOXES).map((b) => ({ ...b }))
  let changed = true
  for (let round = 0; changed && round < 4; round++) {
    changed = false
    const out: Box[] = []
    for (const b of boxes) {
      const m = out.find((o) => sameLine(o, b))
      if (m) {
        m.left = Math.min(m.left, b.left)
        m.top = Math.min(m.top, b.top)
        m.right = Math.max(m.right, b.right)
        m.bottom = Math.max(m.bottom, b.bottom)
        changed = true
      } else {
        out.push(b)
      }
    }
    boxes = out
  }
  return boxes.sort((a, b) => a.top - b.top || a.left - b.left)
}

const MAX_BOXES = 1000

function sameLine(a: Box, b: Box): boolean {
  const inside = (o: Box, i: Box) => i.left >= o.left && i.right <= o.right && i.top >= o.top && i.bottom <= o.bottom
  if (inside(a, b) || inside(b, a)) return true
  const overlapV = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  const minH = Math.min(a.bottom - a.top, b.bottom - b.top)
  if (overlapV <= 0 || overlapV < 0.5 * minH) return false
  const gapH = Math.max(a.left, b.left) - Math.min(a.right, b.right)
  return gapH <= 1
}
