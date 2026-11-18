/** Page-wide keyboard shortcuts and popup-menu dismissal of the project page. */

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

/**
 * Ctrl/Cmd+S. `e.code` is the physical key, so it also matches on non-Latin layouts (Russian, Greek…),
 * where `e.key` is 'ы' or 'σ'; `e.key` covers layouts that put S elsewhere (Dvorak).
 */
export function isSaveShortcut(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 's' || e.code === 'KeyS')
}

/** Ctrl/Cmd+Alt+J (by e.code: Alt changes e.key on some layouts). */
export function isShowInPdfShortcut(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && e.altKey && e.code === 'KeyJ'
}

/**
 * While a popup menu is open: close it on a pointer press outside it, or on Escape.
 * `inside(target)` says whether an event target is within the menu (button included).
 * Returns the function that removes the listeners.
 */
export function dismissMenu(target: EventTarget, inside: (t: EventTarget | null) => boolean, close: () => void): () => void {
  const onPointer = (e: Event) => {
    if (!inside(e.target)) close()
  }
  const onKey = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') close()
  }
  target.addEventListener('pointerdown', onPointer, true)
  target.addEventListener('keydown', onKey)
  return () => {
    target.removeEventListener('pointerdown', onPointer, true)
    target.removeEventListener('keydown', onKey)
  }
}
