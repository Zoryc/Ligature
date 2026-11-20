import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * "Is the app server running on this DATA_DIR?" for offline maintenance (`ligature restore`). A running
 * server rewrites a small file every HEARTBEAT_MS and removes it on a clean stop; a file fresher than
 * HEARTBEAT_FRESH_MS means a server is (or was, seconds ago) using the data. A lock file or a pid would not
 * work here: the server and the CLI run in different containers, and a crashed server leaves its lock behind.
 */

export const HEARTBEAT_FILE = 'server-heartbeat.json'
export const HEARTBEAT_MS = 10_000
export const HEARTBEAT_FRESH_MS = 30_000

export interface Heartbeat { stop(): void }

/** Start beating now and every HEARTBEAT_MS; `stop()` removes the file (call it once the database is closed). */
export function startHeartbeat(dataDir: string, everyMs = HEARTBEAT_MS): Heartbeat {
  const file = join(dataDir, HEARTBEAT_FILE)
  const startedAt = Date.now()
  let warned = false
  const beat = () => {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt, at: Date.now() }) + '\n')
    } catch (e) {
      // A full or read-only disk must not take the server down; the other checks will report it.
      if (!warned) console.error('[heartbeat] cannot write', file, e)
      warned = true
    }
  }
  beat()
  const timer = setInterval(beat, everyMs)
  timer.unref()
  return {
    stop() {
      clearInterval(timer)
      rmSync(file, { force: true })
    },
  }
}

/**
 * Milliseconds since the last heartbeat, or null when there is none. The time written in the file is used
 * (the file's mtime if it cannot be parsed, e.g. read while being written).
 */
export function heartbeatAge(dataDir: string, now = Date.now()): number | null {
  const file = join(dataDir, HEARTBEAT_FILE)
  let at: number
  try {
    at = statSync(file).mtimeMs
  } catch {
    return null
  }
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }).at
    if (typeof v === 'number' && Number.isFinite(v)) at = v
  } catch { /* keep the mtime */ }
  return now - at
}

/** True if a server beat recently. A heartbeat from the future (clock changed) counts as fresh too. */
export function isHeartbeatFresh(age: number | null): boolean {
  return age !== null && Math.abs(age) < HEARTBEAT_FRESH_MS
}
