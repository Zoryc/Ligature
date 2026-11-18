import { can, fileDocName, type TreeEntry } from '@ligature/shared'
import { ApiError, notFound } from '../errors.ts'
import type { Services } from '../services.ts'
import type { SessionUser } from '../auth/sessions.ts'
import { getFile, liveFiles, toTreeEntry, type FileRow } from '../projects/repo.ts'
import { requireRole, touchProject, type Access } from '../projects/service.ts'
import { BlobStore } from './blobStore.ts'
import { classifyUpload } from './classify.ts'
import { assertCapacity, assertPathsValid, insertNode, nameTaken, requireFolder, siblingNamed, validName } from './tree.ts'

type Phase1 =
  | { done: FileRow; treeVersion: number | null }
  | { replaceText: FileRow; text: string }

/**
 * POST /projects/:id/upload. Creates a file, or replaces a live file of the same name in that folder:
 * text→text as a minimal diff on the live Yjs doc, binary→binary as a new blob, otherwise `409 kind-mismatch`.
 */
export async function uploadFile(s: Services, actor: SessionUser, a: Access, parentId: string | undefined, rawName: string | undefined,
  bytes: Uint8Array): Promise<TreeEntry> {
  requireRole(a, can.edit)
  const name = validName(rawName ?? '')
  const cls = classifyUpload(name, bytes)
  const blobHash = cls.kind === 'binary' ? BlobStore.hashOf(bytes) : null

  // The blob is written inside the transaction, only after every check passed (parent, name, kind,
  // capacity), so a refused upload leaves nothing on disk. `put` is synchronous (write, fsync, rename),
  // so nothing else in this process can interleave between the write and the commit.
  let createdBlob = false
  const storeBlob = (): void => {
    if (blobHash === null) return
    createdBlob = !s.blobs.has(blobHash)
    s.blobs.put(bytes, blobHash)
  }

  let p1: Phase1
  try {
    p1 = s.db.transaction((): Phase1 => {
      const rows = liveFiles(s.db, a.projectId)
      const parent = requireFolder(rows, parentId)
      const existing = siblingNamed(rows, parent.id, name)
      if (existing) {
        if (existing.kind === 'folder' || existing.name !== name) throw nameTaken()
        if (existing.kind !== cls.kind) {
          throw new ApiError(409, 'kind-mismatch', `"${name}" is a ${existing.kind} file; the upload is ${cls.kind}`)
        }
        if (cls.kind === 'text') return { replaceText: existing, text: cls.text }
        assertCapacity(s, rows, 0, bytes.byteLength - (existing.size ?? 0))
        storeBlob()
        s.db.prepare('UPDATE files SET blob_hash = ?, size = ?, updated_at = ? WHERE id = ?')
          .run(blobHash, bytes.byteLength, Date.now(), existing.id)
        return { done: { ...existing, blobHash, size: bytes.byteLength }, treeVersion: touchProject(s.db, a.projectId, true) }
      }
      assertPathsValid([...rows, { id: 'new', parentId: parent.id, name }], ['new'])
      assertCapacity(s, rows, 1, cls.kind === 'binary' ? bytes.byteLength : 0)
      storeBlob()
      const row = cls.kind === 'text'
        ? insertNode(s, a.projectId, { parentId: parent.id, name, kind: 'text', text: cls.text })
        : insertNode(s, a.projectId, { parentId: parent.id, name, kind: 'binary', blobHash: blobHash!, size: bytes.byteLength })
      return { done: row, treeVersion: touchProject(s.db, a.projectId, true) }
    }).immediate()
  } catch (e) {
    // Rolled back after the blob was written (e.g. a constraint failure): drop the file again.
    if (createdBlob && blobHash !== null) s.blobs.discardUnrecorded(blobHash)
    throw e
  }

  if ('done' in p1) {
    if (p1.treeVersion !== null) s.collab.broadcast(a.projectId, { type: 'tree-changed', treeVersion: p1.treeVersion })
    return toTreeEntry(p1.done)
  }

  const f = p1.replaceText
  await s.collab.replaceText(fileDocName(a.projectId, f.id, f.epoch), p1.text, actor.id)
  const stillLive = s.db.transaction(() => {
    // The file may have been deleted while the doc was being opened: report that instead of success.
    const cur = getFile(s.db, f.id)
    if (!cur || cur.deletedAt !== null) return false
    s.db.prepare('UPDATE files SET size = ?, updated_at = ? WHERE id = ?').run(Buffer.byteLength(p1.text), Date.now(), f.id)
    touchProject(s.db, a.projectId, false)
    return true
  }).immediate()
  if (!stillLive) throw notFound('The file was deleted')
  return toTreeEntry(f)
}
