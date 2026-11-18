import { performance } from 'node:perf_hooks'
import type { GcReport } from '@ligature/shared'
import { sweepTrash } from '../files/trash.ts'
import type { Services } from '../services.ts'
import { sweepBlobs, type SweepOptions } from './blobSweep.ts'
import { removeOrphanDocs } from './orphanDocs.ts'
import { purgeDeletedProjects } from './purge.ts'

/*
 * One garbage-collection pass (docs/M3.md §3), in an order where each step can free what the next one
 * collects: purge expired soft-deleted projects, the trash retention sweep, version thinning, orphan doc
 * rows, then the blob mark-and-sweep.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export interface GcConfig {
  /** Blobs and doc rows written this recently are never collected (24 h). */
  graceMs: number
  /** Soft-deleted projects are purged this long after deletion (30 days; env PROJECT_RETENTION_DAYS). */
  projectRetentionMs: number
  /** The scheduled GC runs when the last run is at least this old (24 h). */
  intervalMs: number
  /** How often the scheduler checks whether a run is due (1 h). */
  checkMs: number
  /** First check after startup (10 min), so a restart does not start with a sweep. */
  startupDelayMs: number
}

export const DEFAULT_GC_CONFIG: GcConfig = {
  graceMs: DAY,
  projectRetentionMs: 30 * DAY,
  intervalMs: DAY,
  checkMs: HOUR,
  startupDelayMs: 10 * 60 * 1000,
}

export interface GcContext {
  services: Services
  outputsDir: string
  config: GcConfig
}

export type GcHooks = SweepOptions

export async function collectGarbage(ctx: GcContext, now: number, hooks: GcHooks = {}): Promise<GcReport> {
  const s = ctx.services
  const t0 = performance.now()
  const projectsPurged = await purgeDeletedProjects(s, ctx.outputsDir, now, ctx.config.projectRetentionMs)
  const trashBatches = await sweepTrash(s, now)
  const versionsThinned = s.db.open ? s.history.thinAll(now) : 0
  const loaded = s.collab.hocuspocus
  const orphanDocsRemoved = s.db.open
    ? removeOrphanDocs(s.db, now - ctx.config.graceMs, n => loaded.documents.has(n) || loaded.loadingDocuments.has(n))
    : 0
  const sweep = await sweepBlobs(s.db, s.blobs.dir, now, ctx.config.graceMs, hooks)
  const report: GcReport = {
    at: now,
    durationMs: Math.round(performance.now() - t0),
    blobsRemoved: sweep.removed,
    bytesFreed: sweep.bytesFreed,
    orphanDocsRemoved,
    versionsThinned,
    projectsPurged,
  }
  console.log(`[gc] ${JSON.stringify({ ...report, trashBatches, blobsScanned: sweep.scanned, danglingRows: sweep.danglingRows, tempFiles: sweep.tempFiles })}`)
  return report
}
