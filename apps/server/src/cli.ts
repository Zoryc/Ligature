/**
 * Operator CLI (docs/M1.md §7b). Runs against DATA_DIR directly; the server may be running, except for
 * `restore`, which needs it stopped:
 *
 *   npm run cli -w @ligature/server -- <command>        (development)
 *   docker compose exec app ligature <command>           (Docker: /usr/local/bin/ligature wraps this file)
 *   docker compose run --rm --no-deps -v <dir>:/restore:ro app ligature restore /restore   (app stopped)
 *
 * Commands:
 *   backup <dir>                 online SQLite backup of app.db + copy of blobs/ into <dir>/ligature-backup-<timestamp>/
 *   restore <backup-dir> [--force]
 *                                replace DATA_DIR's data by a backup (maintenance/restore.ts); the old data is kept
 *                                in DATA_DIR/pre-restore-<timestamp>/
 *   reset-password <username>    new password from stdin; deletes all of the user's sessions
 *   create-admin <username> [--display-name <name>]
 *                                new instance admin, password from stdin (for closed instances and recovery)
 *
 * Passwords are read from stdin: on a terminal without echo (asked twice), otherwise the first line of
 * stdin (so `printf '%s\n' "$PW" | ligature reset-password alice` works in scripts).
 */
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { constants, existsSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audit } from './audit.ts'
import { deleteUserSessions } from './auth/sessions.ts'
import { hashPassword, isAcceptablePassword, PASSWORD_MAX, PASSWORD_MIN } from './auth/password.ts'
import { normalizeDisplayName, normalizeUsername } from './auth/validation.ts'
import { openDb, SchemaTooNewError } from './db/index.ts'
import { VERSION } from './version.ts'
import { missingBlobs, referencedBlobs, restore, RestoreError, type RestoreResult } from './maintenance/restore.ts'

export class CliError extends Error {}

/** What the CLI talks to; injectable so tests can drive it in-process. */
export interface CliIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown }
  stdout: { write(s: string): unknown }
  stderr: { write(s: string): unknown }
  env: NodeJS.ProcessEnv
}

const USAGE = `Usage: ligature <command>

  backup <dir>                      back up app.db (online) and blobs/ into a new directory under <dir>
  restore <backup-dir> [--force]    replace all data by a backup made with \`backup\` (stop the app server first);
                                    the replaced data is kept in DATA_DIR/pre-restore-<timestamp>/
  reset-password <username>         set a new password (read from stdin) and log the user out everywhere
  create-admin <username> [--display-name <name>]
                                    create an instance admin (password read from stdin)
  --version                         print the Ligature version

Environment: DATA_DIR (default ./data) is the server's data directory.
`

export const dataDirOf = (env: NodeJS.ProcessEnv) => resolve(env.DATA_DIR ?? 'data')

/**
 * openDb's schema line for the account commands: only a migration is worth a line (stderr is otherwise empty
 * on success), and never on stdout, which carries only results.
 */
const toStderr = (line: string) => { if (!line.startsWith('[db] schema ')) process.stderr.write(`${line}\n`) }

const isInside = (child: string, parent: string) => {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/**
 * A directory argument. Relative paths are refused: inside the container they resolve against the image's
 * working directory, so the backup would land (or be looked for) somewhere the operator did not mean.
 */
export function absoluteDir(raw: string, what: string, example: string): string {
  if (!isAbsolute(raw)) {
    throw new CliError(`the ${what} must be an absolute path inside the container, e.g. ${example} (got ${JSON.stringify(raw)})`)
  }
  return resolve(raw)
}

/** Where `backup` may write: an absolute path, not inside the server's blobs/ or outputs/. */
export function backupTarget(dataDir: string, raw: string): string {
  const target = absoluteDir(raw, 'backup directory', '/data/backups')
  for (const sub of ['blobs', 'outputs']) {
    if (isInside(target, join(dataDir, sub))) throw new CliError(`the backup directory must not be inside ${join(dataDir, sub)}; use e.g. /data/backups`)
  }
  return target
}

/* ------------------------------------------------------------------ backup */

export interface BackupResult { dir: string; blobs: number; blobBytes: number; schemaVersion: number }

/** 20261118T094512Z */
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/** Content-addressed blobs only: temp files of an upload in progress (dotfiles, *.tmp) are skipped. */
const isTempName = (name: string) => name.startsWith('.') || name.endsWith('.tmp') || name.includes('.tmp-')

async function countFiles(dir: string): Promise<{ files: number; bytes: number }> {
  const r = { files: 0, bytes: 0 }
  if (!existsSync(dir)) return r
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue
    r.files++
    r.bytes += (await stat(join(e.parentPath, e.name))).size
  }
  return r
}

/** The server's database; the CLI never creates one (a wrong DATA_DIR must not "succeed" on an empty database). */
function existingDbFile(dataDir: string): string {
  const dbFile = join(dataDir, 'app.db')
  if (!existsSync(dbFile)) throw new CliError(`no database at ${dbFile} (is DATA_DIR right? the server creates it on its first start)`)
  return dbFile
}

/**
 * Pages per backup step: everything in one step. SQLite restarts an online backup whenever another
 * connection (here: the running server, another process) writes between two steps, so with the default of
 * 100 pages per step a backup of a busy instance never finishes. One step copies the whole database inside a
 * single read transaction, which in WAL mode does not block the server's writes.
 */
export const BACKUP_PAGES_PER_STEP = 0x7fffffff

/**
 * After the copy, every blob the snapshot refers to must be in the backup (restore refuses it otherwise).
 * The running server's garbage collection can delete one while the copy runs: a project purged or a
 * version thinned after the snapshot frees blobs the snapshot still refers to. Those are copied again from
 * the live blobs/; one already deleted there fails the backup (run it again: a new snapshot no longer
 * refers to it).
 */
export async function completeBlobs(dir: string, liveBlobs: string): Promise<void> {
  const db = new Database(join(dir, 'app.db'), { readonly: true, fileMustExist: true })
  let needed: Set<string>
  try { needed = referencedBlobs(db) } finally { db.close() }
  const blobs = join(dir, 'blobs')
  const gone: string[] = []
  for (const h of missingBlobs(blobs, needed)) {
    const [shard, rest] = [h.slice(0, 2), h.slice(2)]
    try {
      await mkdir(join(blobs, shard), { recursive: true })
      await copyFile(join(liveBlobs, shard, rest), join(blobs, shard, rest), constants.COPYFILE_EXCL)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      gone.push(h)
    }
  }
  if (gone.length) {
    throw new CliError(`${gone.length} blob(s) the database snapshot refers to were deleted while the backup ran (by the `
      + `server's garbage collection), e.g. ${gone[0]}. Nothing usable was written; run the backup again.`)
  }
}

/**
 * Online backup: `db.backup()` takes a consistent snapshot while the server keeps writing. Blobs are
 * copied AFTER the snapshot: the server writes a blob file before committing the row that references
 * it, so every blob the snapshot references is on disk by then, unless the garbage collection deletes it
 * during the copy (completeBlobs). A failed backup leaves no directory behind.
 * The backup directory is 0700: it holds password and session hashes.
 */
export async function backup(dataDir: string, target: string, now = new Date()): Promise<BackupResult> {
  const dbFile = existingDbFile(dataDir)
  await mkdir(target, { recursive: true })
  let dir = join(target, `ligature-backup-${stamp(now)}`)
  for (let i = 2; existsSync(dir); i++) dir = join(target, `ligature-backup-${stamp(now)}-${i}`)
  await mkdir(dir, { mode: 0o700 })
  await chmod(dir, 0o700) // mkdir's mode is masked by the umask
  try {
    return await writeBackup(dataDir, dbFile, dir, now)
  } catch (e) {
    // A half-written backup must not be copied off-site as if it were one (it has no backup.json yet).
    await rm(dir, { recursive: true, force: true }).catch(() => { /* the original error matters more */ })
    throw e
  }
}

async function writeBackup(dataDir: string, dbFile: string, dir: string, now: Date): Promise<BackupResult> {
  const live = new Database(dbFile, { fileMustExist: true })
  try {
    live.pragma('busy_timeout = 5000')
    await live.backup(join(dir, 'app.db'), { progress: () => BACKUP_PAGES_PER_STEP })
  } finally {
    live.close()
  }
  // Make the copy a single self-contained file (the source is in WAL mode) and check it.
  const copy = new Database(join(dir, 'app.db'))
  let schemaVersion: number
  try {
    copy.pragma('journal_mode = DELETE')
    const ok = copy.pragma('integrity_check', { simple: true })
    if (ok !== 'ok') throw new CliError(`integrity check of the backup failed: ${String(ok)}`)
    schemaVersion = copy.pragma('user_version', { simple: true }) as number
  } finally {
    copy.close()
  }

  const blobsSrc = join(dataDir, 'blobs')
  if (existsSync(blobsSrc)) {
    await cp(blobsSrc, join(dir, 'blobs'), {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      // Regular files and directories only: never copy (or follow) a symlink or special file.
      filter: async src => {
        if (src !== blobsSrc && isTempName(basename(src))) return false
        const st = await lstat(src)
        return st.isDirectory() || st.isFile()
      },
    })
  } else {
    await mkdir(join(dir, 'blobs'))
  }
  await completeBlobs(dir, blobsSrc)
  const { files: blobs, bytes: blobBytes } = await countFiles(join(dir, 'blobs'))
  await writeFile(join(dir, 'backup.json'), JSON.stringify({
    format: 'ligature-backup/1', createdAt: now.toISOString(), schemaVersion, blobs, blobBytes,
  }, null, 2) + '\n')
  return { dir, blobs, blobBytes, schemaVersion }
}

/* ------------------------------------------------------------------ passwords from stdin */

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Lines from a terminal in raw mode, without echo. Enter (CR, LF or CRLF) or Ctrl-D ends a line, Ctrl-C
 * aborts, Backspace deletes. Input that arrives ahead of a prompt (e.g. both passwords pasted at once) is
 * kept for the next line instead of being dropped.
 */
function hiddenLines(io: CliIo): { line(prompt: string): Promise<string>; close(): void } {
  const { stdin } = io
  const lines: string[] = []
  let buf = ''
  let afterCr = false
  let failed: CliError | null = null
  let wake: (() => void) | null = null
  const onData = (chunk: Buffer | string) => {
    for (const ch of chunk.toString()) {
      if (afterCr && ch === '\n') { afterCr = false; continue }
      afterCr = ch === '\r'
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { lines.push(buf); buf = ''; continue }
      if (ch === '\u0003') { failed = new CliError('aborted'); break }
      if (ch === '\u007f' || ch === '\b') { buf = [...buf].slice(0, -1).join(''); continue }
      if (ch < ' ') continue
      buf += ch
    }
    wake?.()
  }
  const onEnd = () => {
    if (buf !== '') { lines.push(buf); buf = '' } else failed ??= new CliError('no password entered')
    wake?.()
  }
  stdin.setRawMode?.(true)
  stdin.on('data', onData)
  stdin.on('end', onEnd)
  stdin.resume()
  return {
    async line(prompt) {
      io.stderr.write(prompt)
      while (lines.length === 0 && failed === null) await new Promise<void>(r => { wake = r })
      wake = null
      io.stderr.write('\n')
      if (failed !== null) throw failed
      return lines.shift()!
    },
    close() {
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      stdin.setRawMode?.(false)
      stdin.pause()
    },
  }
}

export async function readNewPassword(io: CliIo): Promise<string> {
  let pw: string
  if (io.stdin.isTTY && io.stdin.setRawMode) {
    const tty = hiddenLines(io)
    try {
      pw = await tty.line('New password: ')
      const again = await tty.line('Repeat password: ')
      if (pw !== again) throw new CliError('the passwords do not match')
    } finally {
      tty.close()
    }
  } else {
    const text = await readAll(io.stdin)
    if (text === '') throw new CliError('no password on stdin')
    pw = text.split(/\r?\n/)[0] ?? ''
  }
  if (!isAcceptablePassword(pw)) throw new CliError(`the password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters long`)
  return pw
}

/* ------------------------------------------------------------------ users */

function requireUsername(raw: string | undefined): string {
  const u = raw === undefined ? null : normalizeUsername(raw)
  if (u === null) throw new CliError('invalid username: 3-32 characters a-z 0-9 . _ -, starting with a letter or digit')
  return u
}

export async function resetPassword(dataDir: string, rawUsername: string, password: string): Promise<{ sessionsDeleted: number }> {
  const username = requireUsername(rawUsername)
  const passwordHash = await hashPassword(password)
  const db = openDb(existingDbFile(dataDir), { log: toStderr })
  try {
    return db.transaction(() => {
      const user =db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string } | undefined
      if (!user) throw new CliError(`no user named ${username}`)
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id)
      const sessionsDeleted = deleteUserSessions(db, user.id)
      audit(db, { actorId: null, action: 'admin-user-update', detail: { userId: user.id, via: 'cli', password: true, sessionsDeleted } })
      return { sessionsDeleted }
    })()
  } finally {
    db.close()
  }
}

export async function createAdmin(dataDir: string, rawUsername: string, password: string, rawDisplayName?: string): Promise<{ id: string; username: string }> {
  const username = requireUsername(rawUsername)
  const displayName = normalizeDisplayName(rawDisplayName ?? username)
  if (displayName === null) throw new CliError('invalid display name: 1-64 characters, no control characters')
  const passwordHash = await hashPassword(password)
  const db = openDb(existingDbFile(dataDir), { log: toStderr })
  try {
    return db.transaction(() => {
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        throw new CliError(`a user named ${username} already exists (use reset-password to recover it)`)
      }
      const id = randomUUID()
      db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?, ?, 1)')
        .run(id, username, displayName, passwordHash, Date.now())
      audit(db, { actorId: null, action: 'admin-user-create', detail: { userId: id, username, isAdmin: true, via: 'cli' } })
      return { id, username }
    })()
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ restore */

function restoreSummary(dataDir: string, src: string, r: RestoreResult): string {
  const schema = r.schemaFrom === r.schemaTo ? `schema v${r.schemaTo}` : `schema v${r.schemaFrom} -> v${r.schemaTo}`
  return [
    `restored ${src} into ${dataDir} (backup of ${r.backupCreatedAt ?? 'unknown date'}, ${schema})`,
    `  ${r.projects} project(s), ${r.files} file(s), ${r.blobs} blob(s)`,
    `  ${r.docsRenamed} document(s) moved to a new generation: editor tabs still open from before must reload`,
    `  ${r.sessionsEnded} session(s) of the backup ended: everyone logs in again`,
    r.safetyDir === null ? '  DATA_DIR held no data before' : `  previous data kept in ${r.safetyDir} (delete it once the restored instance works)`,
    '',
  ].join('\n')
}

/* ------------------------------------------------------------------ entry */

/** Runs one command; returns the process exit code (0 ok, 1 failed, 2 usage). */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv
  const dataDir = dataDirOf(io.env)
  try {
    switch (cmd) {
      case 'backup': {
        if (rest.length !== 1) break
        const r = await backup(dataDir, backupTarget(dataDir, rest[0]!))
        io.stderr.write(`backup of ${dataDir}: schema v${r.schemaVersion}, ${r.blobs} blob(s), ${r.blobBytes} bytes\n`)
        io.stdout.write(`${r.dir}\n`)
        return 0
      }
      case 'restore': {
        const force = rest.includes('--force')
        const args = rest.filter(a => a !== '--force')
        if (args.length !== 1) break
        const src = absoluteDir(args[0]!, 'backup directory', '/restore')
        const r = await restore(dataDir, src, { force, log: line => io.stderr.write(`${line}\n`) })
        io.stdout.write(restoreSummary(dataDir, src, r))
        return 0
      }
      case 'reset-password': {
        if (rest.length !== 1) break
        const username = requireUsername(rest[0])
        existingDbFile(dataDir) // before asking for a password
        const pw = await readNewPassword(io)
        const r = await resetPassword(dataDir, username, pw)
        io.stdout.write(`password of ${username} changed; ${r.sessionsDeleted} session(s) deleted\n`)
        return 0
      }
      case 'create-admin': {
        const args = [...rest]
        let displayName: string | undefined
        const i = args.indexOf('--display-name')
        if (i !== -1) {
          displayName = args[i + 1]
          if (displayName === undefined) break
          args.splice(i, 2)
        }
        if (args.length !== 1) break
        const username = requireUsername(args[0])
        existingDbFile(dataDir)
        const pw = await readNewPassword(io)
        const r = await createAdmin(dataDir, username, pw, displayName)
        io.stdout.write(`admin ${r.username} created (id ${r.id})\n`)
        return 0
      }
      case 'version': case '--version': case '-v':
        io.stdout.write(`ligature ${VERSION}\n`)
        return 0
      case undefined: case 'help': case '--help': case '-h':
        io.stdout.write(USAGE)
        return cmd === undefined ? 2 : 0
    }
  } catch (e) {
    io.stderr.write(`ligature: ${e instanceof CliError || e instanceof RestoreError || e instanceof SchemaTooNewError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    return 1
  }
  io.stderr.write(USAGE)
  return 2
}

const isEntry = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntry) {
  const code = await main(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env })
  process.exitCode = code
}
