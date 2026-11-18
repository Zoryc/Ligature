/**
 * Conversions between PDF points (1/72 in, origin at the TOP-left of the page, as SyncTeX answers use
 * them: PdfRect in the contract) and pixels of the rendered page, for any zoom.
 *
 * `scale` = CSS pixels per PDF point (page CSS width / page width in points). The canvas backing store
 * has `scale * devicePixelRatio` pixels per point; the page element is sized in CSS pixels.
 */
import type { PdfRect } from '@ligature/shared'

export interface CssRect { left: number; top: number; width: number; height: number }

/** CSS pixels per point for a page shown `cssWidth` px wide whose width is `ptWidth` points. */
export function pageScale(cssWidth: number, ptWidth: number): number {
  return ptWidth > 0 ? cssWidth / ptWidth : 1
}

/** A PDF rectangle -> CSS pixels inside the page element. */
export function pdfRectToCss(r: Pick<PdfRect, 'x' | 'y' | 'width' | 'height'>, scale: number): CssRect {
  return { left: r.x * scale, top: r.y * scale, width: r.width * scale, height: r.height * scale }
}

/** A click at CSS pixel (x, y) inside the page element -> PDF points (top-left origin). */
export function cssPointToPdf(x: number, y: number, scale: number): { x: number; y: number } {
  return { x: round2(x / scale), y: round2(y / scale) }
}

/** A canvas (device) pixel -> PDF points, for a canvas rendered at `scale * dpr`. */
export function canvasPointToPdf(px: number, py: number, scale: number, dpr: number): { x: number; y: number } {
  return cssPointToPdf(px / dpr, py / dpr, scale)
}

/** PDF points -> canvas (device) pixels. */
export function pdfPointToCanvas(x: number, y: number, scale: number, dpr: number): { x: number; y: number } {
  return { x: x * scale * dpr, y: y * scale * dpr }
}

/** Two decimals are plenty (1/7200 in), and keep the query string short (the server takes plain decimals). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Pixel size of a page at a zoom (`fitWidth` = CSS width at 100%). */
export function pageCssSize(pt: { width: number; height: number }, fitWidth: number, zoom: number): { width: number; height: number } {
  const width = Math.max(1, Math.round(fitWidth * zoom))
  return { width, height: Math.max(1, Math.round(pt.height * width / pt.width)) }
}

/**
 * Scroll position that puts the boxes about a third of the way down the view.
 * `pageTop` = offset of the page element's top inside the scrolled content.
 */
export function scrollTargetFor(boxes: readonly Pick<PdfRect, 'y' | 'height'>[], pageTop: number, scale: number, viewHeight: number): number {
  if (boxes.length === 0) return Math.max(0, pageTop)
  const top = Math.min(...boxes.map(b => b.y)) * scale
  return Math.max(0, Math.round(pageTop + top - viewHeight / 3))
}

export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const

/** Next zoom step up (dir 1) or down (dir -1) from `zoom`. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find(z => z > zoom + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  return [...ZOOM_STEPS].reverse().find(z => z < zoom - 1e-6) ?? ZOOM_STEPS[0]
}
