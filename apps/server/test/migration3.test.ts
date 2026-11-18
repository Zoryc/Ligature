import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { TrashEntry } from '@ligature/shared'
import { MIGRATIONS } from '../src/db/schema.ts'
import { tempDataDir } from './harness.ts'
import { me, signup, startTestServer, type TestServer } from './inproc.ts'

const servers: TestServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.stop() })

const P = '11111111-1111-4111-8111-111111111111'
const ROOT = '22222222-2222-4222-8222-222222222222'
const D = '33333333-3333-4333-8333-333333333333' // folder deleted at t1
const X = '44444444-4444-4444-8444-444444444444' // D/x.tex, deleted with D
const Y = '55555555-5555-4555-8555-555555555555' // D/y.tex, deleted earlier (t0) on its own
const Z = '66666666-6666-4666-8666-666666666666' // z.tex at the root, deleted at t2
const SUB = '77777777-7777-4777-8777-777777777777' // D/sub, deleted with D
const W = '88888888-8888-4888-8888-888888888888' // D/sub/w.tex, deleted with D
const LIVE = '99999999-9999-4999-8999-999999999999'

/** An M1 database (schema version 2) with soft-deleted rows that have no trash batch. */
function legacyDb(dataDir: string, t0: number): void {
  const db = new Database(join(dataDir, 'app.db'))
  db.exec(MIGRATIONS[0]!)
  db.exec(MIGRATIONS[1]!)
  db.pragma('user_version = 2')
  db.prepare("INSERT INTO users (id, username, display_name, created_at) VALUES ('u-old', 'old', 'Old Timer', 0)").run()
  db.prepare("INSERT INTO instance_settings (key, value) VALUES ('registration', 'open')").run()
  db.prepare(`INSERT INTO projects (id, name, root_id, main_file_id, engine, tree_version, created_at, updated_at)
    VALUES (?, 'Legacy', ?, NULL, 'pdflatex', 9, 0, 0)`).run(P, ROOT)
  const ins = db.prepare(`INSERT INTO files (id, project_id, parent_id, name, kind, epoch, size, deleted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 0)`)
  ins.run(ROOT, P, null, '', 'folder', null, null)
  ins.run(LIVE, P, ROOT, 'main.tex', 'text', 4, null)
  ins.run(D, P, ROOT, 'D', 'folder', null, t0 + 1000)
  ins.run(X, P, D, 'x.tex', 'text', 1, t0 + 1000)
  ins.run(SUB, P, D, 'sub', 'folder', null, t0 + 1000)
  ins.run(W, P, SUB, 'w.tex', 'text', 1, t0 + 1000)
  ins.run(Y, P, D, 'y.tex', 'text', 1, t0)
  ins.run(Z, P, ROOT, 'z.tex', 'text', 1, t0 + 2000)
  db.prepare(`INSERT INTO audit_log (actor_id, project_id, action, detail_json, at) VALUES ('u-old', ?, 'file-delete', ?, ?)`)
    .run(P, JSON.stringify({ fileId: D, name: 'D', count: 3 }), t0 + 1000)
  db.close()
}

describe('migration 3 (trash) on an M1 database', () => {
  it('gives each top-level deleted row its own batch with its same-time descendants; deleted_by from the audit log', async () => {
    const dataDir = tempDataDir()
    const t0 = Date.now() - 60_000
    legacyDb(dataDir, t0)
    const ts = await startTestServer(39280, { dataDir }); servers.push(ts)
    const db = ts.lig.db
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    const rows = Object.fromEntries((db.prepare('SELECT id, delete_batch AS b, deleted_by AS by FROM files WHERE project_id = ?').all(P) as
      { id: string; b: string | null; by: string | null }[]).map(r => [r.id, [r.b, r.by]]))
    expect(rows).toEqual({
      [ROOT]: [null, null], [LIVE]: [null, null],
      [D]: [D, 'u-old'], [X]: [D, 'u-old'], [SUB]: [D, 'u-old'], [W]: [D, 'u-old'],
      [Y]: [Y, null], [Z]: [Z, null],
    })

    // The batches behave like M2 ones.
    const alice = await signup(ts.base, 'alice')
    db.prepare("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', 0)").run(P, (await me(alice)).id)
    const list = (await alice.get<TrashEntry[]>(`/api/projects/${P}/trash`)).body
    expect(list.map(e => [e.name, e.originalPath, e.fileCount, e.deletedBy])).toEqual([
      ['z.tex', 'z.tex', 1, ''], ['D', 'D', 2, 'Old Timer'], ['y.tex', 'D/y.tex', 1, ''],
    ])
    const r = await alice.post(`/api/projects/${P}/trash/${D}/restore`, {})
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const tree = (await alice.get(`/api/projects/${P}`)).body.tree as { id: string }[]
    expect(tree.map(t => t.id).sort()).toEqual([ROOT, LIVE, D, X, SUB, W].sort())
    expect((await alice.get<TrashEntry[]>(`/api/projects/${P}/trash`)).body.map(e => e.originalPath)).toEqual(['z.tex', 'D/y.tex'])
  })
})
