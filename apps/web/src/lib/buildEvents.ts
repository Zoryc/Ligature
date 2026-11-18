/**
 * Sorting compile-finished events into "ours" and "a collaborator's".
 *
 * Our compile result comes back over HTTP, the compile-finished broadcast over the WebSocket: two
 * connections, so either can arrive first. Our own build ids are remembered, so the broadcast of our
 * own build is ignored whenever it arrives. Collaborators' events received while our request is in
 * flight are held back: on success ours is newer and they only deserve a mention; on failure they
 * are handed back so the newest collaborator build can still be shown.
 */

export interface FinishedEvent { buildId: string; status: string }

export type EventAction = 'ignore' | 'held' | 'show'

const KEEP_OWN = 32

export class BuildEvents {
  private readonly own: string[] = []
  private held: FinishedEvent[] | null = null

  get inFlight(): boolean {
    return this.held !== null
  }

  /** Our compile request is being sent. */
  begin(): void {
    this.held = []
  }

  /** A compile-finished broadcast arrived. 'show' means: display it as a collaborator's build. */
  onEvent(e: FinishedEvent): EventAction {
    if (this.own.includes(e.buildId)) return 'ignore'
    if (this.held) {
      this.held.push(e)
      return 'held'
    }
    return 'show'
  }

  /** Our compile returned `buildId`. Returns the collaborators' events held meanwhile (older than ours). */
  succeeded(buildId: string): FinishedEvent[] {
    this.own.push(buildId)
    if (this.own.length > KEEP_OWN) this.own.shift()
    const held = (this.held ?? []).filter(e => e.buildId !== buildId)
    this.held = null
    return held
  }

  /** Our compile failed. Returns the held events, which should now be shown. */
  failed(): FinishedEvent[] {
    const held = this.held ?? []
    this.held = null
    return held
  }
}
