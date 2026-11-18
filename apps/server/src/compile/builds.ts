import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { BuildResult } from '@ligature/shared'
import { isUuid } from '../services.ts'

/*
 * Per-build bookkeeping on disk: `<outputs>/<projectId>/<buildId>/build.json` holds the full BuildResult
 * plus the build's path map; `<outputs>/<projectId>/latest` names the most recent finished build.
 */

export interface BuildRecord extends BuildResult {
  /** Project-relative path -> file id, for every file the build was made from. */
  paths: Record<string, string>
  finishedAt: number
}

export const buildDir = (outputsDir: string, projectId: string, buildId: string) => join(outputsDir, projectId, buildId)

/** Write build.json, then point `latest` at it (atomic rename, so readers never see a partial file). */
export function writeBuildRecord(outputsDir: string, projectId: string, rec: BuildRecord): void {
  const dir = buildDir(outputsDir, projectId, rec.buildId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'build.json'), JSON.stringify(rec))
  atomicWrite(join(outputsDir, projectId, 'latest'), rec.buildId)
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, file)
  } catch {
    rmSync(tmp, { force: true })
    writeFileSync(file, data)
  }
}

export function readBuildRecord(outputsDir: string, projectId: string, buildId: string): BuildRecord | null {
  if (!isUuid(projectId) || !isUuid(buildId)) return null
  try {
    return JSON.parse(readFileSync(join(buildDir(outputsDir, projectId, buildId), 'build.json'), 'utf8')) as BuildRecord
  } catch {
    return null
  }
}

export function latestBuildRecord(outputsDir: string, projectId: string): BuildRecord | null {
  if (!isUuid(projectId)) return null
  let id: string
  try { id = readFileSync(join(outputsDir, projectId, 'latest'), 'utf8').trim() } catch { return null }
  return readBuildRecord(outputsDir, projectId, id)
}

/** The contract shape (the record minus server-only bookkeeping). */
export function toBuildResult(rec: BuildRecord): BuildResult {
  const { buildId, status, durationMs, log, hasPdf, diagnostics, startedBy, snapshot } = rec
  return { buildId, status, durationMs, log, hasPdf, diagnostics, startedBy, snapshot }
}

/** Max unzipped size of a synctex file we are willing to parse (docs/M2.md §3). */
export const MAX_SYNCTEX_BYTES = 50 * 1024 * 1024

export interface BuildSynctex {
  /** Raw `output.synctex.gz` bytes. */
  gz: Buffer
  /** The build's path map: project-relative path -> file id. */
  paths: Record<string, string>
}

/**
 * Stage-2 seam for the SyncTeX routes: a build's synctex.gz and path map, or null when the build or
 * its synctex output is missing.
 */
export function loadBuildSynctex(outputsDir: string, projectId: string, buildId: string): BuildSynctex | null {
  const rec = readBuildRecord(outputsDir, projectId, buildId)
  if (!rec) return null
  const file = join(buildDir(outputsDir, projectId, buildId), 'output.synctex.gz')
  if (!existsSync(file)) return null
  try {
    return { gz: readFileSync(file), paths: rec.paths }
  } catch {
    return null
  }
}

/** Gunzip a synctex file, refusing more than `maxBytes` of output (throws RangeError). */
export function gunzipSynctex(gz: Buffer, maxBytes = MAX_SYNCTEX_BYTES): string {
  return gunzipSync(gz, { maxOutputLength: maxBytes }).toString('utf8')
}
