<script module lang="ts">
  import type * as PdfJs from 'pdfjs-dist'

  // pdf.js is large: load it (and its worker) only when a PDF is first shown.
  let pdfjs: Promise<typeof PdfJs> | null = null
  function loadPdfjs(): Promise<typeof PdfJs> {
    pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
      .then(([lib, worker]) => {
        lib.GlobalWorkerOptions.workerSrc = worker.default
        return lib
      })
    return pdfjs
  }
</script>

<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import type { PdfRect } from '@ligature/shared'
  import { pagesInView } from './pdfLayout.ts'
  import { cssPointToPdf, pageCssSize, pageScale, pdfRectToCss, scrollTargetFor, stepZoom } from './pdfCoords.ts'

  interface Props {
    /** Same-origin URL of the PDF to show; null shows the placeholder. */
    url: string | null
    placeholder?: string
    /** Double-click on a page: PDF point (top-left origin) for SyncTeX inverse search. */
    onInverseSearch?: (page: number, x: number, y: number) => void
    /** Tooltip of the pages (e.g. "Double-click to jump to the source"). */
    pageTitle?: string
  }

  let { url, placeholder = 'No PDF yet.', onInverseSearch, pageTitle = '' }: Props = $props()

  /** One page: a placeholder of the page's exact size; its canvas exists only while near the viewport. */
  interface Slot {
    num: number
    el: HTMLDivElement
    /** CSS size at the current zoom */
    width: number
    height: number
    /** Size in PDF points */
    ptWidth: number
    ptHeight: number
    canvas: HTMLCanvasElement | null
    rendering: boolean
    /** within the observer's margin */
    near: boolean
  }

  interface Shown {
    doc: PdfJs.PDFDocumentProxy
    slots: Slot[]
    observer: IntersectionObserver
  }

  const PADDING = 12
  const GAP = 12

  let scroller: HTMLDivElement
  let pagesHost: HTMLDivElement
  let loading = $state(false)
  let error = $state<string | null>(null)
  let hasPages = $state(false)
  /** Multiple of the fit-to-width size. */
  let zoom = $state(1)
  /** CSS width of a page at zoom 1 (the pane's width when the PDF was loaded). */
  let fitWidth = 600
  let current: Shown | null = null
  let seq = 0

  function releaseSlot(slot: Slot): void {
    if (!slot.canvas || slot.rendering) return
    // Zero-size first: browsers free the backing store right away instead of at GC time.
    slot.canvas.width = 0
    slot.canvas.height = 0
    slot.canvas.remove()
    slot.canvas = null
  }

  /** Render one page into its placeholder (at device resolution). Errors (doc destroyed meanwhile) are ignored. */
  async function renderSlot(doc: PdfJs.PDFDocumentProxy, slot: Slot): Promise<void> {
    if (slot.canvas || slot.rendering) return
    slot.rendering = true
    const width = slot.width
    try {
      const page = await doc.getPage(slot.num)
      const dpr = window.devicePixelRatio || 1
      const scale = slot.width / page.getViewport({ scale: 1 }).width
      const viewport = page.getViewport({ scale: scale * dpr })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${slot.width}px`
      canvas.style.height = `${slot.height}px`
      await page.render({ canvas, viewport }).promise
      page.cleanup()
      slot.canvas = canvas
      slot.el.prepend(canvas)
    } catch {
      // superseded or destroyed document
    } finally {
      slot.rendering = false
    }
    if (!slot.near) releaseSlot(slot)
    else if (slot.width !== width) {
      // The zoom changed while rendering: render again at the new size.
      releaseSlot(slot)
      void renderSlot(doc, slot)
    }
  }

  function observe(slots: Slot[], d: PdfJs.PDFDocumentProxy): IntersectionObserver {
    const bySlotEl = new Map(slots.map(s => [s.el as Element, s]))
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const slot = bySlotEl.get(entry.target)
        if (!slot) continue
        slot.near = entry.isIntersecting
        if (slot.near) void renderSlot(d, slot)
        else releaseSlot(slot)
      }
    }, { root: scroller, rootMargin: '100% 0px' }) // one screen above and below stays rendered
    for (const slot of slots) observer.observe(slot.el)
    return observer
  }

  function dispose(shown: Shown | null): void {
    if (!shown) return
    shown.observer.disconnect()
    for (const slot of shown.slots) {
      slot.near = false
      releaseSlot(slot)
    }
    void shown.doc.loadingTask.destroy()
  }

  async function show(src: string): Promise<void> {
    const my = ++seq
    loading = true
    error = null
    let doc: PdfJs.PDFDocumentProxy | null = null
    try {
      const res = await fetch(src, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = new Uint8Array(await res.arrayBuffer())
      const lib = await loadPdfjs()
      if (my !== seq) return
      doc = await lib.getDocument({ data }).promise
      if (my !== seq) return
      const d = doc

      // Size every page (cheap: no rendering), then render only the pages near the viewport.
      // Rendering everything at once costs width x height x 4 bytes per page: a long thesis would
      // need gigabytes of canvas memory.
      fitWidth = Math.max(200, scroller.clientWidth - 2 * PADDING)
      const pts = await Promise.all(Array.from({ length: d.numPages }, async (_, i) => {
        const vp = (await d.getPage(i + 1)).getViewport({ scale: 1 })
        return { width: vp.width, height: vp.height }
      }))
      if (my !== seq) return
      const sizes = pts.map(pt => pageCssSize(pt, fitWidth, zoom))
      const slots: Slot[] = sizes.map((sz, i) => {
        const el = document.createElement('div')
        el.className = 'pdf-page'
        el.dataset['page'] = String(i + 1)
        el.style.width = `${sz.width}px`
        el.style.height = `${sz.height}px`
        const pt = pts[i]!
        return {
          num: i + 1, el, width: sz.width, height: sz.height, ptWidth: pt.width, ptHeight: pt.height,
          canvas: null, rendering: false, near: false,
        }
      })

      // Pre-render what will be on screen at the current scroll position, then swap, so a recompile
      // does not flash blank pages or move the reader.
      const top = scroller.scrollTop
      const left = scroller.scrollLeft
      const visible = pagesInView({ heights: sizes.map(s => s.height), padding: pagesHost.offsetTop + PADDING, gap: GAP }, top, scroller.clientHeight)
      await Promise.all(visible.map(i => {
        const slot = slots[i]
        if (!slot) return
        slot.near = true
        return renderSlot(d, slot)
      }))
      if (my !== seq) {
        for (const slot of slots) { slot.near = false; releaseSlot(slot) }
        return
      }

      pagesHost.replaceChildren(...slots.map(s => s.el))
      scroller.scrollTop = top
      scroller.scrollLeft = left
      const observer = observe(slots, d)
      hasPages = slots.length > 0

      const old = current
      current = { doc: d, slots, observer }
      doc = null
      dispose(old)
    } catch (e) {
      if (my === seq) error = `Could not load the PDF: ${(e as Error).message ?? String(e)}`
    } finally {
      if (doc) void doc.loadingTask.destroy() // superseded or failed: drop it
      if (my === seq) loading = false
    }
  }

  $effect(() => {
    const src = url
    if (src) untrack(() => void show(src))
  })

  /** Resize every page for the new zoom, keeping the middle of the view where it was. */
  function setZoom(z: number): void {
    if (z === zoom) return
    zoom = z
    const shown = current
    if (!shown) return
    const mid = (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(1, scroller.scrollHeight)
    shown.observer.disconnect()
    for (const slot of shown.slots) {
      const sz = pageCssSize({ width: slot.ptWidth, height: slot.ptHeight }, fitWidth, z)
      slot.width = sz.width
      slot.height = sz.height
      slot.el.style.width = `${sz.width}px`
      slot.el.style.height = `${sz.height}px`
      slot.near = false
      releaseSlot(slot)
    }
    scroller.scrollTop = Math.max(0, mid * scroller.scrollHeight - scroller.clientHeight / 2)
    // A fresh observer reports every page once, so the pages now near the view get rendered.
    shown.observer = observe(shown.slots, shown.doc)
  }

  function slotOf(el: EventTarget | null): Slot | null {
    const page = el instanceof Element ? el.closest('.pdf-page') : null
    return page && current ? current.slots.find(s => s.el === page) ?? null : null
  }

  function dblclick(e: MouseEvent): void {
    const slot = slotOf(e.target)
    if (!slot || !onInverseSearch) return
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    const r = slot.el.getBoundingClientRect()
    const pt = cssPointToPdf(e.clientX - r.left, e.clientY - r.top, pageScale(slot.width, slot.ptWidth))
    onInverseSearch(slot.num, pt.x, pt.y)
  }

  /**
   * Scroll to SyncTeX boxes (PDF points, top-left origin; all on one page) and highlight them for a moment.
   * Returns false when no PDF (or no such page) is shown.
   */
  export function showBoxes(boxes: PdfRect[]): boolean {
    const first = boxes[0]
    const slot = first && current ? current.slots[first.page - 1] : undefined
    if (!first || !slot) return false
    const scale = pageScale(slot.width, slot.ptWidth)
    const onPage = boxes.filter(b => b.page === first.page)
    const pageRect = slot.el.getBoundingClientRect()
    const viewRect = scroller.getBoundingClientRect()
    const pageTop = scroller.scrollTop + pageRect.top - viewRect.top
    // Zoomed in: also scroll sideways when the start of the boxes is out of view.
    const boxLeft = scroller.scrollLeft + pageRect.left - viewRect.left + Math.min(...onPage.map(b => b.x)) * scale
    const left = boxLeft < scroller.scrollLeft || boxLeft > scroller.scrollLeft + scroller.clientWidth - 40
      ? Math.max(0, boxLeft - 24) : scroller.scrollLeft
    scroller.scrollTo({ top: scrollTargetFor(onPage, pageTop, scale, scroller.clientHeight), left, behavior: 'smooth' })
    for (const old of slot.el.querySelectorAll('.synctex-box')) old.remove()
    for (const b of onPage) {
      const c = pdfRectToCss(b, scale)
      const div = document.createElement('div')
      div.className = 'synctex-box'
      div.style.left = `${c.left - 2}px`
      div.style.top = `${c.top - 2}px`
      div.style.width = `${c.width + 4}px`
      div.style.height = `${Math.max(c.height, 4) + 4}px`
      slot.el.append(div)
      div.addEventListener('animationend', () => div.remove())
    }
    return true
  }

  onDestroy(() => {
    seq++
    dispose(current)
    current = null
  })
</script>

<div class="pdf" bind:this={scroller}>
  {#if hasPages}
    <div class="zoom" role="toolbar" aria-label="Zoom">
      <button type="button" title="Zoom out" onclick={() => setZoom(stepZoom(zoom, -1))}>−</button>
      <span class="pct">{Math.round(zoom * 100)}%</span>
      <button type="button" title="Zoom in" onclick={() => setZoom(stepZoom(zoom, 1))}>+</button>
      <button type="button" title="Fit the page width" onclick={() => setZoom(1)}>Fit</button>
    </div>
  {/if}
  {#if loading}<div class="badge">Loading PDF…</div>{/if}
  {#if error}<div class="error">{error}</div>{/if}
  {#if !url && !hasPages}<div class="placeholder">{placeholder}</div>{/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pages" bind:this={pagesHost} ondblclick={dblclick} title={pageTitle}></div>
</div>

<style>
  .pdf {
    position: relative;
    height: 100%;
    overflow: auto;
    /* Reserve the scrollbar's room, so fit-to-width pages do not overflow once the scrollbar appears. */
    scrollbar-gutter: stable;
    background: #e5e5e5;
  }
  /*
   * As wide as the widest page (at least the pane), pages centred inside: a page zoomed wider than the
   * pane then overflows to the right, where it can be scrolled to. (Centring a wider page in a pane-wide
   * box would push its left part out of reach.)
   */
  .pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 12px;
    width: max-content;
    min-width: 100%;
  }
  .pages :global(.pdf-page) {
    flex: none;
    position: relative;
    background: white;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  .pages :global(.synctex-box) {
    position: absolute;
    pointer-events: none;
    background: rgba(255, 200, 0, 0.35);
    outline: 2px solid rgba(230, 150, 0, 0.9);
    animation: synctex-fade 2.5s ease-in forwards;
  }
  @keyframes -global-synctex-fade {
    0%, 50% { opacity: 1; }
    100% { opacity: 0; }
  }
  .zoom {
    position: sticky;
    top: 0;
    left: 0;
    z-index: 2;
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: flex-end;
    padding: 3px 6px;
    background: rgba(229, 229, 229, 0.92);
    border-bottom: 1px solid #d0d0d0;
    font-size: 12px;
  }
  .zoom button { padding: 0 8px; font-size: 12px; }
  .pct { min-width: 3.5em; text-align: center; }
  .pages :global(canvas) {
    display: block;
  }
  .badge {
    position: sticky;
    top: 4px;
    margin: 4px auto 0;
    width: max-content;
    background: #333;
    color: white;
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 3px;
    z-index: 1;
  }
  .error {
    margin: 8px;
    color: #b00020;
  }
  .placeholder {
    margin: 24px;
    color: #666;
    text-align: center;
  }
</style>
