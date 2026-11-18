import { Worker } from 'node:worker_threads'
import type { SynctexIndex } from '@ligature/synctex'
import type { ParseReply, ParseRequest } from './synctexWorker.ts'

/**
 * One worker thread that gunzips and parses SyncTeX files, so a large file never blocks the event loop.
 * Requests are served one at a time in order; the worker is started on first use, and restarted after
 * a crash (pending requests then fail). `unref`'d: it never keeps the process alive.
 */
export class SynctexParsePool {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (i: SynctexIndex | null) => void; reject: (e: Error) => void }>()

  /** Requests sent and not answered yet. */
  get size(): number {
    return this.pending.size
  }

  /** The parsed index, or null when the file is unusable (too large, not gzip, not SyncTeX). */
  parse(gz: Uint8Array, maxBytes: number, maxRecords?: number): Promise<SynctexIndex | null> {
    const w = this.ensure()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const req: ParseRequest = { id, gz, maxBytes, ...(maxRecords !== undefined ? { maxRecords } : {}) }
      w.postMessage(req)
    })
  }

  async close(): Promise<void> {
    const w = this.worker
    this.worker = null
    this.fail(new Error('SyncTeX parser closed'))
    if (w) await w.terminate()
  }

  private ensure(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./synctexWorker.ts', import.meta.url))
    w.unref()
    w.on('message', (m: ParseReply) => {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      p.resolve('index' in m ? m.index : null)
    })
    const crashed = (e: Error) => {
      if (this.worker !== w) return
      this.worker = null
      this.fail(e)
    }
    w.on('error', crashed)
    w.on('exit', code => crashed(new Error(`SyncTeX parser exited (${code})`)))
    this.worker = w
    return w
  }

  private fail(e: Error): void {
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const p of all) p.reject(e)
  }
}
