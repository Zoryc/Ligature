import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { audit } from '../audit.ts'
import { isUuid, type Services } from '../services.ts'

/*
 * Purge of soft-deleted projects (docs/M3.md §3): projects deleted at least `retentionMs` ago are removed
 * for good — files (live and trashed), their docs, versions, members, invites, pending authors, and the
 * build outputs on disk. Blobs are left to the sweep that follows. The audit log keeps its rows.
 */

/** Doc names of one project form the range [`proj/<id>/`, `proj/<id>0`) ('0' follows '/'). */
function deleteProjectDocs(s: Services, projectId: string): void {
  const lo = `proj/${projectId}/`
  const hi = `proj/${projectId}0`
  s.db.prepare('DELETE FROM doc_state WHERE doc_name >= ? AND doc_name < ?').run(lo, hi)
  s.db.prepare('DELETE FROM doc_updates WHERE doc_name >= ? AND doc_name < ?').run(lo, hi)
}

/** Returns the number of projects purged. */
export async function purgeDeletedProjects(s: Services, outputsDir: string, now: number, retentionMs: number): Promise<number> {
  const due = s.db.prepare('SELECT id, name, deleted_at AS deletedAt FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
    .all(now - retentionMs) as { id: string; name: string; deletedAt: number }[]
  let n = 0
  for (const p of due) {
    if (!s.db.open) break
    // Deleting a project closes its sockets and unloads its docs; should one still be loaded, unload it first.
    const loaded = [...s.collab.hocuspocus.documents.keys()].filter(d => d.startsWith(`proj/${p.id}/`))
    if (loaded.length > 0) {
      s.collab.closeProjectConnections(p.id, 'project-deleted')
      await Promise.all(loaded.map(d => s.collab.unloadDoc(d)))
    }
    const purged = s.db.transaction(() => {
      const still = s.db.prepare('SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?').get(p.id, now - retentionMs)
      if (!still) return false
      deleteProjectDocs(s, p.id)
      s.db.prepare('DELETE FROM pending_authors WHERE project_id = ?').run(p.id)
      // versions (and their files/authors), members, invites cascade; all file rows go in one statement
      // (their parent references are checked at the end of it).
      s.db.prepare('DELETE FROM files WHERE project_id = ?').run(p.id)
      s.db.prepare('DELETE FROM projects WHERE id = ?').run(p.id)
      audit(s.db, { actorId: null, projectId: p.id, action: 'project.purge', detail: { name: p.name, deletedAt: p.deletedAt } })
      return true
    }).immediate()
    if (!purged) continue
    n++
    if (isUuid(p.id)) {
      await rm(join(outputsDir, p.id), { recursive: true, force: true }).catch(e => console.error('[gc] could not remove build outputs', e))
    }
  }
  return n
}
