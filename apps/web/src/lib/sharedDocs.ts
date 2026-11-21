/** The doc-sharing rule of ProjectCollab (collab.ts), apart so it can be tested without a socket. */

/**
 * One open doc per name, shared by its holders (docs/RENAME-AND-REPLACE.md §2): the editor's file session and
 * any project operation. Hocuspocus keys providers by name on a socket, so a second provider for the same doc
 * is not allowed. The doc opens with its first holder and closes when the last one lets go. Presence (the
 * awareness `user` field) is on while a holder that wants it (the editor) holds the doc, off otherwise.
 */
export class SharedDocs<T> {
  private readonly entries = new Map<string, { value: T; holders: number; present: number; closed: boolean }>()

  constructor(private readonly hooks: {
    open(name: string): T
    close(value: T): void
    presence(value: T, on: boolean): void
  }) {}

  acquire(name: string, presence: boolean): { value: T; release(): void } {
    let entry = this.entries.get(name)
    if (!entry) {
      entry = { value: this.hooks.open(name), holders: 0, present: 0, closed: false }
      this.entries.set(name, entry)
    }
    const e = entry
    e.holders++
    if (presence && e.present++ === 0) this.hooks.presence(e.value, true)
    let released = false
    return {
      value: e.value,
      release: () => {
        if (released || e.closed) return
        released = true
        e.holders--
        if (presence && --e.present === 0 && e.holders > 0) this.hooks.presence(e.value, false)
        if (e.holders === 0) this.close(name, e)
      },
    }
  }

  /** Names open now. */
  names(): string[] {
    return [...this.entries.keys()]
  }

  /** Close every doc, whoever holds it (the page is leaving); later releases do nothing. */
  closeAll(): void {
    for (const [name, e] of [...this.entries]) this.close(name, e)
  }

  private close(name: string, e: { value: T; closed: boolean }): void {
    if (e.closed) return
    e.closed = true
    if (this.entries.get(name) === e) this.entries.delete(name)
    this.hooks.close(e.value)
  }
}
