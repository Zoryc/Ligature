/**
 * Recovery after a document rebuild (docs/M3.md §4). When the server rebuilds a file's Yjs doc it gets a new
 * epoch; a tab still on the old epoch is refused with `reload-required` and must re-open the file. Edits it
 * made that the server never acknowledged cannot be merged into the new doc, so the user is shown their text
 * next to the server's (RecoveryDialog.svelte). Pure logic here; collab.ts feeds the tracker.
 */
import type * as Y from 'yjs'

/** What the open file's session knows about its own edits when the epoch changed. */
export interface LocalState {
  /** The local doc's text now. */
  text: string
  /** Local edits were made that the server has not acknowledged yet. */
  unsynced: boolean
  /** The text when the server last had everything we had (null: never fully synced). */
  lastSyncedText: string | null
}

/**
 * Tracks whether a file session holds edits the server has not acknowledged, and the text as of the last
 * moment it had none.
 *
 * The provider's own `hasUnsyncedChanges` cannot be used for this: every (re)connection attempt resets its
 * counter to 1 and only the server's sync acknowledgement brings it back to 0, so after a refused
 * reconnect (`reload-required`) it is always true, edits or not.
 */
export class SyncTracker {
  private dirty = false
  /**
   * The text before the first local transaction since the doc was last known to be clean (null: not taken
   * yet). Taken once and kept: Yjs emits 'update' only after the transaction's observers, which may start
   * further (no-op) transactions, so "before the first local edit" cannot be re-taken per transaction.
   */
  private before: string | null = null
  private everSynced = false

  /** Before a transaction that originates here (typing, undo). `text` is read at most once per clean period. */
  beforeLocalTransaction(text: () => string): void {
    if (!this.dirty && this.before === null && this.everSynced) this.before = text()
  }

  /** A local transaction changed the doc (Y.Doc 'update' with a local origin). */
  localUpdate(): void {
    this.dirty = true
  }

  /** The server's update was applied: while clean, the text taken before no longer applies. */
  remoteUpdate(): void {
    if (!this.dirty) this.before = null
  }

  /** The server acknowledged every update we sent (the provider's unsynced counter reached 0). */
  acknowledged(): void {
    this.dirty = false
    this.before = null
    this.everSynced = true
  }

  state(text: string): LocalState {
    return {
      text,
      unsynced: this.dirty,
      // While clean, the last synced text is the text itself (remote updates are synced by definition).
      lastSyncedText: !this.everSynced ? null : this.dirty ? this.before : text,
    }
  }
}

/**
 * Feed a tracker from a Y.Doc: transactions whose origin is not `remoteOrigin` (the provider, which applies
 * the server's updates) are local. Call `acknowledged()` when the server has acknowledged everything.
 */
export function trackDoc(doc: Y.Doc, ytext: Y.Text, remoteOrigin: unknown): SyncTracker {
  const tracker = new SyncTracker()
  doc.on('beforeTransaction', tr => { if (tr.origin !== remoteOrigin) tracker.beforeLocalTransaction(() => ytext.toString()) })
  doc.on('update', (_u: Uint8Array, origin: unknown) => {
    if (origin === remoteOrigin) tracker.remoteUpdate()
    else tracker.localUpdate()
  })
  return tracker
}

/**
 * Did this session make edits the server may not have? Unacknowledged edits that cancel out (typed, then
 * undone, while offline) do not count.
 */
export function hasLocalChanges(s: LocalState): boolean {
  if (!s.unsynced) return false
  return s.lastSyncedText === null || s.text !== s.lastSyncedText
}

export type RecoveryOutcome = 'reopen' | 'dialog'

/**
 * Re-open silently, or show the recovery dialog? `serverText` is the file's current text on the server
 * (null when it could not be loaded). Edits the server already has (it saved them before the rebuild) are
 * not lost, so the file re-opens silently then too.
 */
export function recoveryOutcome(s: LocalState, serverText: string | null): RecoveryOutcome {
  if (!hasLocalChanges(s)) return 'reopen'
  if (serverText !== null && serverText === s.text) return 'reopen'
  return 'dialog'
}

export const RECOVERY_TITLE = 'Your latest changes could not be merged automatically'

export function recoveryMessage(path: string): string {
  const name = path ? `"${path}"` : 'This file'
  return `${name} was rebuilt on the server while this tab had changes that were not saved yet. `
    + 'Your text is on the left, the current version on the right. Copy your text to keep it, '
    + 'then open the current version and paste back what you need.'
}

export interface ClipboardDeps {
  clipboard?: { writeText(text: string): Promise<void> } | undefined
  /** Fallback for browsers without the async clipboard (or without permission): a hidden textarea + copy. */
  execCopy?: ((text: string) => boolean) | undefined
}

/** Copy text to the clipboard; resolves false when neither way worked. */
export async function copyText(text: string, deps: ClipboardDeps): Promise<boolean> {
  if (deps.clipboard) {
    try {
      await deps.clipboard.writeText(text)
      return true
    } catch {
      // permission denied or not focused: try the fallback
    }
  }
  try {
    return deps.execCopy ? deps.execCopy(text) : false
  } catch {
    return false
  }
}

/** The textarea + execCommand('copy') fallback (browser only). */
export function execCommandCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.append(ta)
  ta.select()
  try {
    // Deprecated, but the only synchronous way left where navigator.clipboard is missing.
    return document.execCommand('copy')
  } finally {
    ta.remove()
  }
}
