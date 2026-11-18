export interface ToastAction { label: string; run: () => void }

export interface Toast { id: number; text: string; kind: 'info' | 'error'; action?: ToastAction }

export const toasts = $state<Toast[]>([])

let next = 1

/** Show a toast for `ms`; with `action`, it gets a button (e.g. Undo) that runs it and closes the toast. Returns its id. */
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000, action?: ToastAction): number {
  const id = next++
  toasts.push(action ? { id, text, kind, action } : { id, text, kind })
  setTimeout(() => dismiss(id), ms)
  return id
}

export function dismiss(id: number): void {
  const i = toasts.findIndex(t => t.id === id)
  if (i >= 0) toasts.splice(i, 1)
}

/** Run a toast's action (once) and close it. */
export function runAction(id: number): void {
  const t = toasts.find(x => x.id === id)
  if (!t?.action) return
  const { run } = t.action
  dismiss(id)
  run()
}
