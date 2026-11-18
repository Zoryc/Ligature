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
]
