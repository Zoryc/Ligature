import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fileDocName, type ProjectDetail } from '@ligature/shared'
import { backup, CliError, completeBlobs, main, type CliIo } from '../src/cli.ts'
import { openDb, SCHEMA_VERSION, SchemaTooNewError } from '../src/db/index.ts'
import { MIGRATIONS } from '../src/db/schema.ts'
import { HEARTBEAT_FILE, startHeartbeat } from '../src/maintenance/heartbeat.ts'
import { explainAccess, restore, RestoreError } from '../src/maintenance/restore.ts'
import { connect, tempDataDir, waitFor } from './harness.ts'
import { createSession, SESSION_COOKIE } from '../src/auth/sessions.ts'
import { Client, me, newProject, openInstance, startTestServer, type TestServer } from './inproc.ts'
import { makePng } from './png.ts'

/* `ligature backup` / `restore` (maintenance/restore.ts) and the schema checks of openDb. Ports: 39640–39659 only. */

const servers: TestServer[] = []
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  sockets.splice(0).forEach(c => c.destroy())
  for (const s of servers.splice(0)) await s.stop()
})

const QUIET = { history: { tickMs: 3_600_000 } }

/** Every file and directory under `dir` with a content hash: "DATA_DIR untouched" means equal snapshots. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = join(e.parentPath, e.name)
    out[relative(dir, p)] = e.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'dir'
  }
  return out
}

/** Read-only look at a database (no WAL, no migrations). */
function peek<T>(file: string, f: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try { return f(db) } finally { db.close() }
}

const one = <T>(db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T

async function cli(dataDir: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: CliIo = {
    stdin: Readable.from([]),
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    env: { DATA_DIR: dataDir },
  }
  const code = await main(argv, io)
  return { code, out, err }
}

describe('restore end to end', () => {
  it('brings the backup back; editor tabs from before get reload-required instead of undoing the restore', async () => {
    const PORT = 39640
    const dataDir = tempDataDir()
    const { ts, admin } = await openInstance(PORT, { dataDir, ...QUIET })
    servers.push(ts)
    const p: ProjectDetail = await newProject(admin)
    const mainTex = p.tree.find(f => f.name === 'main.tex')!
    const g1 = fileDocName(p.id, mainTex.id, 1)
    const g2 = fileDocName(p.id, mainTex.id, 2)
    expect((await admin.upload(p.id, p.rootId, 'figure.png', makePng(8, 8))).status).toBe(200)
    expect((await admin.post(`/api/projects/${p.id}/versions`, { label: 'Draft 1' })).status).toBe(200)

    // The browser's cookie: it changes when the user logs in again after the restore.
    let browserCookie = admin.cookie
    const backupCookie = admin.cookie
    const adminId = (await me(admin)).id
    const tab = connect(ts.base, () => browserCookie, g1)
    sockets.push(tab)
    await waitFor(() => tab.provider.isSynced, 10_000, 'sync')
    tab.text().insert(0, '% BEFORE BACKUP\n')
    await waitFor(() => !tab.provider.hasUnsyncedChanges, 10_000, 'acked')
    const backedUp = tab.text().toString()

    ts.lig.store.flush() // edits are written in short batches: make sure this one is in the snapshot
    const bk = await backup(dataDir, join(tempDataDir(), 'backups'))

    // Changes after the backup: an edit by the open tab, a new file, build outputs.
    tab.text().insert(0, '% AFTER BACKUP\n')
    await waitFor(() => !tab.provider.hasUnsyncedChanges, 10_000, 'acked after')
    expect((await admin.upload(p.id, p.rootId, 'later.png', makePng(8, 8, [1, 2, 3]))).status).toBe(200)
    mkdirSync(join(dataDir, 'outputs', p.id), { recursive: true })
    writeFileSync(join(dataDir, 'outputs', p.id, 'main.pdf'), 'stale pdf')
    const treeBefore = (await admin.get<ProjectDetail>(`/api/projects/${p.id}`)).body.treeVersion

    // Refused while the server runs; nothing moved.
    await expect(restore(dataDir, bk.dir)).rejects.toThrow(/app server is running/)
    expect(readdirSync(dataDir).filter(n => n.startsWith('pre-restore') || n.startsWith('.restore'))).toEqual([])

    await ts.stop()
    servers.splice(0)
    expect(existsSync(join(dataDir, HEARTBEAT_FILE))).toBe(false)

    const logs: string[] = []
    const r = await restore(dataDir, bk.dir, { log: l => logs.push(l) })
    const liveFiles = p.tree.filter(f => f.kind !== 'folder').length + 1 // + figure.png
    expect(r).toMatchObject({ schemaFrom: SCHEMA_VERSION, schemaTo: SCHEMA_VERSION, projects: 1, files: liveFiles })
    expect(r.docsRenamed).toBe(p.tree.filter(f => f.kind === 'text').length)
    expect(r.blobs).toBeGreaterThanOrEqual(2)
    expect(r.sessionsEnded).toBeGreaterThanOrEqual(1)
    expect(logs).toContain(`[db] schema v${SCHEMA_VERSION}`)

    // The replaced data is kept; stale outputs are gone; no staging leftovers.
    expect(r.safetyDir).not.toBeNull()
    expect(existsSync(join(r.safetyDir!, 'app.db'))).toBe(true)
    expect(existsSync(join(r.safetyDir!, 'blobs'))).toBe(true)
    expect(peek(join(r.safetyDir!, 'app.db'), db => one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM files WHERE name = 'later.png'").n)).toBe(1)
    expect(existsSync(join(dataDir, 'outputs'))).toBe(false)
    expect(readdirSync(dataDir).filter(n => n.startsWith('.restore'))).toEqual([])

    // The restored database: backup contents, every text file on a new generation, the restore audited.
    peek(join(dataDir, 'app.db'), db => {
      expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM files WHERE name = 'later.png'").n).toBe(0)
      expect(one<{ epoch: number }>(db, 'SELECT epoch FROM files WHERE id = ?', mainTex.id).epoch).toBe(2)
      expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM doc_state WHERE doc_name = ?', g1).n
        + one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM doc_updates WHERE doc_name = ?', g1).n).toBe(0)
      expect(one<{ v: number }>(db, 'SELECT tree_version AS v FROM projects WHERE id = ?', p.id).v).toBeGreaterThan(treeBefore)
      const a = one<{ detail_json: string }>(db, "SELECT detail_json FROM audit_log WHERE action = 'backup.restore'")
      expect(JSON.parse(a.detail_json)).toMatchObject({ via: 'cli', projects: 1, docsRenamed: r.docsRenamed,
        sessionsEnded: r.sessionsEnded, safetyCopy: r.safetyDir!.split(/[\\/]/).pop() })
      expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM sessions').n).toBe(0)
    })

    // The user logs in again in that browser (a session made directly: the tab reconnects on its own as soon
    // as the server is up, and must do so with the new cookie).
    const fresh1 = new Database(join(dataDir, 'app.db'))
    browserCookie = `${SESSION_COOKIE}=${createSession(fresh1, adminId).token}`
    fresh1.close()

    const ts2 = await startTestServer(PORT, { dataDir, ...QUIET })
    servers.push(ts2)
    // A cookie that was valid in the backup is refused (it may have been revoked since): API and collab.
    const stolen = new Client(ts2.base)
    stolen.cookie = backupCookie
    expect((await stolen.get('/api/me')).status).toBe(401)
    const stolenTab = connect(ts2.base, backupCookie, g2)
    sockets.push(stolenTab)
    await waitFor(() => stolenTab.denied() !== null, 10_000, 'backup cookie denied')
    expect(stolenTab.denied()).toBe('unauthenticated')
    admin.cookie = browserCookie
    // The tab from before reconnects on its own: refused, its post-backup edit never reaches the restored doc.
    await waitFor(() => tab.denied() !== null, 15_000, 'stale tab denied')
    expect(tab.denied()).toBe('reload-required')
    const fresh = connect(ts2.base, admin.cookie, g2)
    sockets.push(fresh)
    await waitFor(() => fresh.provider.isSynced, 10_000, 'sync g2')
    expect(fresh.text().toString()).toBe(backedUp)
    const tree = (await admin.get<ProjectDetail>(`/api/projects/${p.id}`)).body.tree
    expect(tree.find(f => f.id === mainTex.id)!.epoch).toBe(2)
    expect(tree.some(f => f.name === 'later.png')).toBe(false)
    const png = tree.find(f => f.name === 'figure.png')!
    expect((await admin.get(`/api/projects/${p.id}/files/${png.id}/raw`)).status).toBe(200)
  }, 60_000)

  it('restores an older backup into an empty DATA_DIR: migrated, generations renewed, no safety copy', async () => {
    const src = tempDataDir()
    const db = new Database(join(src, 'app.db'))
    for (let v = 0; v < 4; v++) db.exec(MIGRATIONS[v]!)
    db.pragma('user_version = 4')
    const [pid, root, fid] = [randomUUID(), randomUUID(), randomUUID()]
    db.prepare('INSERT INTO projects (id, name, root_id, created_at) VALUES (?, ?, ?, 1)').run(pid, 'Old', root)
    db.prepare("INSERT INTO files (id, project_id, parent_id, name, kind, created_at) VALUES (?, ?, NULL, '', 'folder', 1)").run(root, pid)
    db.prepare("INSERT INTO files (id, project_id, parent_id, name, kind, epoch, created_at) VALUES (?, ?, ?, 'a.tex', 'text', 3, 1)").run(fid, pid, root)
    db.prepare("INSERT INTO doc_state (doc_name, upto_seq, state, text, text_hash, updated_at) VALUES (?, 0, x'00', 'old text', 'h', 1)")
      .run(fileDocName(pid, fid, 3))
    db.close()
    const bk = await backup(src, join(tempDataDir(), 'bk'))
    expect(bk.schemaVersion).toBe(4)

    const dataDir = join(tempDataDir(), 'data')
    const logs: string[] = []
    const r = await restore(dataDir, bk.dir, { log: l => logs.push(l) })
    expect(r).toMatchObject({ schemaFrom: 4, schemaTo: SCHEMA_VERSION, projects: 1, files: 1, docsRenamed: 1, blobs: 0, safetyDir: null })
    expect(logs).toContain(`[db] migrated v4 -> v${SCHEMA_VERSION}`)
    expect(readdirSync(dataDir).filter(n => n.startsWith('pre-restore'))).toEqual([])
    peek(join(dataDir, 'app.db'), d => {
      expect(one<{ epoch: number }>(d, 'SELECT epoch FROM files WHERE id = ?', fid).epoch).toBe(4)
      expect(one<{ text: string }>(d, 'SELECT text FROM doc_state WHERE doc_name = ?', fileDocName(pid, fid, 4)).text).toBe('old text')
      expect(d.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    })
  })

  it('goes above every generation of the replaced data, rebuilt-and-deleted files included', async () => {
    const PORT = 39641
    const dataDir = tempDataDir()
    const { ts, admin } = await openInstance(PORT, { dataDir, ...QUIET })
    servers.push(ts)
    const p = await newProject(admin)
    const mainTex = p.tree.find(f => f.name === 'main.tex')!
    const bk = await backup(dataDir, join(tempDataDir(), 'bk'))
    // After the backup, main.tex is rebuilt twice (epoch 3): a tab may hold g3.
    for (let i = 0; i < 2; i++) expect((await admin.post(`/api/admin/files/${mainTex.id}/rebuild`)).status).toBe(200)
    await ts.stop()
    servers.splice(0)

    const r = await restore(dataDir, bk.dir)
    expect(r.docsRenamed).toBeGreaterThan(0)
    expect(peek(join(dataDir, 'app.db'), db => one<{ epoch: number }>(db, 'SELECT epoch FROM files WHERE id = ?', mainTex.id).epoch)).toBe(4)
  }, 30_000)
})

describe('restore refuses and validates without touching DATA_DIR', () => {
  /** A real instance's data and a backup of it, made once; each test works on copies. */
  let base: { dataDir: string; backupDir: string }
  beforeAll(async () => {
    const dataDir = tempDataDir()
    const { ts, admin } = await openInstance(39642, { dataDir, ...QUIET })
    const p = await newProject(admin)
    await admin.upload(p.id, p.rootId, 'figure.png', makePng(8, 8))
    await admin.post(`/api/projects/${p.id}/versions`, { label: 'Draft 1' })
    const bk = await backup(dataDir, join(tempDataDir(), 'bk'))
    await ts.stop()
    base = { dataDir, backupDir: bk.dir }
  }, 30_000)
  afterAll(() => { rmSync(base.dataDir, { recursive: true, force: true }) })

  function fresh() {
    const dataDir = join(tempDataDir(), 'data')
    const backupDir = join(tempDataDir(), 'bk')
    cpSync(base.dataDir, dataDir, { recursive: true })
    cpSync(base.backupDir, backupDir, { recursive: true })
    return { dataDir, backupDir }
  }

  async function refused(mutate: (backupDir: string, dataDir: string) => void, msg: RegExp) {
    const f = fresh()
    mutate(f.backupDir, f.dataDir)
    const before = snapshot(f.dataDir)
    const err = await restore(f.dataDir, f.backupDir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RestoreError)
    expect((err as Error).message).toMatch(msg)
    expect(snapshot(f.dataDir)).toEqual(before)
  }

  it('while the server heartbeat is fresh (unless --force); a stale heartbeat does not block', async () => {
    const f = fresh()
    const hb = startHeartbeat(f.dataDir)
    const before = snapshot(f.dataDir)
    await expect(restore(f.dataDir, f.backupDir)).rejects.toThrow(/app server is running .* --force/s)
    expect(snapshot(f.dataDir)).toEqual(before)
    hb.stop()

    // A crashed server leaves its heartbeat behind: it blocks for 30 s only.
    writeFileSync(join(f.dataDir, HEARTBEAT_FILE), JSON.stringify({ pid: 1, at: Date.now() - 60_000 }))
    const logs: string[] = []
    await restore(f.dataDir, f.backupDir, { log: l => logs.push(l) })
    writeFileSync(join(f.dataDir, HEARTBEAT_FILE), JSON.stringify({ pid: 1, at: Date.now() }))
    await restore(f.dataDir, f.backupDir, { force: true, log: l => logs.push(l) })
    expect(logs.some(l => /restoring anyway \(--force\)/.test(l))).toBe(true)
  })

  it('a missing, unreadable or unknown manifest', async () => {
    await refused(b => rmSync(join(b, 'backup.json')), /backup\.json is missing/)
    await refused(b => writeFileSync(join(b, 'backup.json'), '{nope'), /not valid JSON/)
    await refused(b => writeFileSync(join(b, 'backup.json'), JSON.stringify({ format: 'other/9', schemaVersion: 1 })), /unknown backup format/)
  })

  it('a backup from a newer schema', async () => {
    const newer = SCHEMA_VERSION + 1
    await refused(b => {
      writeFileSync(join(b, 'backup.json'), JSON.stringify({ format: 'ligature-backup/1', schemaVersion: newer }))
      const db = new Database(join(b, 'app.db'))
      db.pragma(`user_version = ${newer}`)
      db.close()
    }, new RegExp(`schema v${newer}, but this version of Ligature only knows schemas up to v${SCHEMA_VERSION}`))
  })

  it('a damaged database or one that does not match the manifest', async () => {
    await refused(b => {
      const file = join(b, 'app.db')
      const bytes = readFileSync(file)
      bytes.fill(0x42, 0, 100) // the header
      writeFileSync(file, bytes)
    }, /cannot open|not a usable database|integrity check/)
    await refused(b => rmSync(join(b, 'app.db')), /app\.db is missing/)
    await refused(b => {
      const db = new Database(join(b, 'app.db'))
      db.pragma('user_version = 2')
      db.close()
    }, /backup\.json says schema v\d+ but .* is at v2/)
  })

  it('missing blobs', async () => {
    await refused(b => rmSync(join(b, 'blobs'), { recursive: true }), /blobs\/ is missing/)
    await refused(b => {
      const sub = readdirSync(join(b, 'blobs'))[0]!
      const file = readdirSync(join(b, 'blobs', sub))[0]!
      rmSync(join(b, 'blobs', sub, file))
    }, /backup is incomplete: 1 blob\(s\)/)
  })

  it('a symlinked shard directory or blobs/ (the copy would skip it: validation must not follow it)', async () => {
    const elsewhere = (from: string) => {
      const to = join(tempDataDir(), 'moved')
      renameSync(from, to)
      symlinkSync(to, from, 'junction')
    }
    await refused(b => elsewhere(join(b, 'blobs', readdirSync(join(b, 'blobs'))[0]!)), /backup is incomplete: 1 blob\(s\).*symbolic links are not restored/)
    await refused(b => elsewhere(join(b, 'blobs')), /blobs is not a directory \(a symbolic link/)
  })

  it('a read-only backup (chmod -R a-w): restored with writable blobs, no staging folder left', async () => {
    const f = fresh()
    const setModes = (dir: string, file: number, folder: number) => {
      for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        chmodSync(join(e.parentPath, e.name), e.isDirectory() ? folder : file)
      }
      chmodSync(dir, folder)
    }
    setModes(f.backupDir, 0o444, 0o555)
    try {
      const r = await restore(f.dataDir, f.backupDir)
      expect(r.blobs).toBeGreaterThanOrEqual(1)
    } finally {
      setModes(f.backupDir, 0o644, 0o755)
    }
    expect(readdirSync(f.dataDir).filter(n => n.startsWith('.restore'))).toEqual([])
    const blobs = join(f.dataDir, 'blobs')
    for (const e of readdirSync(blobs, { withFileTypes: true, recursive: true })) {
      expect(statSync(join(e.parentPath, e.name)).mode & 0o200, e.name).not.toBe(0)
    }
    // The server can add a blob to an existing shard, and the sweep can delete one.
    const shard = readdirSync(blobs)[0]!
    writeFileSync(join(blobs, shard, 'probe'), 'x')
    rmSync(join(blobs, shard, 'probe'))
    rmSync(join(blobs, shard, readdirSync(join(blobs, shard))[0]!))
  })

  it('a backup directory that does not exist or overlaps DATA_DIR', async () => {
    await refused(b => rmSync(b, { recursive: true }), /does not exist .*-v \/path\/to\/backup:\/restore:ro/)
    const f = fresh()
    await expect(restore(f.dataDir, f.dataDir)).rejects.toThrow(/overlaps DATA_DIR/)
    await expect(restore(f.dataDir, join(f.dataDir, 'blobs'))).rejects.toThrow(/overlaps DATA_DIR/)
  })

  it('permission problems tell the operator to chown the backup to the container user', async () => {
    const e = explainAccess(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: '/restore/app.db' }), '/restore')
    expect(e).toBeInstanceOf(RestoreError)
    expect((e as Error).message).toMatch(/cannot read \/restore\/app\.db \(EACCES\).*sudo chown -R 1000:1000/)
    const other = new Error('boom')
    expect(explainAccess(other, '/restore')).toBe(other)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a backup this user cannot read (copied out by root)', async () => {
    await refused(b => chmodSync(join(b, 'app.db'), 0o000), /EACCES.*sudo chown -R 1000:1000/)
    await refused(b => chmodSync(b, 0o000), /EACCES.*sudo chown -R 1000:1000/)
  })
})

describe('CLI: restore and backup paths', () => {
  it('restore prints a summary; relative paths are refused', async () => {
    const src = tempDataDir()
    openDb(join(src, 'app.db'), { log: () => {} }).close()
    const bk = await backup(src, join(tempDataDir(), 'bk'))
    const dataDir = tempDataDir()
    openDb(join(dataDir, 'app.db'), { log: () => {} }).close()

    const r = await cli(dataDir, ['restore', bk.dir])
    expect(r.err).toBe(`[db] schema v${SCHEMA_VERSION}\n`)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^restored .* \(backup of \d{4}-.*, schema v\d+\)\n  0 project\(s\), 0 file\(s\), 0 blob\(s\)\n/)
    expect(r.out).toMatch(/previous data kept in .*pre-restore-\d{8}T\d{6}Z/)

    const rel = await cli(dataDir, ['restore', 'restore'])
    expect(rel.code).toBe(1)
    expect(rel.err).toMatch(/backup directory must be an absolute path inside the container, e\.g\. \/restore/)
    expect((await cli(dataDir, ['restore'])).code).toBe(2)
  })

  it('backup copies again a blob the garbage collection deleted during the copy; one gone for good fails it, leaving nothing', async () => {
    const dataDir = tempDataDir()
    const { ts, admin } = await openInstance(39644, { dataDir, ...QUIET })
    const p = await newProject(admin)
    expect((await admin.upload(p.id, p.rootId, 'figure.png', makePng(8, 8))).status).toBe(200)
    const bk = await backup(dataDir, join(tempDataDir(), 'bk'))
    await ts.stop()
    const live = join(dataDir, 'blobs')
    const shard = readdirSync(live)[0]!
    const name = readdirSync(join(live, shard))[0]!

    // Missing from the copy (deleted live between snapshot and copy, then the copy looked): taken again.
    rmSync(join(bk.dir, 'blobs', shard), { recursive: true })
    await completeBlobs(bk.dir, live)
    expect(readFileSync(join(bk.dir, 'blobs', shard, name)).equals(readFileSync(join(live, shard, name)))).toBe(true)

    // Deleted live for good: the snapshot still refers to it, so the backup fails and leaves no directory.
    rmSync(join(live, shard, name))
    const target = join(tempDataDir(), 'bk2')
    const err = await backup(dataDir, target).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as Error).message).toMatch(/1 blob\(s\) the database snapshot refers to were deleted while the backup ran.*run the backup again/)
    expect(readdirSync(target)).toEqual([])
  }, 30_000)

  it('backup refuses a relative target or one inside blobs/ or outputs/', async () => {
    const dataDir = tempDataDir()
    openDb(join(dataDir, 'app.db'), { log: () => {} }).close()
    for (const target of ['backups', './backups', '~/backups']) {
      const r = await cli(dataDir, ['backup', target])
      expect(r.code, target).toBe(1)
      expect(r.err).toMatch(/must be an absolute path inside the container, e\.g\. \/data\/backups/)
    }
    for (const sub of ['blobs', 'outputs']) {
      const r = await cli(dataDir, ['backup', join(dataDir, sub, 'bk')])
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/must not be inside/)
    }
    expect(readdirSync(dataDir).sort()).toEqual(['app.db'])
  })
})

describe('database schema checks at open', () => {
  it('logs the schema, or the migration it ran', () => {
    const file = join(tempDataDir(), 'app.db')
    const logs: string[] = []
    openDb(file, { log: l => logs.push(l) }).close()
    openDb(file, { log: l => logs.push(l) }).close()
    expect(logs).toEqual([`[db] migrated v0 -> v${SCHEMA_VERSION}`, `[db] schema v${SCHEMA_VERSION}`])
  })

  it('refuses a database written by newer code (server start included), without changing it', async () => {
    const dataDir = tempDataDir()
    const file = join(dataDir, 'app.db')
    openDb(file, { log: () => {} }).close()
    const raw = new Database(file)
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()
    const before = readFileSync(file)
    expect(() => openDb(file, { log: () => {} })).toThrow(SchemaTooNewError)
    expect(() => openDb(file, { log: () => {} })).toThrow(new RegExp(`schema v${SCHEMA_VERSION + 1}, but this version of Ligature only knows schemas up to v${SCHEMA_VERSION}`))
    await expect(startTestServer(39643, { dataDir })).rejects.toThrow(SchemaTooNewError)
    expect(readFileSync(file).equals(before)).toBe(true)
  })
})
