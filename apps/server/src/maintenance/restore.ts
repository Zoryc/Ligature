import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readdirSync, statSync, type Stats } from 'node:fs'
import { access, chmod, copyFile, cp, link, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileDocName } from '@ligature/shared'
import { audit } from '../audit.ts'
import { openDb, SCHEMA_VERSION, type DB } from '../db/index.ts'
import { heartbeatAge, HEARTBEAT_FRESH_MS, isHeartbeatFresh } from './heartbeat.ts'

/*
 * `ligature restore <backup-dir>`: put a backup made by `ligature backup` back into DATA_DIR, while the app
 * server is stopped. In order:
 *
 *   1. refuse while a server is running on DATA_DIR (its heartbeat is fresh), unless forced;
 *   2. validate the backup without touching DATA_DIR (manifest, schema, integrity, every referenced blob);
 *   3. stage it inside DATA_DIR under temporary names and prepare the staged database there (migrations,
 *      new document generations, sessions ended, audit entry), fsynced;
 *   4. swap by renames: the current database and blobs go to DATA_DIR/pre-restore-<time>/ (a safety copy),
 *      the staged ones take their place. DATA_DIR/app.db is replaced atomically, never missing. outputs/
 *      (PDFs of the old state) is deleted.
 *
 * New document generations: Yjs doc names carry the file's epoch. A browser tab that was open before the
 * restore holds Yjs state of the old data; if it reconnected to a doc of the same name it would merge those
 * edits into the restored text, silently undoing the restore. So every text file gets an epoch above any it
 * had before (in the backup or in the replaced data), its doc rows move to the new name, and such a tab is
 * refused with `reload-required` and offers its unsaved text in the recovery dialog (as after a rebuild,
 * collab/rebuild.ts). The project meta doc is not persisted (it carries only presence), so it needs nothing.
 *
 * Sessions: the backup holds the sessions of its time. Bringing them back would undo every logout, password
 * reset and revocation made since (a stolen cookie would work again), so the restore deletes them all and
 * everyone logs in again.
 */

export class RestoreError extends Error {}

export const BACKUP_FORMAT = 'ligature-backup/1'

/** The uid the app container runs as (user `node`): restore must be able to read the backup as it. */
const CONTAINER_UID = 1000

/** Epoch (and tree version) headroom when the replaced database cannot be read: above any a tab could hold. */
const UNKNOWN_EPOCH_MARGIN = 1000

const HASH_RE = /^[0-9a-f]{64}$/

export interface RestoreOptions {
  /** Restore even though a server heartbeat is fresh. */
  force?: boolean
  now?: Date
  /** Progress lines (migrations, warnings). */
  log?: (line: string) => void
}

export interface RestoreResult {
  backupCreatedAt: string | null
  /** Schema of the backup, and of the restored database (after migrations). */
  schemaFrom: number
  schemaTo: number
  /** Live projects and files (not in the trash) of the restored data. */
  projects: number
  files: number
  /** Text files moved to a new document generation (trashed ones included). */
  docsRenamed: number
  /** Blob files restored. */
  blobs: number
  /** Sessions of the backup deleted (everyone logs in again). */
  sessionsEnded: number
  /** Where the replaced data went; null when DATA_DIR held no data. */
  safetyDir: string | null
}

export interface BackupInfo {
  dir: string
  createdAt: string | null
  schemaVersion: number
  blobFiles: number
  /** Blob hashes the backup database refers to (checked again on the staged copy). */
  needed: ReadonlySet<string>
}

/** 20261118T094512Z */
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

const isInside = (child: string, parent: string) => {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/* ------------------------------------------------------------------ 1. nobody running */

export function refuseWhileRunning(dataDir: string, now: number, force: boolean, log: (line: string) => void): void {
  const age = heartbeatAge(dataDir, now)
  if (!isHeartbeatFresh(age)) return
  const secs = Math.max(0, Math.round(age! / 1000))
  if (force) {
    log(`warning: the app server wrote a heartbeat ${secs} s ago; restoring anyway (--force)`)
    return
  }
  throw new RestoreError(`the app server is running on ${dataDir} (last heartbeat ${secs} s ago). Stop it first `
    + '(docker compose -f docker/compose.yaml stop app). If it is not running (it crashed), wait '
    + `${HEARTBEAT_FRESH_MS / 1000} s or pass --force.`)
}

/* ------------------------------------------------------------------ 2. validate */

/** A permission error on the backup becomes advice; anything else passes through. */
export function explainAccess(e: unknown, backupDir: string): unknown {
  const code = (e as NodeJS.ErrnoException | null)?.code
  if (code !== 'EACCES' && code !== 'EPERM') return e
  const path = (e as NodeJS.ErrnoException).path ?? backupDir
  return new RestoreError(`cannot read ${path} (${code}). The restore runs as uid ${CONTAINER_UID} (the container's user); `
    + `if the backup was copied by root, make it readable first: sudo chown -R ${CONTAINER_UID}:${CONTAINER_UID} <backup-dir> `
    + `(here: ${backupDir} as seen inside the container)`)
}

/** Readable as this process? (stat alone succeeds on files we cannot open). */
async function mustRead(path: string, what: string): Promise<void> {
  try {
    await access(path, constants.R_OK)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new RestoreError(`not a Ligature backup: ${what} is missing (${path})`)
    throw e
  }
}

async function readManifest(dir: string): Promise<{ createdAt: string | null; schemaVersion: number }> {
  const file = join(dir, 'backup.json')
  await mustRead(file, 'backup.json')
  let m: { format?: unknown; createdAt?: unknown; schemaVersion?: unknown }
  try {
    m = JSON.parse(await readFile(file, 'utf8')) as typeof m
  } catch (e) {
    if (e instanceof SyntaxError) throw new RestoreError(`${file} is not valid JSON: ${e.message}`)
    throw e
  }
  if (m === null || typeof m !== 'object') throw new RestoreError(`${file} is not a backup manifest`)
  if (m.format !== BACKUP_FORMAT) throw new RestoreError(`${file}: unknown backup format ${JSON.stringify(m.format)} (expected ${BACKUP_FORMAT})`)
  if (typeof m.schemaVersion !== 'number' || !Number.isInteger(m.schemaVersion) || m.schemaVersion < 1) {
    throw new RestoreError(`${file}: invalid schemaVersion ${JSON.stringify(m.schemaVersion)}`)
  }
  tooNew(m.schemaVersion)
  return { createdAt: typeof m.createdAt === 'string' ? m.createdAt : null, schemaVersion: m.schemaVersion }
}

function tooNew(v: number): void {
  if (v > SCHEMA_VERSION) {
    throw new RestoreError(`the backup has database schema v${v}, but this version of Ligature only knows schemas up to `
      + `v${SCHEMA_VERSION}: it was made by a newer Ligature. Restore it with that version (or a later one).`)
  }
}

const hasTable = (db: DB, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined

/** Every blob hash the database refers to: binary files (trash included) and version contents. */
export function referencedBlobs(db: DB): Set<string> {
  const sql = ['SELECT blob_hash AS h FROM files WHERE blob_hash IS NOT NULL']
  if (hasTable(db, 'version_files')) sql.push('SELECT blob_hash FROM version_files')
  return new Set((db.prepare(sql.join(' UNION ')).all() as { h: string }[]).map(r => r.h))
}

/** Open the backup database read-only, check it, and list the blobs it needs. */
async function checkDatabase(dir: string, schemaVersion: number): Promise<Set<string>> {
  const file = join(dir, 'app.db')
  await mustRead(file, 'app.db')
  let db: DB
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
  } catch (e) {
    throw new RestoreError(`cannot open ${file}: ${(e as Error).message}`)
  }
  try {
    let ok: unknown
    try {
      ok = db.pragma('integrity_check', { simple: true })
    } catch (e) {
      throw new RestoreError(`${file} is not a usable database: ${(e as Error).message}`)
    }
    if (ok !== 'ok') throw new RestoreError(`${file} failed the integrity check: ${String(ok)}`)
    const v = db.pragma('user_version', { simple: true }) as number
    tooNew(v)
    if (v !== schemaVersion) throw new RestoreError(`backup.json says schema v${schemaVersion} but ${file} is at v${v}: the backup was modified`)
    if (!hasTable(db, 'files') || !hasTable(db, 'projects')) throw new RestoreError(`${file} is not a Ligature database`)
    return referencedBlobs(db)
  } finally {
    db.close()
  }
}

/** Relative paths of the regular files under `dir` (a backup holds nothing else). */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(e => e.isFile())
    .map(e => relative(dir, join(e.parentPath, e.name)))
}

/** lstat, or null when nothing is there. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw e
  }
}

const blobPath = (blobs: string, h: string) => join(blobs, h.slice(0, 2), h.slice(2))

/**
 * The hashes of `needed` that `blobs` does not hold as a regular file in a real shard directory. Every level
 * is lstat'ed: a check that followed a symlinked shard directory would pass, but the copy (regular files and
 * directories only) skips it, and the restored instance would lack those blobs.
 */
export function missingBlobs(blobs: string, needed: Iterable<string>): string[] {
  const shardOk = new Map<string, boolean>()
  const missing: string[] = []
  for (const h of needed) {
    if (!HASH_RE.test(h)) throw new RestoreError(`the database refers to an invalid blob hash ${JSON.stringify(h)}`)
    const shard = h.slice(0, 2)
    let ok = shardOk.get(shard)
    if (ok === undefined) shardOk.set(shard, ok = lstatOrNull(join(blobs, shard))?.isDirectory() === true)
    if (!ok || lstatOrNull(blobPath(blobs, h))?.isFile() !== true) missing.push(h)
  }
  return missing
}

const incomplete = (what: string, missing: string[], blobs: string) =>
  new RestoreError(`${what}: ${missing.length} blob(s) its database refers to are missing from ${blobs} `
    + `(e.g. ${missing[0]!.slice(0, 2)}/${missing[0]!.slice(2)}; symbolic links are not restored)`)

async function checkBlobs(dir: string, needed: Set<string>): Promise<number> {
  const blobs = join(dir, 'blobs')
  const st = lstatOrNull(blobs)
  if (st === null) throw new RestoreError(`not a Ligature backup: blobs/ is missing (${blobs})`)
  if (!st.isDirectory()) throw new RestoreError(`${blobs} is not a directory${st.isSymbolicLink() ? ' (a symbolic link: copy the real directory into the backup)' : ''}`)
  await access(blobs, constants.R_OK | constants.X_OK)
  const missing = missingBlobs(blobs, needed)
  if (missing.length) throw incomplete('the backup is incomplete', missing, blobs)
  for (const h of needed) await access(blobPath(blobs, h), constants.R_OK)
  return listFiles(blobs).length
}

/** Everything that can be checked without touching DATA_DIR. */
export async function validateBackup(backupDir: string): Promise<BackupInfo> {
  const dir = resolve(backupDir)
  try {
    if (!existsSync(dir)) throw new RestoreError(`${dir} does not exist (inside the container: did you mount it, e.g. -v /path/to/backup:/restore:ro?)`)
    if (!statSync(dir).isDirectory()) throw new RestoreError(`${dir} is not a directory`)
    await access(dir, constants.R_OK | constants.X_OK)
    const manifest = await readManifest(dir)
    const needed = await checkDatabase(dir, manifest.schemaVersion)
    const blobFiles = await checkBlobs(dir, needed)
    return { dir, createdAt: manifest.createdAt, schemaVersion: manifest.schemaVersion, blobFiles, needed }
  } catch (e) {
    throw explainAccess(e, dir)
  }
}

/* ------------------------------------------------------------------ the data being replaced */

/** Generations the replaced data used: the restored data must go above them. */
export interface PriorState {
  /** False when there is a database but it could not be read (then epochs get UNKNOWN_EPOCH_MARGIN). */
  known: boolean
  epochs: Map<string, number>
  treeVersions: Map<string, number>
}

function bumpMax(m: Map<string, number>, k: unknown, v: unknown): void {
  if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)) m.set(k, Math.max(m.get(k) ?? 0, v))
}

/**
 * Read file epochs and tree versions of DATA_DIR's current database (if any). Opening it read-write and
 * closing it also checkpoints its WAL, so the safety copy is a single file. Epochs of files rebuilt and then
 * deleted are found in the audit log (a tab may still hold one).
 */
export function readPriorState(dataDir: string, log: (line: string) => void): PriorState {
  const prior: PriorState = { known: true, epochs: new Map(), treeVersions: new Map() }
  const file = join(dataDir, 'app.db')
  if (!existsSync(file)) return prior
  let db: DB | null = null
  try {
    db = new Database(file, { fileMustExist: true })
    db.pragma('busy_timeout = 5000')
    for (const r of db.prepare('SELECT id, epoch FROM files').all() as { id: string; epoch: number }[]) bumpMax(prior.epochs, r.id, r.epoch)
    for (const r of db.prepare('SELECT id, tree_version AS v FROM projects').all() as { id: string; v: number }[]) bumpMax(prior.treeVersions, r.id, r.v)
    if (hasTable(db, 'audit_log')) {
      const rows = db.prepare(`SELECT json_extract(detail_json, '$.fileId') AS id, json_extract(detail_json, '$.toEpoch') AS e
        FROM audit_log WHERE action = 'doc.rebuild' AND json_valid(detail_json)`).all() as { id: unknown; e: unknown }[]
      for (const r of rows) bumpMax(prior.epochs, r.id, r.e)
    }
  } catch (e) {
    log(`warning: cannot read the current database (${(e as Error).message}); document generations get a margin of ${UNKNOWN_EPOCH_MARGIN}`)
    prior.known = false
  } finally {
    try { db?.close() } catch { /* already reported */ }
  }
  return prior
}

/* ------------------------------------------------------------------ 3. stage */

function fsyncPath(path: string, dir = false): void {
  // Windows cannot open a directory for fsync; NTFS metadata is journaled anyway.
  if (dir && process.platform === 'win32') return
  // POSIX fsync works on a read-only descriptor (so a read-only file is no obstacle); Windows'
  // FlushFileBuffers needs write access.
  const fd = openSync(path, dir || process.platform !== 'win32' ? 'r' : 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** The modes the server gives its own blobs (umask 022). */
const BLOB_DIR_MODE = 0o755
const BLOB_FILE_MODE = 0o644

/**
 * fs.cp keeps the source's modes. A backup kept read-only (chmod -R a-w) would otherwise leave read-only
 * shard directories in DATA_DIR/blobs: the server could no longer add blobs to them, nor sweep them.
 */
function normalizeModes(dir: string): void {
  chmodSync(dir, BLOB_DIR_MODE)
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isDirectory()) chmodSync(join(e.parentPath, e.name), BLOB_DIR_MODE)
    else if (e.isFile()) chmodSync(join(e.parentPath, e.name), BLOB_FILE_MODE)
  }
}

/** Owner-writable directories all the way down, so that rm can empty them. */
function makeWritable(dir: string): void {
  chmodSync(dir, 0o700)
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) makeWritable(join(dir, e.name))
}

/**
 * Delete the staging folder; never throws, so a cleanup failure cannot replace the error that ended the
 * restore. A copy that failed half-way may have left directories with the backup's read-only modes: made
 * writable, then tried again. Returns a warning when the folder is still there.
 */
async function removeStage(stageDir: string): Promise<string | null> {
  try {
    await rm(stageDir, { recursive: true, force: true })
    return null
  } catch { /* retried below */ }
  try {
    makeWritable(stageDir)
    await rm(stageDir, { recursive: true, force: true })
    return null
  } catch (e) {
    return `could not delete the staging folder ${stageDir} (${(e as Error).message}). It holds a copy of the backup, `
      + 'password hashes included: delete it by hand (chmod -R u+w, then rm -rf)'
  }
}

function fsyncTree(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = join(e.parentPath, e.name)
    if (e.isFile()) fsyncPath(p)
    else if (e.isDirectory()) fsyncPath(p, true)
  }
  fsyncPath(dir, true)
}

interface Prepared { schemaTo: number; projects: number; files: number; docsRenamed: number; blobs: number; sessionsEnded: number }

/**
 * Move every text file to a fresh generation, in one transaction: epoch above anything a client may hold,
 * its doc rows renamed. Project tree versions go above the replaced ones too (clients compare them for
 * equality, and image previews are cached by them).
 */
export function renewGenerations(db: DB, prior: PriorState): number {
  const margin = prior.known ? 0 : UNKNOWN_EPOCH_MARGIN
  const files = db.prepare("SELECT id, project_id AS projectId, epoch FROM files WHERE kind = 'text'").all() as
    { id: string; projectId: string; epoch: number }[]
  const delState = db.prepare('DELETE FROM doc_state WHERE doc_name = ?')
  const delLog = db.prepare('DELETE FROM doc_updates WHERE doc_name = ?')
  const moveState = db.prepare('UPDATE doc_state SET doc_name = ? WHERE doc_name = ?')
  const moveLog = db.prepare('UPDATE doc_updates SET doc_name = ? WHERE doc_name = ?')
  const setEpoch = db.prepare('UPDATE files SET epoch = ? WHERE id = ?')
  for (const f of files) {
    const to = Math.max(f.epoch, prior.epochs.get(f.id) ?? 0) + 1 + margin
    const from = fileDocName(f.projectId, f.id, f.epoch)
    const name = fileDocName(f.projectId, f.id, to)
    delState.run(name) // leftovers under the new name (none expected)
    delLog.run(name)
    moveState.run(name, from)
    moveLog.run(name, from)
    setEpoch.run(to, f.id)
  }
  const projects = db.prepare('SELECT id, tree_version AS v FROM projects').all() as { id: string; v: number }[]
  const setTree = db.prepare('UPDATE projects SET tree_version = ? WHERE id = ?')
  for (const p of projects) setTree.run(Math.max(p.v, prior.treeVersions.get(p.id) ?? 0) + 1 + margin, p.id)
  return files.length
}

/**
 * Migrate the staged database, renew its generations, end every session (see the top of this file) and
 * record the restore; leave it as one fsynced file.
 */
function prepareStaged(file: string, info: BackupInfo, blobs: number, prior: PriorState, safetyName: string | null,
  log: (line: string) => void): Prepared {
  const db = openDb(file, { log })
  try {
    const r = db.transaction((): Prepared => {
      const docsRenamed = renewGenerations(db, prior)
      const sessionsEnded = db.prepare('DELETE FROM sessions').run().changes
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
      const projects = count('SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL')
      const files = count("SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL AND kind <> 'folder'")
      audit(db, {
        actorId: null, action: 'backup.restore',
        detail: { via: 'cli', backupCreatedAt: info.createdAt, schemaVersion: info.schemaVersion, projects, files,
          blobs, docsRenamed, sessionsEnded, safetyCopy: safetyName },
      })
      return { schemaTo: db.pragma('user_version', { simple: true }) as number, projects, files, docsRenamed, blobs, sessionsEnded }
    }).immediate()
    // One self-contained file to rename into place (the server switches it back to WAL when it opens it).
    db.pragma('journal_mode = DELETE')
    return r
  } finally {
    db.close()
  }
}

/** Copy the backup into `stage` (app.db + blobs/), prepare it and fsync everything. */
async function stage(info: BackupInfo, stageDir: string, prior: PriorState, safetyName: string | null,
  log: (line: string) => void): Promise<Prepared> {
  await mkdir(stageDir, { mode: 0o700 })
  const db = join(stageDir, 'app.db')
  const blobs = join(stageDir, 'blobs')
  try {
    await copyFile(join(info.dir, 'app.db'), db)
    await cp(join(info.dir, 'blobs'), blobs, {
      recursive: true, errorOnExist: true, force: false, preserveTimestamps: true,
      // Regular files and directories only: never copy (or follow) a symlink or special file.
      filter: async src => { const st = await lstat(src); return st.isDirectory() || st.isFile() },
    })
    normalizeModes(blobs)
    fsyncTree(blobs)
  } catch (e) {
    throw explainAccess(e, info.dir)
  }
  // Validation and copy must agree (the backup may have changed in between): never swap in fewer blobs.
  const lost = missingBlobs(blobs, info.needed)
  if (lost.length) throw incomplete('the copy of the backup is incomplete (did the backup change during the restore?)', lost, blobs)
  // A backup made read-only must not make the live database read-only; it holds password hashes: 0600.
  await chmod(db, 0o600)
  const r = prepareStaged(db, info, listFiles(blobs).length, prior, safetyName, log)
  fsyncPath(db)
  return r
}

/* ------------------------------------------------------------------ 4. swap */

type Undo = () => Promise<void>

/** A rename that can be undone; skipped when the source does not exist. */
async function move(from: string, to: string, undo: Undo[]): Promise<boolean> {
  if (!existsSync(from)) return false
  await rename(from, to)
  undo.push(() => rename(to, from))
  return true
}

/**
 * Replace DATA_DIR's database and blobs by the staged ones; the old ones go to `safetyDir`. app.db is
 * hard-linked into the safety copy first and then replaced by one atomic rename, so DATA_DIR always has a
 * database. On failure every step done so far is undone.
 */
async function swap(dataDir: string, stageDir: string, safetyDir: string): Promise<void> {
  const undo: Undo[] = []
  try {
    await move(join(dataDir, 'blobs'), join(safetyDir, 'blobs'), undo)
    await move(join(stageDir, 'blobs'), join(dataDir, 'blobs'), undo)
    const live = join(dataDir, 'app.db')
    if (existsSync(live)) {
      const keep = join(safetyDir, 'app.db')
      await link(live, keep).catch(() => copyFile(live, keep, constants.COPYFILE_EXCL))
      undo.push(() => rm(keep, { force: true }))
      // Empty after readPriorState's checkpoint; kept with the database they belong to.
      for (const ext of ['-wal', '-shm']) await move(live + ext, keep + ext, undo)
    }
    await rename(join(stageDir, 'app.db'), live)
  } catch (e) {
    for (const u of undo.reverse()) await u().catch(() => { /* reported below */ })
    throw new RestoreError(`the swap failed and was rolled back (${(e as Error).message}); DATA_DIR still holds the previous data`)
  }
  fsyncPath(dataDir, true)
}

/* ------------------------------------------------------------------ entry */

/** Restore `backupDir` into `dataDir` (the app server must be stopped). */
export async function restore(dataDir: string, backupDir: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const log = opts.log ?? (() => {})
  const now = opts.now ?? new Date()
  const data = resolve(dataDir)
  const src = resolve(backupDir)
  if (isInside(data, src) || isInside(src, join(data, 'blobs')) || src === data) {
    throw new RestoreError(`the backup directory ${src} overlaps DATA_DIR's data; copy it elsewhere first`)
  }
  refuseWhileRunning(data, now.getTime(), opts.force === true, log)
  const info = await validateBackup(src)

  await mkdir(data, { recursive: true })
  const prior = readPriorState(data, log)
  const hadData = existsSync(join(data, 'app.db')) || existsSync(join(data, 'blobs'))
  let safetyDir = join(data, `pre-restore-${stamp(now)}`)
  for (let i = 2; existsSync(safetyDir); i++) safetyDir = join(data, `pre-restore-${stamp(now)}-${i}`)
  const stageDir = join(data, `.restore-${randomBytes(6).toString('hex')}`)

  let prepared: Prepared
  try {
    prepared = await stage(info, stageDir, prior, hadData ? basename(safetyDir) : null, log)
    if (hadData) await mkdir(safetyDir, { mode: 0o700 })
    await swap(data, stageDir, safetyDir)
  } finally {
    // Reported next to the outcome, never instead of it.
    const left = await removeStage(stageDir)
    if (left !== null) log(`warning: ${left}`)
  }
  // PDFs and build products of the replaced data.
  await rm(join(data, 'outputs'), { recursive: true, force: true })

  return {
    backupCreatedAt: info.createdAt, schemaFrom: info.schemaVersion, schemaTo: prepared.schemaTo,
    projects: prepared.projects, files: prepared.files, docsRenamed: prepared.docsRenamed, blobs: prepared.blobs,
    sessionsEnded: prepared.sessionsEnded, safetyDir: hadData ? safetyDir : null,
  }
}
