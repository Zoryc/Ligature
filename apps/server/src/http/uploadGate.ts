/**
 * Bounded concurrency for reading upload bodies: at most `perUser` uploads per user and `total` per
 * process are buffered at once. Others wait in FIFO order before a single byte of their body is read,
 * so they cost a socket, not memory (TCP backpressure holds the rest).
 */
export class UploadGate {
  private active = 0
  private readonly byUser = new Map<string, number>()
  private readonly waiting: { userId: string; grant: () => void }[] = []

  constructor(readonly total: number, readonly perUser: number) {}

  private canRun(userId: string): boolean {
    return this.active < this.total && (this.byUser.get(userId) ?? 0) < this.perUser
  }

  private take(userId: string): () => void {
    this.active++
    this.byUser.set(userId, (this.byUser.get(userId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const n = (this.byUser.get(userId) ?? 1) - 1
      if (n === 0) this.byUser.delete(userId)
      else this.byUser.set(userId, n)
      this.pump()
    }
  }

  private pump(): void {
    for (let i = 0; i < this.waiting.length && this.active < this.total;) {
      const w = this.waiting[i]!
      if (this.canRun(w.userId)) {
        this.waiting.splice(i, 1)
        w.grant()
      } else i++
    }
  }

  /** Wait for a slot; returns the (idempotent) release function. */
  acquire(userId: string): Promise<() => void> {
    if (this.canRun(userId) && this.waiting.length === 0) return Promise.resolve(this.take(userId))
    return new Promise(resolve => {
      this.waiting.push({ userId, grant: () => resolve(this.take(userId)) })
      this.pump()
    })
  }

  get stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length }
  }
}
