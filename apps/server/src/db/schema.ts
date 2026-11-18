/**
 * Schema migrations. Each entry runs once, in order, inside a transaction.
 * Never edit a shipped migration; append a new one.
 */
export const MIGRATIONS: string[] = [
  /* 1: core tables (M0 subset of PLAN.md §7) */ `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash    TEXT PRIMARY KEY,           -- sha256(cookie token); the raw token is never stored
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    root_id       TEXT NOT NULL,
    main_file_id  TEXT,
    engine        TEXT NOT NULL DEFAULT 'pdflatex',
    tree_version  INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE project_members (
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
    PRIMARY KEY (project_id, user_id)
  );

  -- File tree. Every project has exactly one root folder row (parent_id NULL);
  -- every other row has a non-NULL parent, so the unique index below really is unique.
  CREATE TABLE files (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id     TEXT REFERENCES files(id),
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('folder','text','binary')),
    epoch         INTEGER NOT NULL DEFAULT 1,   -- text files: Yjs doc generation
    blob_hash     TEXT,                         -- binary files: sha256
    deleted_at    INTEGER,
    created_at    INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX files_unique_name ON files(project_id, parent_id, name) WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX files_one_root ON files(project_id) WHERE parent_id IS NULL;

  -- Yjs persistence: append-only update log + compacted state per doc.
  CREATE TABLE doc_updates (
    doc_name      TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    update_blob   BLOB NOT NULL,
    user_id       TEXT,
    ts            INTEGER NOT NULL,
    PRIMARY KEY (doc_name, seq)
  );

  CREATE TABLE doc_state (
    doc_name      TEXT PRIMARY KEY,
    upto_seq      INTEGER NOT NULL,              -- all updates with seq <= upto_seq are merged into state
    state         BLOB NOT NULL,                 -- Y.encodeStateAsUpdate
    text          TEXT NOT NULL,                 -- plain-text mirror, for compiles of closed docs
    text_hash     TEXT NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  `,

  /* 2: M1 — accounts, soft deletes, invites, blobs, audit log (docs/M1.md §7) */ `
  ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN disabled_at INTEGER;
  ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
  ALTER TABLE projects ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE project_members ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE files ADD COLUMN size INTEGER;
  ALTER TABLE files ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE instance_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
    created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER);
  CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, project_id TEXT,
    action TEXT NOT NULL, detail_json TEXT, at INTEGER NOT NULL);

  CREATE INDEX invites_project ON invites(project_id);
  CREATE INDEX members_user ON project_members(user_id);
  CREATE INDEX files_project ON files(project_id);
  CREATE INDEX audit_log_at ON audit_log(at);

  -- Backfill timestamps of rows created before this migration.
  UPDATE projects SET updated_at = created_at;
  UPDATE files SET updated_at = created_at;
  UPDATE project_members SET added_at = (SELECT created_at FROM projects p WHERE p.id = project_id);
  UPDATE sessions SET last_seen_at = created_at;
  -- An existing instance (M0) has no admin yet: the oldest account becomes admin.
  UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1);
  `,

  /* 3: M2 — trash can (docs/M2.md §1) */ `
  ALTER TABLE files ADD COLUMN deleted_by TEXT;          -- user id
  ALTER TABLE files ADD COLUMN delete_batch TEXT;        -- uuid shared by everything removed in one deletion
  CREATE INDEX files_trash ON files(project_id, delete_batch) WHERE deleted_at IS NOT NULL;
  -- Implementation details of the trash (not in the spec's SQL):
  -- the row's parent was purged while this row was still in the trash (its parent_id now points at the root)
  ALTER TABLE files ADD COLUMN trash_orphan INTEGER NOT NULL DEFAULT 0;
  -- the row was the project's main file when it was deleted (restoring it sets the main file back)
  ALTER TABLE files ADD COLUMN was_main INTEGER NOT NULL DEFAULT 0;

  -- Rows deleted before this migration have no batch: each top-level deleted row (parent live, or deleted
  -- at a different time) becomes its own batch, named by its id; its descendants deleted at the same time join it.
  WITH RECURSIVE b(id, batch, at) AS (
    SELECT c.id, c.id, c.deleted_at FROM files c LEFT JOIN files p ON p.id = c.parent_id
      WHERE c.deleted_at IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NULL OR p.deleted_at <> c.deleted_at)
    UNION ALL
    SELECT c.id, b.batch, c.deleted_at FROM files c JOIN b ON c.parent_id = b.id WHERE c.deleted_at = b.at
  )
  UPDATE files SET delete_batch = (SELECT batch FROM b WHERE b.id = files.id) WHERE deleted_at IS NOT NULL;
  -- Who deleted them, when the M1 audit log knows.
  UPDATE files SET deleted_by = (SELECT a.actor_id FROM audit_log a WHERE a.action = 'file-delete'
      AND a.project_id = files.project_id AND json_extract(a.detail_json, '$.fileId') = files.delete_batch
      ORDER BY a.id DESC LIMIT 1)
    WHERE deleted_at IS NOT NULL;
  `,

  /* 4: M3 — versions (docs/M3.md §1) */ `
  CREATE TABLE versions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('auto','compile','named','pre_restore','import')),
    label TEXT, created_by TEXT, created_at INTEGER NOT NULL,
    tree_version INTEGER NOT NULL,
    manifest_hash TEXT NOT NULL                     -- sha256 of the sorted (path, file_id, hash) list: dedupe
  );
  CREATE INDEX versions_project ON versions(project_id, created_at DESC);
  CREATE TABLE version_files (
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL, file_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('text','binary')),
    blob_hash TEXT NOT NULL, size INTEGER NOT NULL,
    PRIMARY KEY (version_id, path));
  CREATE INDEX version_files_blob ON version_files(blob_hash);
  CREATE TABLE version_authors (
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, PRIMARY KEY (version_id, user_id));
  ALTER TABLE projects ADD COLUMN dirty_since INTEGER;          -- first unsnapshotted change
  ALTER TABLE projects ADD COLUMN last_change_at INTEGER;
  CREATE TABLE pending_authors (project_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (project_id, user_id));

  -- Implementation detail (not in the spec's SQL): projects that existed before M3 are "dirty since
  -- forever", so the first scheduler pass takes an auto version of their current state.
  UPDATE projects SET dirty_since = 0 WHERE deleted_at IS NULL;
  `,
]
