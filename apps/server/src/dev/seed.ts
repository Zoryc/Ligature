import { randomUUID } from 'node:crypto'
import { fileDocName } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import type { DocStore } from '../collab/docStore.ts'
import { hashPasswordSync } from '../auth/password.ts'

/** Password of the seeded dev users, so they can also use the normal login form. */
export const DEV_PASSWORD = 'ligature-dev-password'

const MAIN_TEX = String.raw`\documentclass{article}
\usepackage[utf8]{inputenc}
\title{Ligature demo}
\author{Alice \and Bob}

\begin{document}
\maketitle

\input{chapters/intro}

\section{Results}
Edit me from two browsers at once.

\end{document}
`

const INTRO_TEX = String.raw`\section{Introduction}
This file lives in a subfolder, to check that \verb|\input{chapters/intro}| works with \texttt{-outdir}.
`

/**
 * Dev seed: three users (owner / editor / viewer; alice is instance admin) and one project.
 * Idempotent. Upgrades an M0 dev database (users without passwords) in place.
 */
export function seedDev(db: DB, store: DocStore): void {
  const users = [
    { username: 'alice', display: 'Alice', role: 'owner', admin: true },
    { username: 'bob', display: 'Bob', role: 'editor', admin: false },
    { username: 'carol', display: 'Carol (viewer)', role: 'viewer', admin: false },
  ] as const
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get('alice')
  if (exists) {
    const missing = db.prepare(`SELECT id FROM users WHERE username IN ('alice','bob','carol') AND password_hash IS NULL`).all() as { id: string }[]
    if (missing.length) {
      const hash = hashPasswordSync(DEV_PASSWORD)
      const upd = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      db.transaction(() => { for (const m of missing) upd.run(hash, m.id) })()
    }
    return
  }
  const now = Date.now()
  const hash = hashPasswordSync(DEV_PASSWORD)
  const projectId = randomUUID()
  const rootId = randomUUID()
  const chaptersId = randomUUID()
  const mainId = randomUUID()
  const introId = randomUUID()

  db.transaction(() => {
    const insUser = db.prepare('INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    const insMember = db.prepare('INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)')
    const insFile = db.prepare(`INSERT INTO files (id, project_id, parent_id, name, kind, epoch, size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    db.prepare('INSERT INTO projects (id, name, root_id, main_file_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(projectId, 'Demo paper', rootId, mainId, now, now)
    insFile.run(rootId, projectId, null, '', 'folder', null, now, now)
    insFile.run(mainId, projectId, rootId, 'main.tex', 'text', Buffer.byteLength(MAIN_TEX), now, now)
    insFile.run(chaptersId, projectId, rootId, 'chapters', 'folder', null, now, now)
    insFile.run(introId, projectId, chaptersId, 'intro.tex', 'text', Buffer.byteLength(INTRO_TEX), now, now)
    users.forEach((u, i) => {
      const id = randomUUID()
      insUser.run(id, u.username, u.display, hash, u.admin ? 1 : 0, now + i) // distinct created_at keeps alice first
      insMember.run(projectId, id, u.role, now)
    })
    store.seed(fileDocName(projectId, mainId, 1), MAIN_TEX)
    store.seed(fileDocName(projectId, introId, 1), INTRO_TEX)
  })()
  console.log('[seed] created users alice (owner, admin), bob (editor), carol (viewer) with password ' +
    `"${DEV_PASSWORD}" and project "Demo paper"`)
}
