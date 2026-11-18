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
  import { pagesInView } from './pdfLayout.ts'

  interface Props {
    /** Same-origin URL of the PDF to show; null shows the placeholder. */
    url: string | null
    placeholder?: string
  }

  let { url, placeholder = 'No PDF yet.' }: Props = $props()

  /** One page: a placeholder of the page's exact size; its canvas exists only while near the viewport. */
  interface Slot {
    num: number
    el: HTMLDivElement
    width: number
    height: number
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
  let current: Shown | null = null
  let seq = 0

  function releaseSlot(slot: Slot): void {
    if (!slot.canvas || slot.rendering) return
    // Zero-size first: browsers free the backing store right away instead of at GC time.
    slot.canvas.width = 0
    slot.canvas.height = 0
    slot.canvas = null
    slot.el.replaceChildren()
  }

  /** Render one page into its placeholder (at device resolution). Errors (doc destroyed meanwhile) are ignored. */
  async function renderSlot(doc: PdfJs.PDFDocumentProxy, slot: Slot): Promise<void> {
    if (slot.canvas || slot.rendering) return
    slot.rendering = true
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
      slot.el.replaceChildren(canvas)
    } catch {
      // superseded or destroyed document
    } finally {
      slot.rendering = false
    }
    if (!slot.near) releaseSlot(slot)
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
      const width = Math.max(200, scroller.clientWidth - 2 * PADDING)
      const sizes = await Promise.all(Array.from({ length: d.numPages }, async (_, i) => {
        const vp = (await d.getPage(i + 1)).getViewport({ scale: 1 })
        return { width, height: Math.floor(vp.height * width / vp.width) }
      }))
      if (my !== seq) return
      const slots: Slot[] = sizes.map((sz, i) => {
        const el = document.createElement('div')
        el.className = 'page'
        el.style.width = `${sz.width}px`
        el.style.height = `${sz.height}px`
        return { num: i + 1, el, width: sz.width, height: sz.height, canvas: null, rendering: false, near: false }
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

      pagesHost.replaceChildren(...slots.map(s => s.el))
      scroller.scrollTop = top
      scroller.scrollLeft = left
      for (const slot of slots) observer.observe(slot.el)
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

  onDestroy(() => {
    seq++
    dispose(current)
    current = null
  })
</script>

<div class="pdf" bind:this={scroller}>
  {#if loading}<div class="badge">Loading PDF…</div>{/if}
  {#if error}<div class="error">{error}</div>{/if}
  {#if !url && !hasPages}<div class="placeholder">{placeholder}</div>{/if}
  <div class="pages" bind:this={pagesHost}></div>
</div>

<style>
  .pdf {
    position: relative;
    height: 100%;
    overflow: auto;
    background: #e5e5e5;
  }
  .pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 12px;
  }
  .pages :global(.page) {
    flex: none;
    background: white;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
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
