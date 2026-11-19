import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { fileDocName, type VersionDetail, type VersionPage } from '@ligature/shared'
import { DocStore } from '../src/collab/docStore.ts'
import { MIGRATIONS } from '../src/db/schema.ts'
import { tempDataDir, waitFor } from './harness.ts'
import { me, signup, startTestServer, type TestServer } from './inproc.ts'

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.stop() })

const P = '11111111-1111-4111-8111-111111111111'
const ROOT = '22222222-2222-4222-8222-222222222222'
const MAIN = '33333333-3333-4333-8333-333333333333'
const FIG = '44444444-4444-4444-8444-444444444444'
const GONE = '55555555-5555-4555-8555-555555555555' // a soft-deleted project
const GONE_ROOT = '66666666-6666-4666-8666-666666666666'
const TEXT = '\\documentclass{article}\n\\begin{document}Legacy\\end{document}\n'
const PNG = Buffer.from('not really a png')
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** An M2 database (schema version 3) with a live project (a text and a binary file) and a deleted one. */
function m2Db(dataDir: string): void {
  const db = new Database(join(dataDir, 'app.db'))
  for (const m of MIGRATIONS.slice(0, 3)) db.exec(m)
  db.pragma('user_version = 3')
  db.prepare(`INSERT INTO projects (id, name, root_id, main_file_id, engine, tree_version, created_at, updated_at)
    VALUES (?, 'Legacy', ?, ?, 'pdflatex', 7, 0, 0)`).run(P, ROOT, MAIN)
  db.prepare(`INSERT INTO projects (id, name, root_id, main_file_id, engine, tree_version, created_at, updated_at, deleted_at)
    VALUES (?, 'Gone', ?, NULL, 'pdflatex', 0, 0, 0, 5)`).run(GONE, GONE_ROOT)
  const ins = db.prepare(`INSERT INTO files (id, project_id, parent_id, name, kind, epoch, blob_hash, size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 0)`)
  ins.run(ROOT, P, null, '', 'folder', null, null)
  ins.run(MAIN, P, ROOT, 'main.tex', 'text', null, Buffer.byteLength(TEXT))
  ins.run(FIG, P, ROOT, 'fig.png', 'binary', sha(PNG), PNG.byteLength)
  ins.run(GONE_ROOT, GONE, null, '', 'folder', null, null)
  db.prepare('INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, 0)').run(sha(PNG), PNG.byteLength)
  new DocStore(db).seed(fileDocName(P, MAIN, 1), TEXT)
  db.close()
  const h = sha(PNG)
  mkdirSync(join(dataDir, 'blobs', h.slice(0, 2)), { recursive: true })
  writeFileSync(join(dataDir, 'blobs', h.slice(0, 2), h.slice(2)), PNG)
}

describe('migration 4 (versions) on an M2 database', () => {
  it('adds the history tables and columns; the first scheduler pass versions every live pre-M3 project', async () => {
    const dataDir = tempDataDir()
    m2Db(dataDir)
    const ts = await startTestServer(39128, { dataDir }); servers.push(ts)
    const db = ts.lig.db
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(4) // and later migrations
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name)
    expect(tables).toEqual(expect.arrayContaining(['versions', 'version_files', 'version_authors', 'pending_authors']))
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(t => t.name)
    expect(indexes).toEqual(expect.arrayContaining(['versions_project', 'version_files_blob']))

    // The startup pass (deferred by one macrotask) takes an auto version of the live project only.
    const count = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').get(id) as { n: number }).n
    await waitFor(() => count(P) === 1, 5_000, 'first pass')
    expect(count(GONE)).toBe(0)
    expect(db.prepare('SELECT dirty_since AS d, last_change_at AS l FROM projects WHERE id = ?').get(P)).toEqual({ d: null, l: null })
    expect(db.prepare('SELECT dirty_since AS d FROM projects WHERE id = ?').get(GONE)).toEqual({ d: null }) // deleted: never marked
    expect(ts.lig.history.tick()).toBe(0)

    const alice = await signup(ts.base, 'alice')
    db.prepare("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', 0)").run(P, (await me(alice)).id)
    const list = (await alice.get<VersionPage>(`/api/projects/${P}/versions`)).body.versions
    expect(list).toEqual([expect.objectContaining({ kind: 'auto', label: null, createdBy: '', authors: [], fileCount: 2 })])
    const d = (await alice.get<VersionDetail>(`/api/projects/${P}/versions/${list[0]!.id}`)).body
    expect(d.files).toEqual([
      { path: 'fig.png', fileId: FIG, kind: 'binary', size: PNG.byteLength, hash: sha(PNG) },
      { path: 'main.tex', fileId: MAIN, kind: 'text', size: Buffer.byteLength(TEXT), hash: sha(TEXT) },
    ])
    expect((await alice.get(`/api/projects/${P}/versions/${list[0]!.id}/file?path=main.tex`)).body).toBe(TEXT)
    expect(db.prepare('SELECT tree_version AS v FROM versions').get()).toEqual({ v: 7 })
  })
})
