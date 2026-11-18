import type { GcReport, StorageReport } from '@ligature/shared'
import { audit } from '../audit.ts'
import type { Services } from '../services.ts'
import { collectGarbage, DEFAULT_GC_CONFIG, type GcConfig, type GcHooks } from './gc.ts'
import { storageReport } from './storage.ts'

/*
 * Storage maintenance (docs/M3.md §3, §5): the GC, run daily by a scheduler and on demand by an admin,
 * never twice at once (a request during a run joins it); the last report is kept in `instance_settings`
 * so it survives restarts and tells the scheduler when the last run was.
 */

const LAST_REPORT_KEY = 'gc.lastReport'

export interface MaintenanceDeps {
  services: Services
  /** Build outputs (`<dataDir>/outputs`), removed with purged projects. */
  outputsDir: string
  clock: () => number
  config?: Partial<GcConfig>
}

export function createMaintenance(d: MaintenanceDeps) {
  const { db } = d.services
  const config: GcConfig = { ...DEFAULT_GC_CONFIG, ...d.config }
  let running: Promise<GcReport> | null = null
  let first: NodeJS.Timeout | null = null
  let timer: NodeJS.Timeout | null = null

  function lastReport(): GcReport | null {
    if (!db.open) return null
    const row = db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(LAST_REPORT_KEY) as { value: string } | undefined
    if (!row) return null
    try { return JSON.parse(row.value) as GcReport } catch { return null }
  }

  function saveReport(r: GcReport): void {
    db.prepare(`INSERT INTO instance_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(LAST_REPORT_KEY, JSON.stringify(r))
  }

  /** Run the GC now, or join the run in progress. `actorId`: the admin who asked (null: the scheduler). */
  function runGc(o: { actorId?: string | null; hooks?: GcHooks } = {}): Promise<GcReport> {
    if (running) return running
    const run = (async () => {
      const report = await collectGarbage({ services: d.services, outputsDir: d.outputsDir, config }, d.clock(), o.hooks)
      if (db.open) {
        db.transaction(() => {
          saveReport(report)
          audit(db, { actorId: o.actorId ?? null, action: 'gc.run', detail: { ...report, trigger: o.actorId ? 'admin' : 'schedule' } })
        })()
      }
      return report
    })()
    running = run
    const clear = () => { if (running === run) running = null }
    run.then(clear, clear)
    return run
  }

  /** Scheduler check: run when the last run is `intervalMs` old (or there never was one). */
  function runIfDue(): void {
    if (!db.open || running) return
    const last = lastReport()
    if (last && d.clock() - last.at < config.intervalMs) return
    runGc().catch(e => { if (db.open) console.error('[gc] failed', e) })
  }

  return {
    config,
    runGc,
    runIfDue,
    lastReport,
    isRunning: () => running !== null,
    storage: (): StorageReport => storageReport(db, lastReport()),
    start(): void {
      if (timer) return
      first = setTimeout(runIfDue, config.startupDelayMs)
      first.unref()
      timer = setInterval(runIfDue, config.checkMs)
      timer.unref()
    },
    /** Stop the scheduler and wait for a run in progress (its steps stop early once the database closes). */
    async stop(): Promise<void> {
      if (first) clearTimeout(first)
      if (timer) clearInterval(timer)
      first = timer = null
      await running?.catch(() => undefined)
    },
  }
}

export type Maintenance = ReturnType<typeof createMaintenance>
