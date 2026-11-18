import type { VersionFile, VersionKind } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import type { ThinCandidate } from './thinning.ts'

/*
 * The version store (docs/M3.md §1): rows in `versions`, `version_files`, `version_authors` and
 * `pending_authors`. Plain synchronous DB access, no events; callers run writes inside their transaction.
 * Contents live in the blob store (text as UTF-8 blobs), referenced by `version_files.blob_hash`.
 */

export interface VersionRow {
  id: string
  projectId: string
  kind: VersionKind
  label: string | null
  createdBy: string | null
  createdAt: number
  treeVersion: number
  manifestHash: string
  /** Insertion order (rowid): the tie-breaker for equal timestamps. */
  seq: number
}

const COLS = `id, project_id AS projectId, kind, label, created_by AS createdBy, created_at AS createdAt,
  tree_version AS treeVersion, manifest_hash AS manifestHash, rowid AS seq`

/** Newest first. */
const ORDER = 'ORDER BY created_at DESC, rowid DESC'

export function insertVersion(db: DB, v: Omit<VersionRow, 'seq'>, files: readonly VersionFile[], authorIds: readonly string[]): VersionRow {
  const r = db.prepare(`INSERT INTO versions (id, project_id, kind, label, created_by, created_at, tree_version, manifest_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING rowid AS seq`)
    .get(v.id, v.projectId, v.kind, v.label, v.createdBy, v.createdAt, v.treeVersion, v.manifestHash) as { seq: number }
  const insFile = db.prepare('INSERT INTO version_files (version_id, path, file_id, kind, blob_hash, size) VALUES (?, ?, ?, ?, ?, ?)')
  for (const f of files) insFile.run(v.id, f.path, f.fileId, f.kind, f.hash, f.size)
  const insAuthor = db.prepare('INSERT OR IGNORE INTO version_authors (version_id, user_id) VALUES (?, ?)')
  for (const a of authorIds) insAuthor.run(v.id, a)
  return { ...v, seq: r.seq }
}

export function latestVersion(db: DB, projectId: string): VersionRow | null {
  return (db.prepare(`SELECT ${COLS} FROM versions WHERE project_id = ? ${ORDER} LIMIT 1`).get(projectId) as VersionRow | undefined) ?? null
}

export function hasAnyVersion(db: DB, projectId: string): boolean {
  return db.prepare('SELECT 1 FROM versions WHERE project_id = ? LIMIT 1').get(projectId) !== undefined
}

/** A version of this project, or null. */
export function getVersion(db: DB, projectId: string, versionId: string): VersionRow | null {
  return (db.prepare(`SELECT ${COLS} FROM versions WHERE id = ? AND project_id = ?`).get(versionId, projectId) as VersionRow | undefined) ?? null
}

/** Up to `limit` versions, newest first, strictly older than `before` when given. */
export function listVersionRows(db: DB, projectId: string, limit: number, before?: VersionRow): VersionRow[] {
  if (!before) return db.prepare(`SELECT ${COLS} FROM versions WHERE project_id = ? ${ORDER} LIMIT ?`).all(projectId, limit) as VersionRow[]
  return db.prepare(`SELECT ${COLS} FROM versions WHERE project_id = ? AND (created_at, rowid) < (?, ?) ${ORDER} LIMIT ?`)
    .all(projectId, before.createdAt, before.seq, limit) as VersionRow[]
}

/** The version just before `v` in the same project, or null. */
export function previousVersion(db: DB, v: VersionRow): VersionRow | null {
  return listVersionRows(db, v.projectId, 1, v)[0] ?? null
}

/** Files of several versions, each list sorted by path. */
export function filesOf(db: DB, versionIds: readonly string[]): Map<string, VersionFile[]> {
  const out = new Map<string, VersionFile[]>(versionIds.map(id => [id, []]))
  if (versionIds.length === 0) return out
  const rows = db.prepare(`SELECT version_id AS v, path, file_id AS fileId, kind, size, blob_hash AS hash FROM version_files
      WHERE version_id IN (SELECT value FROM json_each(?)) ORDER BY version_id, path`)
    .all(JSON.stringify(versionIds)) as (VersionFile & { v: string })[]
  for (const { v, ...f } of rows) out.get(v)?.push(f)
  return out
}

export function fileOf(db: DB, versionId: string, path: string): VersionFile | null {
  return (db.prepare(`SELECT path, file_id AS fileId, kind, size, blob_hash AS hash FROM version_files
    WHERE version_id = ? AND path = ?`).get(versionId, path) as VersionFile | undefined) ?? null
}

/** Display names of each version's authors (sorted; accounts that no longer exist are left out). */
export function authorsOf(db: DB, versionIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(versionIds.map(id => [id, []]))
  if (versionIds.length === 0) return out
  const rows = db.prepare(`SELECT va.version_id AS v, u.display_name AS name FROM version_authors va
      JOIN users u ON u.id = va.user_id WHERE va.version_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(versionIds)) as { v: string; name: string }[]
  for (const r of rows) out.get(r.v)?.push(r.name)
  for (const list of out.values()) list.sort((a, b) => a.localeCompare(b))
  return out
}

export function setLabel(db: DB, versionId: string, label: string | null): void {
  db.prepare('UPDATE versions SET label = ? WHERE id = ?').run(label, versionId)
}

/* ---------------------------------------------------------------- pending authors */

export function addPendingAuthor(db: DB, projectId: string, userId: string): void {
  db.prepare('INSERT OR IGNORE INTO pending_authors (project_id, user_id) VALUES (?, ?)').run(projectId, userId)
}

/** The pending authors of a project, removed from the table (inside the caller's transaction). */
export function takePendingAuthors(db: DB, projectId: string): string[] {
  const ids = (db.prepare('SELECT user_id AS id FROM pending_authors WHERE project_id = ?').all(projectId) as { id: string }[]).map(r => r.id)
  db.prepare('DELETE FROM pending_authors WHERE project_id = ?').run(projectId)
  return ids
}

/* ---------------------------------------------------------------- thinning and GC (part B) */

/** Every version of a project, as input for `planThinning`. */
export function thinCandidates(db: DB, projectId: string): ThinCandidate[] {
  return db.prepare(`SELECT id, kind, label, created_at AS createdAt, rowid AS seq FROM versions WHERE project_id = ?`)
    .all(projectId) as ThinCandidate[]
}

/**
 * Delete versions of one project (inside a transaction). The authors of a deleted version are carried
 * over to the next newer version that stays, so "who changed something since the previous version"
 * remains true after thinning. Returns the number deleted.
 */
export function deleteVersions(db: DB, projectId: string, ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const doomed = new Set(ids)
  const all = db.prepare(`SELECT id FROM versions WHERE project_id = ? ORDER BY created_at ASC, rowid ASC`).all(projectId) as { id: string }[]
  const carry = db.prepare(`INSERT OR IGNORE INTO version_authors (version_id, user_id)
    SELECT ?, user_id FROM version_authors WHERE version_id = ?`)
  for (let i = 0; i < all.length; i++) {
    const id = all[i]!.id
    if (!doomed.has(id)) continue
    const next = all.slice(i + 1).find(r => !doomed.has(r.id))
    if (next) carry.run(next.id, id)
  }
  const del = db.prepare('DELETE FROM versions WHERE id = ? AND project_id = ?')
  let n = 0
  for (const id of doomed) n += del.run(id, projectId).changes
  return n
}

/** Every blob hash any version refers to (the GC's "referenced by a version" set). */
export function versionBlobHashes(db: DB): Set<string> {
  return new Set((db.prepare('SELECT DISTINCT blob_hash AS h FROM version_files').all() as { h: string }[]).map(r => r.h))
}

/** True if some version refers to this blob. */
export function isBlobInVersions(db: DB, hash: string): boolean {
  return db.prepare('SELECT 1 FROM version_files WHERE blob_hash = ? LIMIT 1').get(hash) !== undefined
}

/** Ids of live projects with at least one version (for the GC's thinning pass). */
export function projectsWithVersions(db: DB): string[] {
  return (db.prepare('SELECT DISTINCT project_id AS id FROM versions').all() as { id: string }[]).map(r => r.id)
}
