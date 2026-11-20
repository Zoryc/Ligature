import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './schema.ts'

export type DB = Database.Database

/** The schema version this code creates and understands (one per migration). */
export const SCHEMA_VERSION = MIGRATIONS.length

/** The database was written by a newer Ligature (e.g. a newer backup restored into older code). */
export class SchemaTooNewError extends Error {}

export interface OpenDbOptions {
  /** Where the schema line goes ('[db] schema v6', '[db] migrated v4 -> v6'); default console.log, silent for ':memory:'. */
  log?: (line: string) => void
}

export function openDb(file: string, opts: OpenDbOptions = {}): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  try {
    // Before anything writes to it: running old code on a newer schema could silently damage it.
    refuseNewerSchema(db, file)
    db.pragma('journal_mode = WAL')
    // FULL: a committed update-log batch survives power loss, not just a process crash.
    db.pragma('synchronous = FULL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    migrate(db, opts.log ?? (file === ':memory:' ? () => {} : console.log))
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

export const schemaVersionOf = (db: DB) => db.pragma('user_version', { simple: true }) as number

function refuseNewerSchema(db: DB, file: string): void {
  const v = schemaVersionOf(db)
  if (v <= SCHEMA_VERSION) return
  throw new SchemaTooNewError(`${file} has database schema v${v}, but this version of Ligature only knows schemas up to `
    + `v${SCHEMA_VERSION}: it was written by a newer Ligature (for example, a backup from a newer version was restored). `
    + 'Run that newer version (or a later one); never go back to older code with this database.')
}

function migrate(db: DB, log: (line: string) => void): void {
  const current = schemaVersionOf(db)
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  log(current === MIGRATIONS.length ? `[db] schema v${current}` : `[db] migrated v${current} -> v${MIGRATIONS.length}`)
}
