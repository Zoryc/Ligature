import { can, type VersionDetail, type VersionDiff, type VersionFile, type VersionPage, type VersionSummary } from '@ligature/shared'
import { audit } from '../audit.ts'
import { ApiError, badRequest, notFound } from '../errors.ts'
import { isUuid, type Services } from '../services.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { DB } from '../db/index.ts'
import { getProject } from '../projects/repo.ts'
import { requireRole, type Access } from '../projects/service.ts'
import type { ExportItem } from '../zip/exporter.ts'
import { exportFileName } from '../zip/exporter.ts'
import { changeCounts, diffFiles } from './diff.ts'
import { captureProject, withoutBytes } from './snapshot.ts'
import { authorsOf, fileOf, filesOf, getVersion, listVersionRows, previousVersion, setLabel, type VersionRow } from './store.ts'

/* The history API (docs/M3.md §2, contract in packages/shared/src/api.ts "history (M3)"). */

export const MAX_LABEL = 200
export const DEFAULT_PAGE = 50
export const MAX_PAGE = 100

/** Labels: 1–200 characters after trimming, no control characters. */
export function validateLabel(raw: string): string {
  const label = raw.trim()
  if (label.length < 1 || label.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(label)) {
    throw badRequest(`Labels: 1–${MAX_LABEL} characters, no control characters`)
  }
  return label
}

/** A version of the caller's project, or 404 (bad id, other project, thinned). */
export function requireVersion(db: DB, a: Access, versionId: string | undefined): VersionRow {
  if (!isUuid(versionId)) throw notFound()
  const v = getVersion(db, a.projectId, versionId)
  if (!v) throw notFound()
  return v
}

const displayNames = (db: DB, ids: readonly (string | null)[]): Map<string, string> => {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))]
  if (wanted.length === 0) return new Map()
  const rows = db.prepare('SELECT id, display_name AS name FROM users WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(wanted)) as { id: string; name: string }[]
  return new Map(rows.map(r => [r.id, r.name]))
}

/** Change counts and file count of a version against the one before it. */
interface Counts { fileCount: number; changes: VersionSummary['changes'] }

/**
 * Counts are immutable for a (version, previous version) pair (a version's files never change; thinning
 * changes which version is previous, hence the pair as key), so the list route computes them once:
 * a page of 100 versions of a 2000-file project is ~200k rows to compare.
 */
const COUNT_CACHE_MAX = 20_000
const countCaches = new WeakMap<DB, Map<string, Counts>>()

function countCache(db: DB): Map<string, Counts> {
  let m = countCaches.get(db)
  if (!m) countCaches.set(db, m = new Map())
  return m
}

/**
 * Summaries of `rows` (newest first, consecutive in the project's history). `older` is the version just
 * before the last row (null if that one is the first version), for its change counts.
 */
export function summarize(db: DB, rows: readonly VersionRow[], older: VersionRow | null): VersionSummary[] {
  const all = older ? [...rows, older] : [...rows]
  const cache = countCache(db)
  const keyOf = (i: number) => `${rows[i]!.id}:${all[i + 1]?.id ?? ''}`
  // Files only of the versions whose counts are not known yet (and of their previous versions).
  const wanted = new Set<string>()
  rows.forEach((v, i) => {
    if (cache.has(keyOf(i))) return
    wanted.add(v.id)
    const prev = all[i + 1]
    if (prev) wanted.add(prev.id)
  })
  const files = filesOf(db, [...wanted])
  const authors = authorsOf(db, rows.map(v => v.id))
  const names = displayNames(db, rows.map(v => v.createdBy))
  return rows.map((v, i) => {
    const key = keyOf(i)
    let counts = cache.get(key)
    if (counts) {
      cache.delete(key) // most recently used last
    } else {
      const mine = files.get(v.id) ?? []
      const prev = all[i + 1]
      counts = {
        fileCount: mine.length,
        changes: prev ? changeCounts(files.get(prev.id) ?? [], mine) : { added: 0, removed: 0, modified: 0 },
      }
    }
    cache.set(key, counts)
    if (cache.size > COUNT_CACHE_MAX) cache.delete(cache.keys().next().value!)
    return {
      id: v.id, kind: v.kind, label: v.label, createdAt: v.createdAt,
      createdBy: (v.createdBy !== null && names.get(v.createdBy)) || '',
      authors: authors.get(v.id) ?? [],
      fileCount: counts.fileCount,
      changes: { ...counts.changes },
    }
  })
}

export const summaryOf = (db: DB, v: VersionRow): VersionSummary => summarize(db, [v], previousVersion(db, v))[0]!

/** GET /projects/:id/versions?before=&limit= — newest first. */
export function listVersions(s: Services, a: Access, before: string | undefined, limit: number): VersionPage {
  let anchor: VersionRow | undefined
  if (before !== undefined) {
    const v = isUuid(before) ? getVersion(s.db, a.projectId, before) : null
    if (!v) throw badRequest('before: not a version of this project')
    anchor = v
  }
  const rows = listVersionRows(s.db, a.projectId, limit + 1, anchor)
  const page = rows.slice(0, limit)
  return { versions: summarize(s.db, page, rows[limit] ?? null), hasMore: rows.length > limit }
}

/** POST /projects/:id/versions — snapshot the current state as a named version (always, even if identical). */
export function createNamedVersion(s: Services, actor: SessionUser, a: Access, rawLabel: string): VersionSummary {
  requireRole(a, can.edit)
  const label = validateLabel(rawLabel)
  const v = s.history.takeVersion(a.projectId, 'named', { label, createdBy: actor.id })!
  audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'version.create', detail: { versionId: v.id, label } })
  return summaryOf(s.db, v)
}

/** PATCH /projects/:id/versions/:versionId — set or clear the label. */
export function labelVersion(s: Services, actor: SessionUser, a: Access, versionId: string | undefined, rawLabel: string | null): VersionSummary {
  requireRole(a, can.edit)
  const v = requireVersion(s.db, a, versionId)
  const label = rawLabel === null ? null : validateLabel(rawLabel)
  s.db.transaction(() => {
    setLabel(s.db, v.id, label)
    audit(s.db, { actorId: actor.id, projectId: a.projectId, action: 'version.label', detail: { versionId: v.id, label } })
  })()
  s.collab.broadcast(a.projectId, { type: 'versions-changed' })
  return summaryOf(s.db, { ...v, label })
}

/** GET /projects/:id/versions/:versionId */
export function versionDetail(s: Services, a: Access, versionId: string | undefined): VersionDetail {
  const v = requireVersion(s.db, a, versionId)
  return { version: summaryOf(s.db, v), files: filesOf(s.db, [v.id]).get(v.id) ?? [] }
}

/** One file of a version (for GET …/file?path=). */
export function versionFile(s: Services, a: Access, versionId: string | undefined, path: string | undefined): VersionFile {
  const v = requireVersion(s.db, a, versionId)
  if (path === undefined || path === '') throw badRequest('path is required')
  const f = fileOf(s.db, v.id, path)
  if (!f) throw notFound('No such file in this version')
  return f
}

/** Files of a version, or of the live state ('current', captured through the snapshot barrier, not stored). */
function sideFiles(s: Services, a: Access, id: string): VersionFile[] {
  if (id === 'current') return withoutBytes(captureProject(s, a.projectId).files)
  return filesOf(s.db, [requireVersion(s.db, a, id).id]).get(id) ?? []
}

/**
 * GET /projects/:id/versions/:versionId/diff?against= — `against` (default: the previous version) is the
 * old side, :versionId the new side; either may be 'current'.
 */
export function versionDiff(s: Services, a: Access, versionId: string | undefined, against: string | undefined): VersionDiff {
  if (versionId === undefined) throw notFound()
  const to = versionId === 'current' ? 'current' : requireVersion(s.db, a, versionId).id
  let from: string
  if (against !== undefined && against !== '') {
    if (against !== 'current' && !(isUuid(against) && getVersion(s.db, a.projectId, against))) {
      throw badRequest('against: a version of this project or "current"')
    }
    from = against
  } else if (to === 'current') {
    from = listVersionRows(s.db, a.projectId, 1)[0]?.id ?? ''
  } else {
    from = previousVersion(s.db, requireVersion(s.db, a, to))?.id ?? ''
  }
  // No previous version: everything on the new side is "added".
  const oldFiles = from === '' ? [] : sideFiles(s, a, from)
  return { from, to, files: diffFiles(oldFiles, sideFiles(s, a, to)) }
}

/** The zip of a version: its name and items (all blobs; texts are stored as UTF-8 blobs). */
export function versionExport(s: Services, a: Access, versionId: string | undefined): { name: string; items: ExportItem[] } {
  const v = requireVersion(s.db, a, versionId)
  const project = getProject(s.db, a.projectId)
  const when = new Date(v.createdAt).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
  const name = exportFileName(`${project?.name ?? 'project'} - ${v.label ?? when}`)
  const files = filesOf(s.db, [v.id]).get(v.id) ?? []
  // All or nothing: refuse up front if some content is missing (the stream also fails if one vanishes later).
  const missing = files.find(f => !s.blobs.has(f.hash))
  if (missing) throw new ApiError(409, 'content-missing', `The content of ${missing.path} in this version is missing`)
  return { name, items: files.map(f => ({ path: f.path, blobHash: f.hash })) }
}
