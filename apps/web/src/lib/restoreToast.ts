/**
 * The "version restored" toast (docs/M3.md §7): shown after any restore — our own (from the HTTP response) or a
 * collaborator's (from the `version-restored` event) — exactly once per restore, with Undo for owners/editors
 * for 30 seconds. Undo = restore the pre-restore version (only the restored files' paths after a partial restore
 * of ours; see history.ts undoPaths()).
 */
import { toast } from './toasts.svelte.ts'

export const UNDO_MS = 30_000

export interface RestoredEvent { versionId: string; preRestoreVersionId: string; by: string }

/**
 * Decides which restores to announce, each exactly once. Our own restore arrives twice: the HTTP response
 * and the `version-restored` broadcast, which may come first. While one of our restores is in flight, events
 * are held back; when it finishes, ours is announced (as "by you") and the held events that are not ours are
 * released. Keyed by the pre-restore version id, which is unique per restore.
 */
export class RestoreNotices {
  private readonly seen: string[] = []
  private inFlight = 0
  private held: RestoredEvent[] = []
  constructor(private readonly max = 100) {}

  /** true the first time this restore is seen. */
  claim(preRestoreVersionId: string): boolean {
    if (this.seen.includes(preRestoreVersionId)) return false
    this.seen.push(preRestoreVersionId)
    if (this.seen.length > this.max) this.seen.shift()
    return true
  }

  /** One of our restores was sent. */
  begin(): void {
    this.inFlight++
  }

  /**
   * Our restore finished (`preRestoreVersionId` null when it failed). Returns whether to announce ours,
   * and the held collaborators' events to announce now.
   */
  finish(preRestoreVersionId: string | null): { own: boolean; others: RestoredEvent[] } {
    this.inFlight = Math.max(0, this.inFlight - 1)
    const own = preRestoreVersionId !== null && this.claim(preRestoreVersionId)
    if (this.inFlight > 0) return { own, others: [] }
    const held = this.held
    this.held = []
    return { own, others: held.filter(e => this.claim(e.preRestoreVersionId)) }
  }

  /** A version-restored event: the event to announce now, or null (already announced, or held back). */
  event(e: RestoredEvent): RestoredEvent | null {
    if (this.inFlight > 0) {
      this.held.push(e)
      return null
    }
    return this.claim(e.preRestoreVersionId) ? e : null
  }
}

/**
 * "Restored to "Draft 1" by Alice." / "Restored main.tex to "Draft 1" by you (1 file changed)."
 * `what` is e.g. 'to "Draft 1"' (see history.ts versionRef()).
 */
export function restoredText(what: string, by: string, mine: boolean, detail = ''): string {
  return `Restored ${what} by ${mine ? 'you' : by || 'a collaborator'}${detail ? ` (${detail})` : ''}.`
}

export interface RestoredToast {
  what: string
  by: string
  mine: boolean
  detail?: string
  /** Owners and editors may undo. */
  canUndo: boolean
  /** Resolves false when nothing was undone (failed or cancelled): the toast then comes back with Undo. */
  onUndo: () => Promise<boolean> | void
}

/** A failed Undo brings the toast back only if at least this much of its time is left. */
export const RESHOW_MIN_MS = 1000

/**
 * Show the toast; with Undo it stays for UNDO_MS (then Undo is gone with it). Returns the toast id.
 * Clicking Undo closes the toast; if the undo fails or is cancelled, the toast is shown again with Undo for
 * the rest of the original 30 s (`until`), so a transient error (e.g. a rate limit) does not lose the Undo.
 */
export function showRestoredToast(t: RestoredToast, until = Date.now() + UNDO_MS): number {
  const text = restoredText(t.what, t.by, t.mine, t.detail)
  if (!t.canUndo) return toast(text, 'info', 8000)
  const again = () => {
    if (until - Date.now() >= RESHOW_MIN_MS) showRestoredToast(t, until)
  }
  const run = () => {
    const r = t.onUndo()
    if (r) void r.then(ok => { if (!ok) again() }, again)
  }
  return toast(text, 'info', Math.max(0, until - Date.now()), { label: 'Undo', run })
}
