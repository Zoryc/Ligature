import { statSync } from 'node:fs'
import type { GcReport, StorageReport } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import { FORMER_MEMBER } from '../auth/users.ts'

/*
 * GET /api/admin/storage (docs/M3.md §5). Numbers come from the database (blob sizes as recorded), so the
 * report is cheap; the GC walks the disk.
 */

const fileSize = (path: string) => { try { return statSync(path).size } catch { return 0 } }

/** Main database file plus its write-ahead log. */
export function databaseBytes(db: DB): number {
  if (db.memory) return 0
  return fileSize(db.name) + fileSize(`${db.name}-wal`)
}

/** The text mirror of each text file's current generation, in UTF-8 bytes (joined on its doc name). */
const TEXT_BYTES = `(SELECT length(CAST(ds.text AS BLOB)) FROM doc_state ds
  WHERE ds.doc_name = 'proj/' || f.project_id || '/file/' || f.id || '/g' || f.epoch)`

export function storageReport(db: DB, lastGc: GcReport | null): StorageReport {
  const blobs = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM blobs').get() as { count: number; bytes: number }
  const unreferenced = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM blobs
    WHERE hash NOT IN (SELECT blob_hash FROM files WHERE blob_hash IS NOT NULL)
      AND hash NOT IN (SELECT blob_hash FROM version_files)`).get() as { count: number; bytes: number }
  // No owner row: the owner's account was deleted (memberships cascade; only its soft-deleted projects keep none).
  const projects = db.prepare(`
    SELECT p.id, p.name, COALESCE(u.display_name, ?) AS owner, p.deleted_at IS NOT NULL AS deleted,
      COALESCE(s.liveFiles, 0) AS liveFiles, COALESCE(s.liveBytes, 0) AS liveBytes, COALESCE(s.trashBytes, 0) AS trashBytes,
      (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS versions
    FROM projects p
    LEFT JOIN project_members m ON m.project_id = p.id AND m.role = 'owner'
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN (
      SELECT project_id,
        SUM(deleted_at IS NULL) AS liveFiles,
        SUM(CASE WHEN deleted_at IS NULL THEN bytes ELSE 0 END) AS liveBytes,
        SUM(CASE WHEN deleted_at IS NOT NULL THEN bytes ELSE 0 END) AS trashBytes
      FROM (SELECT f.project_id, f.deleted_at,
              CASE WHEN f.kind = 'text' THEN COALESCE(${TEXT_BYTES}, f.size, 0) ELSE COALESCE(f.size, 0) END AS bytes
            FROM files f WHERE f.kind <> 'folder')
      GROUP BY project_id) s ON s.project_id = p.id
    ORDER BY liveBytes + trashBytes DESC, p.name`).all(FORMER_MEMBER) as (Omit<StorageReport['projects'][number], 'deleted'> & { deleted: number })[]
  return {
    databaseBytes: databaseBytes(db),
    blobs,
    unreferenced,
    projects: projects.map(p => ({ ...p, deleted: p.deleted === 1 })),
    lastGc,
  }
}
