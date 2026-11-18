export interface Toast { id: number; text: string; kind: 'info' | 'error' }

export const toasts = $state<Toast[]>([])

let next = 1

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000): void {
  const id = next++
  toasts.push({ id, text, kind })
  setTimeout(() => dismiss(id), ms)
}

export function dismiss(id: number): void {
  const i = toasts.findIndex(t => t.id === id)
  if (i >= 0) toasts.splice(i, 1)
}
