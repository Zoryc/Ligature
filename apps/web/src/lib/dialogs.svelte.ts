/**
 * In-page replacements for confirm()/prompt(): one dialog at a time, promise based.
 * Rendered by DialogHost.svelte (mounted once in App.svelte).
 */

export interface DialogOption { value: string; label: string; disabled?: boolean }

export interface DialogOptions {
  title: string
  message?: string
  /** A text field; the dialog resolves with its value. */
  input?: { label: string; value?: string; type?: 'text' | 'password'; validate?: (value: string) => string | null }
  /** A select; the dialog resolves with the chosen value. */
  select?: { label: string; options: DialogOption[]; value?: string }
  /** The user must type exactly this to enable the confirm button (e.g. a project name before deleting it). */
  requireText?: string
  confirmLabel?: string
  danger?: boolean
}

interface OpenDialog extends DialogOptions { resolve: (value: string | null) => void }

export const dialogState = $state<{ current: OpenDialog | null }>({ current: null })

/** Resolves with the input/select value ('' for a plain confirmation), or null when cancelled. */
export function openDialog(opts: DialogOptions): Promise<string | null> {
  dialogState.current?.resolve(null) // only one at a time
  return new Promise(resolve => {
    dialogState.current = {
      ...opts,
      resolve: v => {
        dialogState.current = null
        resolve(v)
      },
    }
  })
}

/** Cancel the open dialog, if any (its promise resolves with null). Called on every route change. */
export function cancelDialog(): void {
  dialogState.current?.resolve(null)
}

export async function confirmDialog(title: string, message: string, opts: Partial<DialogOptions> = {}): Promise<boolean> {
  return (await openDialog({ title, message, ...opts })) !== null
}

export function promptDialog(title: string, label: string, value = '', opts: Partial<DialogOptions> & { validate?: (v: string) => string | null } = {}):
  Promise<string | null> {
  const { validate, ...rest } = opts
  return openDialog({ title, input: { label, value, ...(validate ? { validate } : {}) }, ...rest })
}
