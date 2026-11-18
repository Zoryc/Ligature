/** Layout maths for the lazily rendered PDF view (pages stacked vertically with padding and gaps). */

export interface StackLayout {
  /** CSS height of each page, in order */
  heights: number[]
  /** space above the first page */
  padding: number
  /** space between pages */
  gap: number
}

/**
 * 0-based indexes of the pages that intersect [top - margin, top + viewport + margin]
 * (scroll position `top`, visible height `viewport`).
 */
export function pagesInView(layout: StackLayout, top: number, viewport: number, margin = 0): number[] {
  const from = top - margin
  const to = top + viewport + margin
  const out: number[] = []
  let y = layout.padding
  for (let i = 0; i < layout.heights.length; i++) {
    const h = layout.heights[i] ?? 0
    if (y + h >= from && y <= to) out.push(i)
    else if (y > to) break
    y += h + layout.gap
  }
  return out
}
