import * as Y from 'yjs'
import { fileDocName, parseDocName } from '@ligature/shared'
import { audit } from '../audit.ts'
import { ApiError, notFound } from '../errors.ts'
import type { DB } from '../db/index.ts'
import { getFile } from '../projects/repo.ts'
import { touchProject } from '../projects/service.ts'
import { isUuid } from '../services.ts'
import type { Collab } from './collab.ts'
import { DocStore, TEXT_KEY, type Compacted } from './docStore.ts'

/*
 * Oversized-document rebuild (docs/M3.md §4). Yjs keeps tombstones, so a heavily rewritten doc can carry a
 * state much larger than its text. A rebuild replaces the doc by a fresh one built from the text, under a
 * NEW doc name (`files.epoch += 1`): a client still holding the old generation is refused with
 * `reload-required` by onAuthenticate and never merges into the new one. It only runs while nobody is
 * connected to the doc.
 */

export interface RebuildConfig {
  /** Rebuild when the state exceeds max(`factor` × text bytes, `minBytes`) (8×, 2 MB). */
  factor: number
  minBytes: number
}

export const DEFAULT_REBUILD: RebuildConfig = { factor: 8, minBytes: 2 * 1024 * 1024 }

export function isOversized(stateBytes: number, text: string, cfg: RebuildConfig = DEFAULT_REBUILD): boolean {
  return stateBytes > Math.max(cfg.factor * Buffer.byteLength(text, 'utf8'), cfg.minBytes)
}

export interface RebuildResult {
  projectId: string
  fileId: string
  fromEpoch: number
  toEpoch: number
  /** The new doc name. */
  docName: string
  stateBytesBefore: number
  stateBytesAfter: number
  /** Set when the file is live (the tree changed: its epoch). */
  treeVersion: number | null
}

export interface RebuildInput {
  /** Current doc name of the file (the generation being replaced). */
  docName: string
  text: string
  stateBytes: number
  actorId: string | null
  reason: 'oversized' | 'admin'
  /** The doc is loaded in this process: retire its name so a later compaction cannot write it back. */
  loaded: boolean
}

/**
 * Replace a text file's doc by a fresh one built from `text`, in one transaction: epoch + 1, the new
 * `doc_state`, the old generation's rows deleted, `tree_version` bumped (live files), audited.
 * Returns null (nothing changed) if the file no longer has that generation.
 */
export function rebuildDoc(db: DB, store: DocStore, input: RebuildInput): RebuildResult | null {
  const ref = parseDocName(input.docName)
  if (ref?.kind !== 'file') return null
  const seed = DocStore.prepareSeed(input.text) // CPU work outside the transaction
  if (input.loaded) store.retire(input.docName)
  else store.flush()
  const res = db.transaction((): RebuildResult | null => {
    const f = getFile(db, ref.fileId)
    if (!f || f.projectId !== ref.projectId || f.kind !== 'text' || f.epoch !== ref.epoch) return null
    const toEpoch = f.epoch + 1
    const docName = fileDocName(f.projectId, f.id, toEpoch)
    db.prepare('UPDATE files SET epoch = ? WHERE id = ? AND epoch = ?').run(toEpoch, f.id, f.epoch)
    db.prepare('DELETE FROM doc_updates WHERE doc_name = ?').run(docName) // leftovers of an older crash, if any
    store.seedPrepared(docName, seed)
    db.prepare('DELETE FROM doc_state WHERE doc_name = ?').run(input.docName)
    db.prepare('DELETE FROM doc_updates WHERE doc_name = ?').run(input.docName)
    const treeVersion = f.deletedAt === null ? touchProject(db, f.projectId, true) : null
    audit(db, {
      actorId: input.actorId, projectId: f.projectId, action: 'doc.rebuild',
      detail: { fileId: f.id, fromEpoch: f.epoch, toEpoch, reason: input.reason, stateBytesBefore: input.stateBytes,
        stateBytesAfter: seed.state.byteLength, textBytes: Buffer.byteLength(input.text, 'utf8') },
    })
    return { projectId: f.projectId, fileId: f.id, fromEpoch: f.epoch, toEpoch, docName, stateBytesBefore: input.stateBytes,
      stateBytesAfter: seed.state.byteLength, treeVersion }
  }).immediate()
  return res
}

export const docInUse = () => new ApiError(409, 'doc-in-use', 'Someone has this file open; try again when nobody is editing it')

export interface RebuilderDeps {
  db: DB
  store: DocStore
  collab: Collab
  /** True while a project operation (restore) holds the project: no rebuild then. */
  isBusy(projectId: string): boolean
}

export function createRebuilder(deps: RebuilderDeps, cfg: RebuildConfig = DEFAULT_REBUILD) {
  const { db, store, collab } = deps

  /** After a rebuild of a loaded doc: anyone who slipped in on the old generation is sent away, then it is unloaded. */
  function retireLoaded(oldName: string): void {
    setImmediate(() => {
      if (!collab.liveDoc(oldName)) return
      collab.closeDocConnections(oldName, 'doc-rebuilt')
      collab.unloadDoc(oldName).catch(e => console.error('[rebuild] unload failed', e))
    })
  }

  function announce(r: RebuildResult): void {
    if (r.treeVersion !== null) collab.broadcast(r.projectId, { type: 'tree-changed', treeVersion: r.treeVersion })
  }

  return {
    config: cfg,

    /**
     * Compaction hook: called after a doc with no connected clients was compacted (unload, startup recovery).
     * `loaded` is false for startup recovery. Rebuilds if the state is oversized.
     */
    afterCompaction(docName: string, c: Compacted, loaded: boolean): RebuildResult | null {
      if (!db.open || !isOversized(c.stateBytes, c.text, cfg)) return null
      const ref = parseDocName(docName)
      if (ref?.kind !== 'file' || deps.isBusy(ref.projectId)) return null
      const live = collab.liveDoc(docName)
      if (loaded && live && live.getConnectionsCount() > 0) return null
      try {
        const r = rebuildDoc(db, store, { docName, text: c.text, stateBytes: c.stateBytes, actorId: null, reason: 'oversized', loaded })
        if (!r) return null
        console.log(`[rebuild] ${docName}: ${c.stateBytes} -> ${r.stateBytesAfter} bytes (epoch ${r.toEpoch})`)
        announce(r)
        if (loaded) retireLoaded(docName)
        return r
      } catch (e) {
        console.error('[rebuild] failed', e)
        return null
      }
    },

    /** POST /api/admin/files/:fileId/rebuild — refuses while anyone has the doc open (`409 doc-in-use`). */
    rebuildFile(fileId: string | undefined, actorId: string): RebuildResult {
      if (!isUuid(fileId)) throw notFound()
      const f = getFile(db, fileId)
      if (!f || f.kind !== 'text') throw notFound()
      const docName = fileDocName(f.projectId, f.id, f.epoch)
      const live = collab.liveDoc(docName)
      if ((live && live.getConnectionsCount() > 0) || collab.hocuspocus.loadingDocuments.has(docName) || deps.isBusy(f.projectId)) {
        throw docInUse()
      }
      let text: string
      let stateBytes: number
      if (live) {
        text = live.getText(TEXT_KEY).toString()
        stateBytes = Y.encodeStateAsUpdate(live).byteLength
      } else {
        // Closed doc: its compacted state plus any log rows a crash left behind.
        const doc = new Y.Doc({ gc: true })
        try {
          store.load(docName, doc)
          text = doc.getText(TEXT_KEY).toString()
          stateBytes = Y.encodeStateAsUpdate(doc).byteLength
        } finally {
          store.release(docName)
          doc.destroy()
        }
      }
      const r = rebuildDoc(db, store, { docName, text, stateBytes, actorId, reason: 'admin', loaded: live !== undefined })
      if (!r) throw docInUse() // the generation changed underneath us
      announce(r)
      if (live) retireLoaded(docName)
      return r
    },
  }
}

export type Rebuilder = ReturnType<typeof createRebuilder>
