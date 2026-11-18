import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { fileDocName, metaDocName, type ProjectDetail, type RebuildDocResponse } from '@ligature/shared'
import { auditEntries } from '../src/audit.ts'
import type { CollabContext } from '../src/collab/collab.ts'
import { DocStore, LOAD_ORIGIN, TEXT_KEY } from '../src/collab/docStore.ts'
import { isOversized } from '../src/collab/rebuild.ts'
import { openDb } from '../src/db/index.ts'
import { MAIN_TEMPLATE } from '../src/projects/service.ts'
import { connect, waitFor } from './harness.ts'
import { Client, newProject, openInstance, PASSWORD, startTestServer, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'

/* Oversized-document rebuild with epoch bump (docs/M3.md §4). */

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

/** Small thresholds so a few thousand tombstoned bytes count as oversized. */
const SMALL = { minBytes: 4096, factor: 8 }

function open(base: string, c: Client, docName: string) {
  const x = connect(base, c.cookie, docName)
  sockets.push(x)
  return x
}

/**
 * Grow a doc's state without growing its text: insert and delete under many different Yjs client ids
 * (each one leaves its own struct and delete-set entries behind).
 */
function bloat(doc: Y.Doc, clients = 600): void {
  const text = doc.getText(TEXT_KEY)
  const own = doc.clientID
  for (let i = 0; i < clients; i++) {
    doc.clientID = 1_000_000 + i
    text.insert(0, 'xyz')
    text.delete(0, 3)
  }
  doc.clientID = own
}

const epochOf = (ts: TestServer, fileId: string) =>
  (ts.lig.db.prepare('SELECT epoch FROM files WHERE id = ?').get(fileId) as { epoch: number }).epoch
const stateRow = (ts: TestServer, name: string) =>
  ts.lig.db.prepare('SELECT length(state) AS bytes, text FROM doc_state WHERE doc_name = ?').get(name) as { bytes: number; text: string } | undefined
const logRows = (ts: TestServer, name: string) =>
  (ts.lig.db.prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_name = ?').get(name) as { n: number }).n
const treeVersion = (ts: TestServer, projectId: string) =>
  (ts.lig.db.prepare('SELECT tree_version AS v FROM projects WHERE id = ?').get(projectId) as { v: number }).v

async function setup(port: number, opts: Parameters<typeof openInstance>[1] = {}) {
  const { ts, admin } = await openInstance(port, { history: { tickMs: 3_600_000 }, ...opts }); servers.push(ts)
  const p: ProjectDetail = await newProject(admin)
  const main = p.tree.find(f => f.name === 'main.tex')!
  return { ts, admin, p, main, g1: fileDocName(p.id, main.id, 1), g2: fileDocName(p.id, main.id, 2) }
}

describe('oversized check', () => {
  it('state > max(factor × text bytes, minBytes)', () => {
    const cfg = { factor: 8, minBytes: 2 * 1024 * 1024 }
    expect(isOversized(2 * 1024 * 1024, 'x', cfg)).toBe(false)
    expect(isOversized(2 * 1024 * 1024 + 1, 'x', cfg)).toBe(true)
    const big = 'é'.repeat(200_000) // 400 000 UTF-8 bytes: the bound is 3.2 MB
    expect(isOversized(3_200_000, big, cfg)).toBe(false)
    expect(isOversized(3_200_001, big, cfg)).toBe(true)
  })

  it('a retired doc is never compacted or appended again', () => {
    const db = openDb(':memory:')
    const store = new DocStore(db)
    const name = 'proj/p/file/f/g1'
    const doc = new Y.Doc()
    store.load(name, doc)
    doc.getText(TEXT_KEY).insert(0, 'hello')
    expect(store.compact(name, doc)).toMatchObject({ text: 'hello' })
    store.retire(name)
    db.prepare('DELETE FROM doc_state').run()
    store.append(name, Y.encodeStateAsUpdate(doc), null)
    expect(store.compact(name, doc)).toBeNull()
    store.flush()
    expect(db.prepare('SELECT COUNT(*) AS n FROM doc_state').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM doc_updates').get()).toEqual({ n: 0 })
    store.release(name)
    expect(store.isRetired(name)).toBe(false)
    db.close()
  })
})

describe('rebuild on compaction', () => {
  it('an oversized doc is rebuilt when its last client leaves: new epoch, same text, old epoch refused', async () => {
    const { ts, admin, p, main, g1, g2 } = await setup(39218, { rebuild: SMALL })
    const meta = open(ts.base, admin, metaDocName(p.id))
    const c = open(ts.base, admin, g1)
    await waitFor(() => c.provider.isSynced && meta.provider.isSynced, 10_000, 'sync')
    c.text().insert(c.text().length, '\n% kept')
    bloat(c.doc)
    const expected = c.text().toString()
    await waitFor(() => !c.provider.hasUnsyncedChanges, 10_000, 'acked')
    const tv = treeVersion(ts, p.id)
    c.destroy()

    await waitFor(() => epochOf(ts, main.id) === 2, 10_000, 'rebuild')
    expect(stateRow(ts, g1)).toBeUndefined()
    expect(logRows(ts, g1)).toBe(0)
    const fresh = stateRow(ts, g2)!
    expect(fresh.text).toBe(expected)
    expect(fresh.bytes).toBeLessThan(SMALL.minBytes)
    expect(treeVersion(ts, p.id)).toBe(tv + 1)
    await waitFor(() => meta.events().some(e => e.type === 'tree-changed' && e.treeVersion === tv + 1), 5_000, 'tree-changed')
    const tree = (await admin.get<ProjectDetail>(`/api/projects/${p.id}`)).body.tree
    expect(tree.find(f => f.id === main.id)!.epoch).toBe(2)
    expect(auditEntries(ts.lig.db, 'doc.rebuild')).toMatchObject([{ actorId: null, projectId: p.id,
      detail: { fileId: main.id, fromEpoch: 1, toEpoch: 2, reason: 'oversized' } }])

    // A client still on the old generation is refused; the new one has the text and keeps working.
    const stale = open(ts.base, admin, g1)
    await waitFor(() => stale.denied() !== null, 10_000, 'denied')
    expect(stale.denied()).toBe('reload-required')
    const d = open(ts.base, admin, g2)
    await waitFor(() => d.provider.isSynced, 10_000, 'sync g2')
    expect(d.text().toString()).toBe(expected)
    d.text().insert(0, '% after\n')
    await waitFor(() => !d.provider.hasUnsyncedChanges, 10_000, 'acked g2')
    d.destroy()
    await waitFor(() => stateRow(ts, g2)?.text === `% after\n${expected}`, 10_000, 'g2 compacted')
    expect(stateRow(ts, g1)).toBeUndefined() // the retired generation was never written back
    expect(epochOf(ts, main.id)).toBe(2) // small again: no second rebuild
  }, 40_000)

  it('a normal doc is not rebuilt', async () => {
    const { ts, admin, main, g1 } = await setup(39219, { rebuild: SMALL })
    const c = open(ts.base, admin, g1)
    await waitFor(() => c.provider.isSynced, 10_000, 'sync')
    for (let i = 0; i < 50; i++) c.text().insert(c.text().length, `line ${i}\n`)
    await waitFor(() => !c.provider.hasUnsyncedChanges, 10_000, 'acked')
    c.destroy()
    await waitFor(() => ts.lig.collab.liveDoc(g1) === undefined, 10_000, 'unloaded')
    expect(epochOf(ts, main.id)).toBe(1)
    expect(auditEntries(ts.lig.db, 'doc.rebuild')).toHaveLength(0)
  })

  it('startup recovery rebuilds an oversized doc left in the update log', async () => {
    const { ts, main, g1, p } = await setup(39220)
    await ts.stop(); servers.splice(0)
    // Bloat the doc offline, as an update log a crash left behind (no compaction).
    const db = openDb(join(ts.dataDir, 'app.db'))
    const store = new DocStore(db)
    const doc = new Y.Doc()
    store.load(g1, doc)
    doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== LOAD_ORIGIN) store.append(g1, u, null) })
    bloat(doc)
    doc.getText(TEXT_KEY).insert(0, '% offline\n')
    store.flush()
    db.close()

    const ts2 = await startTestServer(39221, { dataDir: ts.dataDir, rebuild: SMALL }); servers.push(ts2)
    expect(epochOf(ts2, main.id)).toBe(2)
    expect(stateRow(ts2, fileDocName(p.id, main.id, 2))!.text).toBe(`% offline\n${MAIN_TEMPLATE}`)
    expect(stateRow(ts2, g1)).toBeUndefined()
    expect(auditEntries(ts2.lig.db, 'doc.rebuild')).toMatchObject([{ detail: { reason: 'oversized', fromEpoch: 1, toEpoch: 2 } }])
  })
})

describe('POST /api/admin/files/:fileId/rebuild', () => {
  it('404 for unknown or non-text files, 409 while open, then rebuilds and audits', async () => {
    const { ts, admin, p, main, g1, g2 } = await setup(39222)
    const png = await admin.upload(p.id, p.rootId, 'x.png', makePng(2, 2))
    for (const id of ['nope', '3f0e8a52-1c1b-4c3e-9d4a-0b9a0d6c1e2f', p.rootId, png.body.id]) {
      expect((await admin.post(`/api/admin/files/${id}/rebuild`)).status).toBe(404)
    }
    const c = open(ts.base, admin, g1)
    await waitFor(() => c.provider.isSynced, 10_000, 'sync')
    bloat(c.doc, 200)
    await waitFor(() => !c.provider.hasUnsyncedChanges, 10_000, 'acked')
    const busy = await admin.post(`/api/admin/files/${main.id}/rebuild`)
    expect(busy.status).toBe(409)
    expect(busy.body.error).toBe('doc-in-use')
    c.destroy()
    await waitFor(() => ts.lig.collab.liveDoc(g1) === undefined, 10_000, 'unloaded')
    expect(epochOf(ts, main.id)).toBe(1) // default thresholds: not oversized

    const tv = treeVersion(ts, p.id)
    const r = await admin.post<RebuildDocResponse>(`/api/admin/files/${main.id}/rebuild`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ fileId: main.id, epoch: 2 })
    expect(r.body.stateBytesAfter).toBeLessThan(r.body.stateBytesBefore)
    expect(stateRow(ts, g2)!.text).toBe(MAIN_TEMPLATE)
    expect(stateRow(ts, g1)).toBeUndefined()
    expect(treeVersion(ts, p.id)).toBe(tv + 1)
    const adminId = (await admin.get('/api/me')).body.id
    expect(auditEntries(ts.lig.db, 'doc.rebuild')).toMatchObject([{ actorId: adminId, detail: { reason: 'admin', fileId: main.id } }])
  })

  it('a loaded doc without connections is rebuilt and its old generation retired; a busy project is refused', async () => {
    const { ts, admin, p, main, g1, g2 } = await setup(39223)
    const collab = ts.lig.collab
    const dc = await collab.hocuspocus.openDirectConnection(g1, { user: { id: null } } as unknown as CollabContext)
    await dc.transact(d => { d.getText(TEXT_KEY).insert(0, '% direct\n') })
    expect((await admin.post(`/api/admin/files/${main.id}/rebuild`)).status).toBe(409) // a direct connection counts
    await dc.disconnect({ unloadImmediately: false })
    expect(collab.liveDoc(g1)).toBeDefined()
    expect(collab.liveDoc(g1)!.getConnectionsCount()).toBe(0)

    // While a restore holds the project, neither the admin route nor the compaction hook rebuilds.
    let release!: () => void
    const held = ts.lig.history.withProjectLock(p.id, () => new Promise<void>(r => { release = r }))
    await waitFor(() => ts.lig.history.isBusy(p.id), 2_000, 'lock')
    expect((await admin.post(`/api/admin/files/${main.id}/rebuild`)).status).toBe(409)
    expect(ts.lig.rebuilder.afterCompaction(g1, { stateBytes: 10 * 1024 * 1024, text: '' }, true)).toBeNull()
    release(); await held

    const r = await admin.post<RebuildDocResponse>(`/api/admin/files/${main.id}/rebuild`)
    expect(r.status).toBe(200)
    expect(r.body.epoch).toBe(2)
    expect(stateRow(ts, g2)!.text).toBe(`% direct\n${MAIN_TEMPLATE}`)
    await waitFor(() => collab.liveDoc(g1) === undefined, 10_000, 'old generation unloaded')
    expect(stateRow(ts, g1)).toBeUndefined()
    expect(logRows(ts, g1)).toBe(0)
  })

  it('survives a restart: the new epoch is what clients get', async () => {
    const { ts, admin, p, main, g2 } = await setup(39224)
    expect((await admin.post(`/api/admin/files/${main.id}/rebuild`)).status).toBe(200)
    await ts.stop(); servers.splice(0)
    const ts2 = await startTestServer(39225, { dataDir: ts.dataDir }); servers.push(ts2)
    const again = new Client(ts2.base)
    expect((await again.post('/api/auth/login', { username: 'admin', password: PASSWORD })).status).toBe(200)
    const d = open(ts2.base, again, g2)
    await waitFor(() => d.provider.isSynced, 10_000, 'sync')
    expect(d.text().toString()).toBe(MAIN_TEMPLATE)
    expect((await again.get<ProjectDetail>(`/api/projects/${p.id}`)).body.tree.find(f => f.id === main.id)!.epoch).toBe(2)
  })
})
