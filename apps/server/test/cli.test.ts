import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import Database from 'better-sqlite3'
import { verify } from '@node-rs/argon2'
import { describe, expect, it, vi } from 'vitest'
import { createSession, userForToken } from '../src/auth/sessions.ts'
import { main, type CliIo } from '../src/cli.ts'
import { openDb, type DB } from '../src/db/index.ts'
import { tempDataDir } from './harness.ts'

const SERVER_DIR = resolve(import.meta.dirname, '..')

interface Run { code: number; out: string; err: string }

/** Run the CLI in-process with `input` as (piped, non-TTY) stdin. */
async function cli(dataDir: string, argv: string[], input = ''): Promise<Run> {
  let out = ''
  let err = ''
  const io: CliIo = {
    stdin: Readable.from(input === '' ? [] : [Buffer.from(input)]),
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    env: { DATA_DIR: dataDir },
  }
  const code = await main(argv, io)
  return { code, out, err }
}

/** The real entrypoint as a child process (node + tsx loader, like `npm run cli`). */
function spawnCli(dataDir: string, argv: string[], input: string): Promise<Run> {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...argv], {
      cwd: SERVER_DIR, env: { ...process.env, DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', fail)
    p.on('close', code => done({ code: code ?? -1, out, err }))
    p.stdin.end(input)
  })
}

function addUser(db: DB, username: string, opts: { hash?: string; admin?: boolean } = {}): string {
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, username, username.toUpperCase(), opts.hash ?? 'old-hash', Date.now(), opts.admin ? 1 : 0)
  return id
}

const sessionsOf = (db: DB, userId: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId) as { n: number }).n

describe('ligature CLI: backup', () => {
  it('produces a consistent, self-contained copy of the database (including un-checkpointed WAL data) and the blobs', async () => {
    const dataDir = tempDataDir()
    const db = openDb(join(dataDir, 'app.db'))
    db.pragma('wal_autocheckpoint = 0') // keep the rows below in app.db-wal only
    const alice = addUser(db, 'alice')
    createSession(db, alice)
    db.prepare("INSERT INTO projects (id, name, root_id, created_at) VALUES ('p1', 'Paper', 'r1', 1)").run()
    expect(readFileSync(join(dataDir, 'app.db-wal')).length).toBeGreaterThan(0)

    const hash = 'ab' + 'c'.repeat(62)
    mkdirSync(join(dataDir, 'blobs', 'ab'), { recursive: true })
    writeFileSync(join(dataDir, 'blobs', 'ab', hash.slice(2)), 'blob bytes')
    writeFileSync(join(dataDir, 'blobs', 'ab', '.tmp-123'), 'partial upload')
    writeFileSync(join(dataDir, 'blobs', 'ab', 'x.tmp'), 'partial upload')

    const target = join(tempDataDir(), 'backups')
    const r = await cli(dataDir, ['backup', target])
    expect(r.err).toMatch(/1 blob\(s\)/)
    expect(r.code).toBe(0)
    const dir = r.out.trim()
    expect(dir.startsWith(target)).toBe(true)
    expect(dir).toMatch(/ligature-backup-\d{8}T\d{6}Z$/)

    // A write after the backup is not in it.
    addUser(db, 'later')
    db.close()

    expect(existsSync(join(dir, 'app.db-wal'))).toBe(false)
    const copy = new Database(join(dir, 'app.db'), { readonly: true, fileMustExist: true })
    try {
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete')
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(copy.prepare('SELECT username FROM users ORDER BY username').all()).toEqual([{ username: 'alice' }])
      expect(copy.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'Paper' }])
      expect((copy.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1)
      expect(copy.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(2)
    } finally {
      copy.close()
    }
    expect(readFileSync(join(dir, 'blobs', 'ab', hash.slice(2)), 'utf8')).toBe('blob bytes')
    expect(readdirSync(join(dir, 'blobs', 'ab'))).toEqual([hash.slice(2)])
    const meta = JSON.parse(readFileSync(join(dir, 'backup.json'), 'utf8'))
    expect(meta).toMatchObject({ format: 'ligature-backup/1', blobs: 1, blobBytes: 10 })

    // A second backup in the same second gets its own directory.
    const again = await cli(dataDir, ['backup', target])
    expect(again.code).toBe(0)
    expect(again.out.trim()).not.toBe(dir)
  })

  it('works without a blobs directory and fails clearly without a database', async () => {
    const dataDir = tempDataDir()
    openDb(join(dataDir, 'app.db')).close()
    const ok = await cli(dataDir, ['backup', join(dataDir, 'bk')])
    expect(ok.code).toBe(0)
    expect(readdirSync(join(ok.out.trim(), 'blobs'))).toEqual([])

    const empty = tempDataDir()
    const bad = await cli(empty, ['backup', join(empty, 'bk')])
    expect(bad.code).toBe(1)
    expect(bad.err).toMatch(/no database/)
    expect(existsSync(join(empty, 'app.db'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('the backup directory is 0700 (it holds password and session hashes)', async () => {
    const dataDir = tempDataDir()
    openDb(join(dataDir, 'app.db')).close()
    const r = await cli(dataDir, ['backup', join(dataDir, 'bk')])
    expect(r.code).toBe(0)
    expect(statSync(r.out.trim()).mode & 0o777).toBe(0o700)
  })

  // SQLite restarts an online backup whenever another connection writes between two steps. With the
  // default of 100 pages per step, a backup of a database that the server (another process) keeps writing
  // to never finishes.
  it('finishes while another process keeps writing to the database', async () => {
    const dataDir = tempDataDir()
    const dbFile = join(dataDir, 'app.db')
    const db = openDb(dbFile)
    db.exec('CREATE TABLE filler (id INTEGER PRIMARY KEY, b BLOB)')
    const fill = db.prepare('INSERT INTO filler (b) VALUES (randomblob(4000))')
    db.transaction(() => { for (let i = 0; i < 6000; i++) fill.run() })() // about 25 MB, 6000+ pages
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()

    // Like the server persisting Yjs updates: a small write every few milliseconds, from another process.
    const writer = spawn(process.execPath, ['-e', `
      const db = new (require('better-sqlite3'))(${JSON.stringify(dbFile)})
      db.pragma('busy_timeout = 5000')
      const ins = db.prepare('INSERT INTO filler (b) VALUES (randomblob(100))')
      let n = 0
      setInterval(() => { ins.run(); if (++n === 5) process.stdout.write('writing\\n') }, 2)
    `], { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'inherit'] })
    try {
      await new Promise<void>((ok, fail) => {
        writer.stdout.on('data', () => ok())
        writer.on('exit', code => fail(new Error(`writer exited (${code})`)))
      })
      const started = Date.now()
      const r = await Promise.race([
        cli(dataDir, ['backup', join(dataDir, 'bk')]),
        new Promise<Run>(done => setTimeout(() => done({ code: -1, out: '', err: 'backup did not finish within 20 s' }), 20_000)),
      ])
      expect(r.err).not.toMatch(/did not finish/)
      expect(r.code).toBe(0)
      expect(Date.now() - started).toBeLessThan(20_000)
      const copy = new Database(join(r.out.trim(), 'app.db'), { readonly: true, fileMustExist: true })
      try {
        expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
        expect((copy.prepare('SELECT COUNT(*) AS n FROM filler').get() as { n: number }).n).toBeGreaterThanOrEqual(6005)
      } finally {
        copy.close()
      }
    } finally {
      writer.kill()
    }
  }, 60_000)
})

describe('ligature CLI: wrong DATA_DIR', () => {
  it('reset-password and create-admin refuse to run without a database and create none', async () => {
    const empty = tempDataDir()
    const reset = await cli(empty, ['reset-password', 'alice'], 'a-new-long-password\n')
    expect(reset.code).toBe(1)
    expect(reset.err).toMatch(/no database at .*app\.db/)
    const create = await cli(empty, ['create-admin', 'alice'], 'a-new-long-password\n')
    expect(create.code).toBe(1)
    expect(create.err).toMatch(/no database at .*app\.db/)
    const missing = join(empty, 'does-not-exist')
    expect((await cli(missing, ['create-admin', 'alice'], 'a-new-long-password\n')).code).toBe(1)
    expect(readdirSync(empty)).toEqual([])
  })
})

/** A terminal: stdin with isTTY and setRawMode; `typed` arrives in one chunk (like a paste). */
async function cliTty(dataDir: string, argv: string[], typed: string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() })
  let out = ''
  let err = ''
  stdin.write(typed)
  const code = await main(argv, {
    stdin, stdout: { write: (s: string) => { out += s } }, stderr: { write: (s: string) => { err += s } }, env: { DATA_DIR: dataDir },
  })
  return { code, out, err, rawMode: stdin.setRawMode.mock.calls.map(c => c[0]) }
}

describe('ligature CLI: password from a terminal', () => {
  it('asks twice without echo; both passwords pasted at once (CR, LF or CRLF) are all used', async () => {
    const dataDir = tempDataDir()
    const db = openDb(join(dataDir, 'app.db'))
    const alice = addUser(db, 'alice')
    const hashOf = () => (db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').get(alice) as { h: string }).h
    for (const [pw, eol] of [['pasted-password-1', '\r'], ['pasted-password-2', '\n'], ['pasted-password-3', '\r\n']] as const) {
      const r = await cliTty(dataDir, ['reset-password', 'alice'], `${pw}${eol}${pw}${eol}`)
      expect(r.err).toBe('New password: \nRepeat password: \n')
      expect(r.code).toBe(0)
      expect(r.rawMode).toEqual([true, false])
      expect(await verify(hashOf(), pw)).toBe(true)
    }
    // Backspace edits, other control characters are ignored.
    const typed = await cliTty(dataDir, ['reset-password', 'alice'], 'typed-passwordX\u007f\u0001\rtyped-password\r')
    expect(typed.code).toBe(0)
    expect(await verify(hashOf(), 'typed-password')).toBe(true)
    db.close()
  })

  it('refuses two different passwords and aborts on Ctrl-C, changing nothing', async () => {
    const dataDir = tempDataDir()
    const db = openDb(join(dataDir, 'app.db'))
    addUser(db, 'alice')
    const differ = await cliTty(dataDir, ['reset-password', 'alice'], 'first-password-1\rsecond-password\r')
    expect(differ.code).toBe(1)
    expect(differ.err).toMatch(/do not match/)
    expect(differ.rawMode).toEqual([true, false])
    const abort = await cliTty(dataDir, ['create-admin', 'bob'], 'some-pass\u0003')
    expect(abort.code).toBe(1)
    expect(abort.err).toMatch(/aborted/)
    expect(abort.rawMode).toEqual([true, false])
    expect(db.prepare("SELECT password_hash AS h FROM users WHERE username = 'alice'").get()).toEqual({ h: 'old-hash' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'bob'").get()).toEqual({ n: 0 })
    db.close()
  })
})

describe('ligature CLI: reset-password', () => {
  it('changes the hash (argon2id, M1 parameters) and deletes all sessions of that user only', async () => {
    const dataDir = tempDataDir()
    const db = openDb(join(dataDir, 'app.db'))
    const alice = addUser(db, 'alice')
    const bob = addUser(db, 'bob')
    const t1 = createSession(db, alice).token
    createSession(db, alice)
    const tb = createSession(db, bob).token

    const r = await cli(dataDir, ['reset-password', 'Alice'], 'a-new-long-password\nignored second line\n')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/password of alice changed; 2 session\(s\) deleted/)

    const row = db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').get(alice) as { h: string }
    expect(row.h).not.toBe('old-hash')
    expect(row.h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(await verify(row.h, 'a-new-long-password')).toBe(true)
    expect(sessionsOf(db, alice)).toBe(0)
    expect(userForToken(db, t1)).toBeNull()
    expect(userForToken(db, tb)?.username).toBe('bob')
    const audit = db.prepare("SELECT actor_id AS actor, detail_json AS d FROM audit_log WHERE action = 'admin-user-update'").all() as { actor: null; d: string }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actor).toBeNull()
    expect(JSON.parse(audit[0]!.d)).toMatchObject({ userId: alice, via: 'cli' })
    expect(audit[0]!.d).not.toContain('a-new-long-password')
    db.close()
  })

  it('accepts CRLF input and refuses weak passwords, empty stdin and unknown users without changing anything', async () => {
    const dataDir = tempDataDir()
    const db = openDb(join(dataDir, 'app.db'))
    const alice = addUser(db, 'alice')
    createSession(db, alice)

    const short = await cli(dataDir, ['reset-password', 'alice'], 'short\n')
    expect(short.code).toBe(1)
    expect(short.err).toMatch(/10 to 256 characters/)
    const none = await cli(dataDir, ['reset-password', 'alice'], '')
    expect(none.code).toBe(1)
    expect(none.err).toMatch(/no password on stdin/)
    const unknown = await cli(dataDir, ['reset-password', 'nobody'], 'a-new-long-password\n')
    expect(unknown.code).toBe(1)
    expect(unknown.err).toMatch(/no user named nobody/)
    expect((db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').get(alice) as { h: string }).h).toBe('old-hash')
    expect(sessionsOf(db, alice)).toBe(1)

    const crlf = await cli(dataDir, ['reset-password', 'alice'], 'windows-password\r\n')
    expect(crlf.code).toBe(0)
    const h = (db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').get(alice) as { h: string }).h
    expect(await verify(h, 'windows-password')).toBe(true)
    db.close()
  })
})

describe('ligature CLI: create-admin', () => {
  it('creates an instance admin that can log in with the password from stdin', async () => {
    const dataDir = tempDataDir()
    openDb(join(dataDir, 'app.db')).close()
    const r = await cli(dataDir, ['create-admin', 'Root.Admin', '--display-name', '  The Admin  '], 'correct horse battery\n')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const db = openDb(join(dataDir, 'app.db'))
    const u = db.prepare('SELECT id, username, display_name AS dn, is_admin AS admin, disabled_at AS dis, password_hash AS h FROM users').all() as
      { id: string; username: string; dn: string; admin: number; dis: number | null; h: string }[]
    expect(u).toHaveLength(1)
    expect(u[0]).toMatchObject({ username: 'root.admin', dn: 'The Admin', admin: 1, dis: null })
    expect(await verify(u[0]!.h, 'correct horse battery')).toBe(true)
    expect(r.out).toContain(u[0]!.id)
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin-user-create'").get()).toEqual({ n: 1 })
    db.close()
  })

  it('refuses an existing username, an invalid username and a weak password', async () => {
    const dataDir = tempDataDir()
    const db = openDb(join(dataDir, 'app.db'))
    addUser(db, 'alice')
    db.close()
    const dup = await cli(dataDir, ['create-admin', 'ALICE'], 'long-enough-password\n')
    expect(dup.code).toBe(1)
    expect(dup.err).toMatch(/already exists/)
    const bad = await cli(dataDir, ['create-admin', '-x'], 'long-enough-password\n')
    expect(bad.code).toBe(1)
    expect(bad.err).toMatch(/invalid username/)
    const weak = await cli(dataDir, ['create-admin', 'carol'], '123\n')
    expect(weak.code).toBe(1)
    const check = openDb(join(dataDir, 'app.db'))
    expect(check.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 })
    check.close()
  })
})

describe('ligature CLI: entrypoint', () => {
  it('usage errors exit 2', async () => {
    const dataDir = tempDataDir()
    expect((await cli(dataDir, [])).code).toBe(2)
    expect((await cli(dataDir, ['frobnicate'])).code).toBe(2)
    expect((await cli(dataDir, ['backup'])).code).toBe(2)
    expect((await cli(dataDir, ['create-admin', 'x', '--display-name'])).code).toBe(2)
    expect((await cli(dataDir, ['help'])).code).toBe(0)
  })

  it('runs as a process with piped stdin (create-admin, reset-password, backup)', async () => {
    const dataDir = tempDataDir()
    openDb(join(dataDir, 'app.db')).close()
    const c = await spawnCli(dataDir, ['create-admin', 'ops'], 'process-password-1\n')
    expect(c.err).toBe('')
    expect(c.code).toBe(0)
    const r = await spawnCli(dataDir, ['reset-password', 'ops'], 'process-password-2\n')
    expect(r.code).toBe(0)
    const b = await spawnCli(dataDir, ['backup', join(dataDir, 'bk')], '')
    expect(b.code).toBe(0)
    const copy = new Database(join(b.out.trim(), 'app.db'), { readonly: true })
    const h = (copy.prepare("SELECT password_hash AS h FROM users WHERE username = 'ops'").get() as { h: string }).h
    copy.close()
    expect(await verify(h, 'process-password-2')).toBe(true)
  }, 60_000)
})
