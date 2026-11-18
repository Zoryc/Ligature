import { Kind, type SynctexIndex } from './types.ts'

/** An axis-aligned rectangle in PDF points, origin at the top-left of the page, y growing downwards. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * The extent of record `i` in PDF points. Boxes, void boxes and rules span `W` horizontally and
 * `H` above / `D` below the baseline; kerns span their width along the baseline; other point records
 * are a point on the baseline.
 */
export function recordBox(ix: SynctexIndex, i: number): Box {
  const s = ix.scale
  const x = ix.h[i]! * s + ix.xOffset
  const base = ix.v[i]! * s + ix.yOffset
  const k = ix.kind[i]!
  const w = ix.width[i]! * s
  // a kern record is written where the kern ends
  if (k === Kind.Kern) return { left: Math.min(x, x - w), top: base, right: Math.max(x, x - w), bottom: base }
  const top = base - ix.height[i]! * s
  const bottom = base + ix.depthBelow[i]! * s
  return {
    left: Math.min(x, x + w),
    top: Math.min(top, bottom),
    right: Math.max(x, x + w),
    bottom: Math.max(top, bottom),
  }
}

export const contains = (b: Box, x: number, y: number): boolean =>
  x >= b.left && x <= b.right && y >= b.top && y <= b.bottom

/** Horizontal and vertical distances from a point to a box (0 inside). */
export function gaps(b: Box, x: number, y: number): { dx: number; dy: number } {
  const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0
  const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0
  return { dx, dy }
}

export const area = (b: Box): number => (b.right - b.left) * (b.bottom - b.top)
