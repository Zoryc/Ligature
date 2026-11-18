import { randomUUID } from 'node:crypto'
import { fileDocName } from '@ligature/shared'
import type { DB } from '../db/index.ts'
import type { DocStore } from '../collab/docStore.ts'

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

/** Dev seed: three users (owner / editor / viewer) and one project. Idempotent. */
export function seedDev(db: DB, store: DocStore): void {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get('alice')
  if (exists) return
  const now = Date.now()
  const users = [
    { username: 'alice', display: 'Alice', role: 'owner' },
    { username: 'bob', display: 'Bob', role: 'editor' },
    { username: 'carol', display: 'Carol (viewer)', role: 'viewer' },
  ] as const
  const projectId = randomUUID()
  const rootId = randomUUID()
  const chaptersId = randomUUID()
  const mainId = randomUUID()
  const introId = randomUUID()

  db.transaction(() => {
    const insUser = db.prepare('INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)')
    const insMember = db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
    const insFile = db.prepare(`INSERT INTO files (id, project_id, parent_id, name, kind, epoch, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)`)
    db.prepare('INSERT INTO projects (id, name, root_id, main_file_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, 'Demo paper', rootId, mainId, now)
    insFile.run(rootId, projectId, null, '', 'folder', now)
    insFile.run(mainId, projectId, rootId, 'main.tex', 'text', now)
    insFile.run(chaptersId, projectId, rootId, 'chapters', 'folder', now)
    insFile.run(introId, projectId, chaptersId, 'intro.tex', 'text', now)
    for (const u of users) {
      const id = randomUUID()
      insUser.run(id, u.username, u.display, now)
      insMember.run(projectId, id, u.role)
    }
    store.seed(fileDocName(projectId, mainId, 1), MAIN_TEX)
    store.seed(fileDocName(projectId, introId, 1), INTRO_TEX)
  })()
  console.log('[seed] created users alice (owner), bob (editor), carol (viewer) and project "Demo paper"')
}
