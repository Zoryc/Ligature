import { randomUUID } from 'node:crypto'
import { can, fileDocName, type FileKind, type RestoreVersionRequest, type RestoreVersionResponse, type VersionFile } from '@ligature/shared'
import { audit } from '../audit.ts'
import { ApiError, badRequest, notFound } from '../errors.ts'
import type { Services } from '../services.ts'
import type { SessionUser } from '../auth/sessions.ts'
import { TEXT_KEY } from '../collab/docStore.ts'
import { getFile } from '../projects/repo.ts'
import { requireAccess, requireRole, touchProject, type Access } from '../projects/service.ts'
import { assertPathsValid, insertNode } from '../files/tree.ts'
import { filesOf } from './store.ts'
import { requireVersion } from './service.ts'

/*
 * Restoring a version (docs/M3.md §2), one operation serialized per project:
 *  1. a `pre_restore` version (the undo point);
 *  2. one transaction for the tree: files of the version that are live are moved back to their path,
 *     trashed ones come back from the trash, purged ones are re-created (new id); whatever occupies a
 *     target path goes to the trash; a whole-project restore also trashes the live files the version
 *     doesn't have; binaries get their blob hash back;
 *  3. text contents are applied to the live docs as minimal diffs (never replacing a Y.Doc), credited
 *     to the caller;
 *  4. events (tree-changed, trash-changed, version-restored) and the audit log.
 * Every check (limits, paths, contents present) runs before anything changes.
 */

interface Row {
  id: string
  parentId: string | null
  name: string
  kind: FileKind
  epoch: number
  blobHash: string | null
  size: number | null
  deletedAt: number | null
  wasMain: number
  /** Trash: the row's parent was purged (its parent_id points at the root). */
  orphan: number
  batch: string | null
}

type Mode = 'live' | 'trash' | 'create'

interface Subject {
  vf: VersionFile
  mode: Mode
  /** Final id (the version's file id, or a new one for re-created files). */
  id: string
  /** The existing row (live or trashed). */
  row: Row | null
  parentId: string
  name: string
}

/** A node of the tree as it will be after the restore. */
interface Node { id: string; parentId: string | null; name: string; kind: FileKind; size: number | null }

export interface RestorePlan {
  subjects: Subject[]
  /** Folders to create, parents first. */
  folders: Node[]
  /** Trashed folders that come back (ancestors of trashed files being restored), parents first. */
  revived: Node[]
  /** Live rows that go to the trash, grouped by trash batch (one batch per top-level item). */
  batches: { top: string; ids: string[] }[]
  /** Files among the trashed rows. */
  trashedFiles: number
}

const lower = (s: string) => s.toLowerCase()

/**
 * Plan a restore over the project's rows (pure; throws the API error that refuses the restore).
 * `whole`: files the version doesn't have go to the trash.
 */
export function planRestore(rows: readonly Row[], files: readonly VersionFile[], whole: boolean,
  limits: { maxFiles: number; maxBinaryBytes: number }): RestorePlan {
  const root = rows.find(r => r.parentId === null && r.deletedAt === null)
  if (!root) throw notFound()
  const byId = new Map(rows.map(r => [r.id, r]))

  const subjects: Subject[] = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(vf => {
    const row = byId.get(vf.fileId)
    const usable = row !== undefined && row.kind === vf.kind && row.parentId !== null
    const mode: Mode = !usable ? 'create' : row.deletedAt === null ? 'live' : 'trash'
    return { vf, mode, id: mode === 'create' ? randomUUID() : vf.fileId, row: usable ? row : null, parentId: '', name: '' }
  })
  const subjectIds = new Set(subjects.filter(x => x.mode !== 'create').map(x => x.id))

  // The final tree, starting from the live rows that are not being restored ("others").
  const nodes = new Map<string, Node>()
  for (const r of rows) {
    if (r.deletedAt === null && !subjectIds.has(r.id)) nodes.set(r.id, { id: r.id, parentId: r.parentId, name: r.name, kind: r.kind, size: r.size })
  }
  const kids = new Map<string, Map<string, string>>() // parent id -> lower name -> id
  const index = (n: Node) => {
    if (n.parentId === null) return
    let m = kids.get(n.parentId)
    if (!m) kids.set(n.parentId, m = new Map())
    m.set(lower(n.name), n.id)
  }
  for (const n of nodes.values()) index(n)
  const children = (id: string) => [...(kids.get(id)?.values() ?? [])]

  const evicted = new Set<string>()
  const created = new Set<string>()
  const evict = (id: string) => {
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()!
      if (evicted.has(cur)) continue
      evicted.add(cur)
      const n = nodes.get(cur)!
      kids.get(n.parentId!)?.delete(lower(n.name))
      stack.push(...children(cur))
    }
  }
  const lookup = (parentId: string, name: string) => {
    const id = kids.get(parentId)?.get(lower(name))
    return id === undefined ? undefined : nodes.get(id)
  }

  /** Trashed folders above a trashed row, nearest first (stops at a live row or a purged parent). */
  const trashedAncestors = (r: Row): Row[] => {
    const out: Row[] = []
    for (let cur = r; cur.orphan === 0 && cur.parentId !== null && out.length < 64;) {
      const parent = byId.get(cur.parentId)
      if (!parent || parent.deletedAt === null || parent.kind !== 'folder') break
      out.push(parent)
      cur = parent
    }
    return out
  }

  const folders: Node[] = []
  const revived: Node[] = []
  for (const sub of subjects) {
    const segs = sub.vf.path.split('/')
    const ancestors = sub.mode === 'trash' ? trashedAncestors(sub.row!) : []
    let parent = root.id
    for (const seg of segs.slice(0, -1)) {
      const occ = lookup(parent, seg)
      if (occ?.kind === 'folder') { parent = occ.id; continue }
      if (occ) evict(occ.id) // a file where the version has a folder
      // A trashed file comes back with the trashed folder it sits in, if that folder belongs here.
      const back = ancestors.find(r => r.parentId === parent && lower(r.name) === lower(seg) && !nodes.has(r.id))
      const f: Node = { id: back?.id ?? randomUUID(), parentId: parent, name: seg, kind: 'folder', size: null }
      nodes.set(f.id, f)
      index(f)
      created.add(f.id)
      ;(back ? revived : folders).push(f)
      parent = f.id
    }
    const name = segs[segs.length - 1]!
    const occ = lookup(parent, name)
    if (occ) evict(occ.id) // name clash: the occupant goes to the trash
    sub.parentId = parent
    sub.name = name
    const n: Node = { id: sub.id, parentId: parent, name, kind: sub.vf.kind, size: sub.vf.kind === 'binary' ? sub.vf.size : null }
    nodes.set(n.id, n)
    index(n)
    created.add(n.id)
  }

  if (whole) {
    // Files the version doesn't have…
    for (const n of [...nodes.values()]) {
      if (n.kind !== 'folder' && !created.has(n.id) && !evicted.has(n.id)) evict(n.id)
    }
    // …and the folders left holding nothing but trashed files (folders that were empty already stay).
    const trashedUnder = new Set<string>()
    for (const id of evicted) {
      for (let p = nodes.get(id)!.parentId; p !== null; p = nodes.get(p)?.parentId ?? null) trashedUnder.add(p)
    }
    const keeps = new Map<string, boolean>() // folder -> something live stays in its subtree
    const walk = (id: string): boolean => {
      let keep = created.has(id)
      for (const c of children(id)) keep = (nodes.get(c)!.kind === 'folder' ? walk(c) : true) || keep
      keeps.set(id, keep)
      return keep
    }
    walk(root.id)
    for (const [id, keep] of keeps) {
      if (!keep && id !== root.id && !evicted.has(id) && trashedUnder.has(id)) evict(id)
    }
  }

  // Limits on the final tree (root excluded).
  const final = [...nodes.values()].filter(n => !evicted.has(n.id))
  const binary = final.reduce((x, n) => x + (n.kind === 'binary' ? n.size ?? 0 : 0), 0)
  if (final.length - 1 > limits.maxFiles || binary > limits.maxBinaryBytes) {
    throw new ApiError(413, 'project-too-large', `Projects are limited to ${limits.maxFiles} files and ${Math.round(limits.maxBinaryBytes / 1048576)} MB of binary files`)
  }
  assertPathsValid(final, [...created])

  // One trash batch per top-level trashed item (an M2 batch has exactly one top item).
  const evictedKids = new Map<string, string[]>()
  for (const id of evicted) {
    const p = nodes.get(id)!.parentId
    if (p === null || !evicted.has(p)) continue
    const list = evictedKids.get(p)
    if (list) list.push(id)
    else evictedKids.set(p, [id])
  }
  const batches: RestorePlan['batches'] = []
  for (const id of evicted) {
    const p = nodes.get(id)!.parentId
    if (p !== null && evicted.has(p)) continue
    const ids: string[] = []
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()!
      ids.push(cur)
      stack.push(...(evictedKids.get(cur) ?? []))
    }
    batches.push({ top: id, ids })
  }
  const trashedFiles = [...evicted].filter(id => nodes.get(id)!.kind !== 'folder').length
  return { subjects, folders, revived, batches, trashedFiles }
}

const ROW_COLS = `id, parent_id AS parentId, name, kind, epoch, blob_hash AS blobHash, size, deleted_at AS deletedAt,
  was_main AS wasMain, trash_orphan AS orphan, delete_batch AS batch`

/**
 * POST /projects/:id/versions/:versionId/restore. The whole project, or only `paths` (paths in the version).
 */
export async function restoreVersion(s: Services, actor: SessionUser, a: Access, versionId: string | undefined,
  req: RestoreVersionRequest): Promise<RestoreVersionResponse> {
  requireRole(a, can.edit)
  requireVersion(s.db, a, versionId)
  return s.history.withProjectLock(a.projectId, () => restoreLocked(s, actor, a, versionId!, req))
}

async function restoreLocked(s: Services, actor: SessionUser, queued: Access, versionId: string, req: RestoreVersionRequest): Promise<RestoreVersionResponse> {
  const { db } = s
  // Everything may have changed while we waited for the lock: the caller removed or demoted, the
  // project deleted (404), the version thinned. Check again, synchronously with what follows.
  const a = requireAccess(db, queued.projectId, actor.id)
  requireRole(a, can.edit)
  const version = requireVersion(db, a, versionId)
  const all = filesOf(db, [version.id]).get(version.id) ?? []
  let files = all
  if (req.paths !== undefined) {
    const byPath = new Map(all.map(f => [f.path, f]))
    const wanted = [...new Set(req.paths)]
    const missing = wanted.find(p => !byPath.has(p))
    if (missing !== undefined) throw badRequest(`Not a file of this version: ${missing}`)
    files = wanted.map(p => byPath.get(p)!)
  }
  for (const f of files) {
    if (!s.blobs.has(f.hash)) throw new ApiError(409, 'content-missing', `The content of ${f.path} in this version is missing`)
  }

  // Synchronous from here to the end of the tree transaction: nothing can interleave.
  const rows = db.prepare(`SELECT ${ROW_COLS} FROM files WHERE project_id = ?`).all(a.projectId) as Row[]
  const plan = planRestore(rows, files, req.paths === undefined, s.limits)
  const when = version.label ?? new Date(version.createdAt).toISOString().slice(0, 16).replace('T', ' ')
  const pre = s.history.takeVersion(a.projectId, 'pre_restore', { label: `Before restoring "${when}"`, createdBy: actor.id })!

  const tx = db.transaction(() => {
    const now = Date.now()
    const tmpName = (id: string) => `${id}.restoring`
    const moving = plan.subjects.filter(x => x.mode === 'live' && (x.row!.parentId !== x.parentId || x.row!.name !== x.name))
    const setName = db.prepare('UPDATE files SET name = ? WHERE id = ?')
    // Out of the way first, so swaps and clashes never trip the unique-name index.
    for (const x of moving) setName.run(tmpName(x.id), x.id)

    // To the trash: one batch per top-level item, deleted by the caller.
    const del = db.prepare('UPDATE files SET deleted_at = ?, updated_at = ?, deleted_by = ?, delete_batch = ? WHERE id = ?')
    const trashed = new Set<string>()
    for (const b of plan.batches) {
      const batch = randomUUID()
      for (const id of b.ids) { del.run(now, now, actor.id, batch, id); trashed.add(id) }
    }
    let mainChanged = false
    const main = (db.prepare('SELECT main_file_id AS id FROM projects WHERE id = ?').get(a.projectId) as { id: string | null }).id
    if (main !== null && trashed.has(main)) {
      db.prepare('UPDATE projects SET main_file_id = NULL WHERE id = ?').run(a.projectId)
      db.prepare('UPDATE files SET was_main = 1 WHERE id = ?').run(main)
      mainChanged = true
    }

    const untrash = db.prepare(`UPDATE files SET parent_id = ?, name = ?, deleted_at = NULL, deleted_by = NULL, delete_batch = NULL,
      trash_orphan = 0, was_main = 0, updated_at = ? WHERE id = ?`)
    /** Trash batches rows came back from (their remaining rows may need splitting, see rebatch). */
    const touched = new Set<string>()
    const byId = new Map(rows.map(r => [r.id, r]))
    // Parents first, created and revived folders interleaved as planned (a revived folder may sit in a new one).
    for (const f of [...plan.folders, ...plan.revived].sort((x, y) => depth(x) - depth(y))) {
      if (plan.revived.includes(f)) {
        untrash.run(f.parentId, f.name, now, f.id)
        const b = byId.get(f.id)?.batch
        if (b) touched.add(b)
      } else {
        insertNode(s, a.projectId, { id: f.id, parentId: f.parentId!, name: f.name, kind: 'folder' })
      }
    }

    const move = db.prepare('UPDATE files SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?')
    const setBlob = db.prepare('UPDATE files SET blob_hash = ?, size = ?, updated_at = ? WHERE id = ?')
    const changed = new Set<string>()
    let untrashed = 0
    for (const x of plan.subjects) {
      if (x.mode === 'live') {
        if (moving.includes(x)) { move.run(x.parentId, x.name, now, x.id); changed.add(x.id) }
      } else if (x.mode === 'trash') {
        untrash.run(x.parentId, x.name, now, x.id)
        if (x.row!.batch) touched.add(x.row!.batch)
        changed.add(x.id)
        untrashed++
        // M2 rule: the main file comes back if it was deleted as the main file and none was chosen since.
        if (x.row!.wasMain === 1 && x.vf.kind === 'text'
          && db.prepare('UPDATE projects SET main_file_id = ? WHERE id = ? AND main_file_id IS NULL').run(x.id, a.projectId).changes > 0) {
          mainChanged = true
        }
      } else {
        const text = x.vf.kind === 'text' ? s.blobs.read(x.vf.hash)!.toString('utf8') : undefined
        insertNode(s, a.projectId, x.vf.kind === 'text'
          ? { id: x.id, parentId: x.parentId, name: x.name, kind: 'text', text: text! }
          : { id: x.id, parentId: x.parentId, name: x.name, kind: 'binary', blobHash: x.vf.hash, size: x.vf.size })
        changed.add(x.id)
      }
      if (x.mode !== 'create' && x.vf.kind === 'binary' && x.row!.blobHash !== x.vf.hash) {
        setBlob.run(x.vf.hash, x.vf.size, now, x.id)
        changed.add(x.id)
      }
    }
    for (const b of touched) rebatch(db, a.projectId, b)
    const treeChanged = moving.length > 0 || trashed.size > 0 || plan.folders.length > 0 || untrashed > 0 || changed.size > 0
    const treeVersion = treeChanged ? touchProject(db, a.projectId, true) : null
    const trashedDocs = rows.filter(r => trashed.has(r.id) && r.kind === 'text').map(r => fileDocName(a.projectId, r.id, r.epoch))
    return { changed, treeVersion, trashedDocs, mainChanged, trashChanged: trashed.size > 0 || untrashed > 0 }
  })
  const depthOf = new Map<string, number>()
  const parentOf = new Map<string, string | null>([...plan.folders, ...plan.revived].map(f => [f.id, f.parentId]))
  function depth(f: { id: string }): number {
    const known = depthOf.get(f.id)
    if (known !== undefined) return known
    const p = parentOf.get(f.id)
    const d = p === undefined || p === null || !parentOf.has(p) ? 0 : depth({ id: p }) + 1
    depthOf.set(f.id, d)
    return d
  }
  const res = tx.immediate()

  // Same tick as the commit: no client update can reach a trashed doc.
  for (const d of res.trashedDocs) s.collab.closeDocConnections(d, 'file-deleted')
  if (res.treeVersion !== null) {
    s.history.noteChange(a.projectId, actor.id)
    s.collab.broadcast(a.projectId, { type: 'tree-changed', treeVersion: res.treeVersion })
  }
  if (res.trashChanged) s.collab.broadcast(a.projectId, { type: 'trash-changed' })
  if (res.mainChanged) s.collab.broadcast(a.projectId, { type: 'project-changed' })
  await Promise.all(res.trashedDocs.map(d => s.collab.unloadDoc(d)))

  // Text contents: minimal diffs on the live docs, credited to the caller.
  for (const x of plan.subjects) {
    if (x.mode === 'create' || x.vf.kind !== 'text') continue
    const f = getFile(db, x.id)
    if (!f || f.deletedAt !== null || f.kind !== 'text') continue // deleted meanwhile
    const docName = fileDocName(a.projectId, f.id, f.epoch)
    const target = s.blobs.read(x.vf.hash)?.toString('utf8')
    if (target === undefined) continue
    if (currentText(s, docName) === target) continue
    await s.collab.replaceText(docName, target, actor.id)
    db.prepare('UPDATE files SET size = ?, updated_at = ? WHERE id = ?').run(Buffer.byteLength(target), Date.now(), f.id)
    res.changed.add(x.id)
  }

  const result: RestoreVersionResponse = { preRestoreVersionId: pre.id, restored: res.changed.size, trashed: plan.trashedFiles }
  audit(db, { actorId: actor.id, projectId: a.projectId, action: 'version.restore',
    // The version's label and time make the entry readable after the version itself is thinned (docs/M4.md §2).
    detail: { versionId: version.id, label: version.label, versionAt: version.createdAt, ...result,
      ...(req.paths !== undefined ? { paths: files.map(f => f.path) } : {}) } })
  s.collab.broadcast(a.projectId, { type: 'versions-changed' })
  s.collab.broadcast(a.projectId, { type: 'version-restored', versionId: version.id, preRestoreVersionId: pre.id, by: actor.displayName })
  return result
}

/**
 * After rows came back from a trash batch, the rest of the batch may have several top items (e.g. the
 * siblings of a revived folder's restored file). An M2 batch has exactly one top: give every extra top
 * (and what lies under it) a batch of its own, with the same deletion time and author.
 */
function rebatch(db: Services['db'], projectId: string, batch: string): void {
  const rest = db.prepare(`SELECT id, parent_id AS parentId FROM files WHERE project_id = ? AND delete_batch = ? AND deleted_at IS NOT NULL`)
    .all(projectId, batch) as { id: string; parentId: string | null }[]
  const ids = new Set(rest.map(r => r.id))
  const tops = rest.filter(r => r.parentId === null || !ids.has(r.parentId))
  if (tops.length <= 1) return
  const kids = new Map<string, string[]>()
  for (const r of rest) {
    if (r.parentId === null || !ids.has(r.parentId)) continue
    const list = kids.get(r.parentId)
    if (list) list.push(r.id)
    else kids.set(r.parentId, [r.id])
  }
  const set = db.prepare('UPDATE files SET delete_batch = ? WHERE id = ?')
  for (const top of tops.slice(1)) {
    const fresh = randomUUID()
    const stack = [top.id]
    while (stack.length) {
      const cur = stack.pop()!
      set.run(fresh, cur)
      stack.push(...(kids.get(cur) ?? []))
    }
  }
}

function currentText(s: Services, docName: string): string {
  const live = s.collab.liveDoc(docName)
  return live ? live.getText(TEXT_KEY).toString() : s.store.storedText(docName)?.text ?? ''
}

