import { parseDocName } from '@ligature/shared'
import type { DB } from '../db/index.ts'

/*
 * Orphan doc rows (docs/M3.md §3): `doc_state` / `doc_updates` rows of a file doc that no file refers to —
 * the file row does not exist, is not a text file of that project, or has moved on to another generation
 * (epoch). Left behind by crashes (an import writes its doc states before its file rows; a rebuild or purge
 * interrupted). Rows touched after `cutoff` are spared: an import in progress writes them minutes before
 * its file rows. Docs loaded in this process are never touched. Names that are not file docs are left alone.
 */

export function removeOrphanDocs(db: DB, cutoff: number, isLoaded: (docName: string) => boolean): number {
  const rows = db.prepare(`
    SELECT doc_name AS name, MAX(at) AS at FROM (
      SELECT doc_name, updated_at AS at FROM doc_state
      UNION ALL SELECT doc_name, MAX(ts) FROM doc_updates GROUP BY doc_name)
    GROUP BY doc_name`).all() as { name: string; at: number }[]
  if (rows.length === 0) return 0
  const fileOf = db.prepare('SELECT project_id AS projectId, kind, epoch FROM files WHERE id = ?')
  const orphans: string[] = []
  for (const r of rows) {
    const ref = parseDocName(r.name)
    if (ref?.kind !== 'file' || r.at > cutoff || isLoaded(r.name)) continue
    const f = fileOf.get(ref.fileId) as { projectId: string; kind: string; epoch: number } | undefined
    if (f && f.projectId === ref.projectId && f.kind === 'text' && f.epoch === ref.epoch) continue
    orphans.push(r.name)
  }
  if (orphans.length === 0) return 0
  const delState = db.prepare('DELETE FROM doc_state WHERE doc_name = ?')
  const delLog = db.prepare('DELETE FROM doc_updates WHERE doc_name = ?')
  db.transaction(() => { for (const n of orphans) { delState.run(n); delLog.run(n) } })()
  return orphans.length
}
