# Ligature: Architecture & Roadmap

*Planning document, 2026-11-18. Library versions were checked on npm today. Items I could not verify are flagged inline and listed under M0 for confirmation.*

---

## 1. Verdict on your idea

**You're right: keep a copy on the server and have clients sync to it.** For accounts and multiple collaborators, that is better than TeXlyre's WebRTC model, for five reasons:
- **Compiling needs the whole project in one place.** A server copy lets you run real TeX Live. The WebRTC route means about 175 MB of WASM TeX per browser and no shell-escape.
- **Accounts need an authority.** In P2P, "permission" means "knows the room link". A server can authenticate every socket, make viewers read-only and revoke access instantly.
- **P2P still needs servers.** You would run signaling, plus TURN for users behind strict NATs. One WebSocket server is simpler.
- **Availability and backups.** In P2P, if nobody holding the latest version is online, collaborators can't get it. With a server copy, a backup is one SQLite file plus one blob folder.
- **History** is easy when one machine sees every change.

**One correction: the server copy must sync *edit operations*, not whole files.** If clients upload whole files and the last upload wins, simultaneous edits get lost. For example, Alice adds `\usepackage{amsmath}` while Bob fixes a typo. Whichever file arrives second silently erases the other person's change. A server copy doesn't remove the need for a merge algorithm; it only decides where that algorithm runs.

**What I recommend: server-authoritative Yjs.**
- Every text file is a Yjs CRDT document.
- Browsers send small updates to the server over one WebSocket.
- The server (Hocuspocus):
  - decides who can connect and who can write,
  - persists the document,
  - and its copy is the one that gets compiled.
- Everything that isn't text stays as ordinary database code: the file tree, images, permissions and history.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript (strict + `noUncheckedIndexedAccess`), end to end** | The server runs the *reference* Yjs, the same code as the browser. Client and server share types and zod schemas, with no glue code. |
| Runtime | Node 24 LTS | Hocuspocus 4 needs Node 22 or later. better-sqlite3 and argon2 ship prebuilt binaries. Avoid Bun for now. |
| HTTP API | Hono + `@hono/node-server`, with zod validation | Small, typed, and uses web-standard Request/Response objects, like Hocuspocus 4's hooks. |
| Sync | `@hocuspocus/server` + `@hocuspocus/provider` 4.8.x, **`yjs@13.6.x` pinned** | The most mature Yjs server: auth hooks, `readOnly` connections, debounced storage, document unloading, `openDirectConnection`. **Do not start on Yjs v14 (`@y/y`); it is still a release candidate.** |
| Database | SQLite in WAL mode via `better-sqlite3` + Drizzle | One file, trivial backups, and plenty for tens of concurrent editors. |
| Passwords | `@node-rs/argon2` (argon2id). Set **m=19456 KiB, t=2, p=1 explicitly**; don't rely on the library defaults. | Prebuilt binaries, so no node-gyp on Windows. |
| Frontend | **Vite + Svelte 5 SPA** (decided) | The editor and PDF viewer don't depend on the framework; Svelte keeps the UI code small. |
| Editor | CodeMirror 6 (`@codemirror/view` 6.43) + `y-codemirror.next` 0.3.6 | Remote cursors and per-user undo out of the box. Overleaf also uses CM6. |
| LaTeX mode | `stex` mode from `@codemirror/legacy-modes` (MIT) | Project is MIT-licensed, so the AGPL `codemirror-lang-latex` is off-limits. Improve highlighting in-house later. |
| PDF | `pdfjs-dist` 6.x (`PDFViewer`) | Text layer, lazy rendering, and an overlay for SyncTeX highlights. |
| TeX | TeX Live 2026 + latexmk in a separate `compiler` container | Full compatibility (biber, glossaries, …). Tectonic is XeTeX-only and is not a sandbox. |
| Tests | Vitest, fast-check, Playwright | Property tests for sync, end-to-end tests with two browsers. |

**Runner-up language: Go.** It would mean a Go API plus a small Node Hocuspocus sidecar. Go's Yjs ports (reearth/ygo, Deln0r/ygo) are 6 to 18 months old and effectively single-maintainer, so you would end up running two languages anyway.

---

## 3. Architecture

```
                      Browser (SPA)
   ┌──────────────────────────────────────────────────────────┐
   │ File tree │ CodeMirror 6 + yCollab │ PDF.js + SyncTeX │ Log │
   └────┬───────────────┬────────────────────────┬────────────┘
        │ REST (cookie) │ WSS /collab (1 socket,  │ GET pdf/log
        │               │ many docs multiplexed)  │
   ┌────▼───────────────▼────────────────────────▼────────────┐
   │ Caddy (optional: TLS + WebSocket proxy)                   │
   └────┬──────────────────────────────────────────────────────┘
   ┌────▼──────────────── app (Node, one process) ─────────────┐
   │ Hono API: auth, projects, members, invites, tree, uploads  │
   │ Hocuspocus: auth → Y.Doc per text file → SQLite update log │
   │ Compile orchestrator: per-project single-flight + semaphore│
   │ History: content-addressed snapshots + manifests           │
   │ data/: app.db (SQLite) · blobs/ab/cdef… (sha256) · outputs/│
   └────┬──────────────────────────────────────────────────────┘
        │ HTTP over a unix socket in a shared "run" volume (no TCP)
   ┌────▼──────── compiler (TeX Live 2026 + small Node worker) ─┐
   │ network_mode: none · read-only rootfs · no secrets · no DB  │
   │ /builds/<projectId> owned by that project's uid, mode 0700  │
   │ helper process setuid(project uid): sync files → latexmk →  │
   │ stream pdf/log/synctex back · timeout + prlimit             │
   └─────────────────────────────────────────────────────────────┘
```

This is two containers (plus optional Caddy). There is no Redis, no Mongo and no Docker socket anywhere.

### What happens on a keystroke
1. You type. `y-codemirror.next` applies the change to the local `Y.Text`, using a local origin so the UndoManager tracks it.
2. Yjs emits a binary update of a few bytes. The provider sends it over the shared socket for doc `proj/<projectId>/file/<fileId>/g<epoch>`.
3. Hocuspocus checks the connection. If it is `readOnly`, the update is dropped. Otherwise the server applies it to its `Y.Doc` and broadcasts it to every other connection on that doc.
4. The persistence extension buffers the update and commits a batch to `doc_updates` every ~200 ms. `onStoreDocument` (debounce 2 s, max 10 s) compacts the log into `doc_state` (Yjs state plus a plain-text mirror) and deletes the merged log rows.
5. Other clients apply the update, and CodeMirror redraws. Remote cursors travel separately through awareness as relative positions.

### What happens on a compile
1. Ctrl+S or the Recompile button sends `POST /api/projects/:id/compile` (editor role required).
2. The orchestrator allows one compile in flight per project. Requests that arrive meanwhile collapse into a single "compile again afterwards". A global semaphore caps concurrency at about half the cores.
3. **Snapshot**, in one synchronous pass with no `await` (so it is atomic in Node): open docs give `ytext.toString()`, closed docs give `doc_state.text`, binary files give their blob hash. Every path is validated. The result is a manifest `{path → sha256}` plus a snapshot id.
4. Over the unix socket, the app sends the manifest. The worker replies with the hashes it doesn't have, and the app uploads only those.
5. The worker spawns a helper that **switches to the project's uid first**. The helper:
   - writes only the files that changed, so mtimes and `.aux` files stay valid and builds are incremental;
   - deletes removed files;
   - mirrors source subdirectories into `out/`, so `\include{chapters/x}` works with `-outdir`;
   - runs latexmk under limits.
6. The helper streams the PDF, log and `.synctex.gz` back, each size-capped. The app stores the last 3 builds, records which snapshot they came from, and broadcasts `compile-finished` on the project channel. The UI shows "PDF is N edits behind" when applicable. The PDF and SyncTeX output are tagged with `{treeVersion, stateVectors}` so the client knows exactly which text each build came from.

---

## 4. Sync design

**Documents**
- Text files get one `Y.Doc` each:
  - the extension is on an allowlist (`.tex .bib .sty .cls .bst .bbx .cbx .txt .md .csv`, …),
  - the content is valid UTF-8,
  - the size is at most 1 MB.

  Everything else is a blob.
- The doc name is `proj/<projectId>/file/<fileId>/g<epoch>`. It **never contains the path**, so renaming or moving a file touches no sync state. Because the epoch is part of the name, any client cache (including a later `y-indexeddb` cache) can never merge stale state into a rebuilt doc.
- Docs load lazily and unload when their last client leaves. Memory therefore scales with open files, not project size.
- Each open project also connects to `proj/<projectId>/meta`. It is an empty doc that carries:
  - awareness: who is online and which file each person has open (avatars in the tree);
  - stateless messages: `tree-changed`, `compile-finished`, `file-deleted`, `access-revoked`.

**Persistence (custom extension, in SQLite)**
- **Update log:** updates are batched every ~200 ms into one `INSERT` into `doc_updates`, run with `synchronous=FULL`. Batching keeps that cheap.
- **Compaction:** in one transaction, write `Y.encodeStateAsUpdate(doc)`, the text mirror and its hash to `doc_state`, then delete the merged log rows. This runs in `onStoreDocument`, on unload, and after N rows.
- **Load:** read `doc_state`, then apply the leftover log rows in order. Yjs updates are idempotent, so replaying them is safe.
- **Startup recovery:** compact any doc that still has log rows, so the text mirror is always current.
- **Shutdown:** flush on SIGTERM / `Server.destroy()`, with `stop_grace_period: 30s`.
- Keep `gc: true`. **Never** use Yjs snapshots for history: they need `gc: false`, and documents then grow without bound.

**Rules against duplicated content (non-negotiable)**
1. **Only the server creates initial content.** If two clients insert into an empty doc concurrently, the content is duplicated.
2. Every server-side edit is applied as a **minimal text diff** (`fast-diff`, delete and insert ranges) through `openDirectConnection`. That covers re-uploading a `.tex`, restoring a version, and a future git pull. Cursors, undo and concurrent edits survive.
3. Never rebuild a `Y.Doc` from text while a client might hold the old one. A full rebuild (rare: compaction of a pathological doc, or corruption recovery) **bumps the epoch**, and only runs when nobody is connected. A stale epoch is rejected in `onAuthenticate` with `reload-required`. If that client has unsynced edits, it shows a **"your changes could not be merged automatically"** dialog with a diff and a copy of its text. Nothing is discarded silently.

**File tree: not a CRDT**
- Create, rename, move and delete are REST calls, each in a single SQLite transaction. Concurrent CRDT moves can duplicate files or create cycles, and tree operations are rare anyway.
- Each project has a **real root folder row**, so a file's `parent_id` is never NULL. Uniqueness is a partial unique index on `(project_id, parent_id, name) WHERE deleted_at IS NULL`. (SQLite treats NULLs as distinct, which would otherwise allow two root-level `main.tex` files.)
- Folder moves get a cycle check (recursive CTE). Each change bumps `projects.tree_rev` and broadcasts `tree-changed`, and clients refetch the tree.
- Delete is a soft delete into the project trash. Open editors of that file close with a notice, and the file can be restored.

**Binary files**
- Stored by sha256 at `data/blobs/ab/cdef…`. A file row points to its current hash, and older hashes are kept as versions.
- Replacing a binary is last-write-wins, plus a toast ("Bob replaced fig1.png"). The old blob stays restorable.
- Uploads are capped at 50 MB by default. Unreferenced blobs are cleaned up by mark-and-sweep.

**History**
- Version snapshots are taken:
  - after 5 minutes of edit activity,
  - on a successful compile (at most once per 10 minutes, and only if something changed),
  - on demand ("named version"),
  - **automatically before every restore** (`pre-restore`).
- A snapshot is a manifest `(path, file_id, blob_hash)`. Text contents are stored as blobs in the same content-addressed store, so unchanged files deduplicate for free. No git binary is needed.
- Attribution comes from `version_authors`, filled from the users who sent updates during that window. The server knows which user owns each connection.
- Diffs are shown with `@codemirror/merge`. A restore is a diff-apply into the live docs, so no epoch bump is needed.
- Git export (or a git bridge) can be built from these manifests later; Co-authored-by trailers can carry attribution.

**Reconnect and offline**
- The Yjs state-vector exchange resends anything the server is missing. The provider reconnects automatically, and **auth and membership are re-checked on every reconnect**.
- If the server crashes while clients are connected, those clients replay their edits on reconnect. The update log covers the case where every client has already left.
- Offline mode (`y-indexeddb`) is planned for later. The epoch-in-name rule makes it safe to add.

---

## 5. Accounts and permissions

**Sessions, not JWTs**
- The session id is 32 random bytes in an `HttpOnly; Secure; SameSite=Lax` cookie. The database stores only `sha256(id)`.
- Sessions have a 30-day sliding expiry. Logging out or changing the password deletes the row, which revokes the session immediately.
- Every mutating request also checks the `Origin` header (CSRF).

**WebSocket authentication**
- The WebSocket upgrade is same-origin, so the session cookie comes along with it.
- **Pitfall:** Hocuspocus only calls `onAuthenticate` when the provider sends a token. Pass a constant, non-empty dummy token, then read the cookie from the request headers in the hook.
- Each document authenticates separately on the multiplexed socket. For each one, `onAuthenticate`:
  1. checks `Origin` (blocks cross-site WebSocket hijacking);
  2. re-reads the session and membership from the database;
  3. checks that the file belongs to the project and that the epoch is current;
  4. sets `connection.readOnly = true` for viewers.
- If the cookie isn't reachable in Hocuspocus 4's hook payload (to verify in M0), fall back to a **reusable** 60-second HMAC ticket fetched by the provider's `token` callback. Never use single-use tickets: they break multiplexing and reconnects.
- **Revocation:** when a member's role changes or they are removed, the server closes all of that user's connections to the project. Their reconnect goes through `onAuthenticate` again.

**Roles**

| Role | Can do |
|---|---|
| `owner` | Everything, including members, invites, settings, delete and transfer ownership. Exactly one owner per project. |
| `editor` | Edit, upload, compile, view and restore history. |
| `viewer` | Read, see cursors, view and download the latest PDF. **Cannot compile** (that would be a free CPU lever). |

A `commenter` role comes later, together with comments.

**Instance settings**
- The first account to register becomes instance admin (`is_admin`, separate from project roles).
- Registration mode is `open`, `invite-only` (the default) or `closed`.
- **Open registration should require the hardened sandbox (gVisor).** The admin page warns if it is enabled without it.

**Invite links**
- 32 random bytes in the URL; the database stores only the hash, plus the role, an expiry (default 7 days), a maximum number of uses, and `revoked_at`.
- Accepting a link requires logging in or signing up, which works even when registration is invite-only.

**Passwords and accounts**
- argon2id, rate limiting per IP and per account, minimum length 10.
- Password reset works by email if SMTP is configured; otherwise an admin uses the CLI (`docker compose exec app ligature reset-password`).

**OIDC / external login: dropped (decision 2026-11-18).** Ligature uses its own accounts only. (If it is ever
reconsidered: a generic issuer via `openid-client`, identities linked by `(issuer, subject)`, never by email alone;
GitHub is not an OIDC provider.)

**Audit log:** logins, membership changes, restores and deletions.

---

## 6. Compile service and sandbox

**Command:** `latexmk -pdf|-pdfxe|-pdflua -interaction=nonstopmode -file-line-error -synctex=1 -outdir=out <main>.tex`
- The engine is a per-project setting.
- The main file is auto-detected (a file containing `\documentclass`) and can be overridden.
- A "Recompile from scratch" option wipes `out/`.

**Threat model.** LaTeX is a Turing-complete program, and it can:
- read files (`\input{/etc/passwd}`, `\openin`, Lua `io.open`);
- write files (`\openout`);
- run shell commands (`\write18`);
- loop forever or flood the disk.

**`openin_any=p` does not reliably restrict LuaTeX's Lua `io` library.** Treat the TeX settings as a first layer only; OS-level isolation is the real boundary.

**Layers (default "uid" sandbox, works on any stock Docker host without SYS_ADMIN, user namespaces or custom seccomp):**

1. **TeX configuration** (environment variables plus a mounted `texmf.cnf` override):
   - `shell_escape=f`. Restricted mode (`p`, which allows `latexminted`) is an explicit per-instance admin opt-in only; unrestricted shell-escape is never allowed.
   - `openin_any=p` and `openout_any=p`.
   - `TEXMFHOME` empty. `HOME`, `TMPDIR` and `TEXMFVAR` point into the project's build directory, so projects don't share `/tmp`.
   - **Pre-generate font caches and formats at image build** (`fmtutil-sys --all`, `luaotfload-tool --update`). Otherwise, with a read-only root filesystem, the first LuaLaTeX/fontspec compile is very slow or fails.
2. **Compiler container** (Compose):
   ```yaml
   compiler:
     network_mode: none          # no network at all; reached only via unix socket
     read_only: true
     cap_drop: [ALL]
     cap_add: [SETUID, SETGID, CHOWN, KILL]   # drop to project uid, chown new dirs, kill timed-out groups
     security_opt: [no-new-privileges:true]
     mem_limit: 4g
     pids_limit: 512
     tmpfs: [/tmp:size=64m]
     volumes: [builds:/builds, run:/run/ligature]   # app data volume is NEVER mounted here
   ```
   The socket directory `/run/ligature` is root-owned with mode 0700, so compile processes cannot talk to the worker.
3. **One Unix uid per project** (`sandbox_uid`, 100000 + n):
   - The worker (root) only creates `/builds/<id>`, then `chmod 0700` and `chown` to that uid.
   - **All file I/O inside the project directory happens in a helper process that has already done `setuid` to the project uid.** That covers writing sources, running latexmk, running synctex and reading outputs. The worker never opens project paths as root, so no `DAC_OVERRIDE` is needed, and one project cannot read another's files.
   - The helper opens outputs with `O_NOFOLLOW` and checks they are regular files before streaming them.
4. **Path validation before materialising files.** Reject `..`, absolute paths, NUL and control characters, and names over a length limit. Paths are always built from DB tree names, never taken raw from a client.
5. **Limits:**
   - `timeout -s KILL 90s` on the process group;
   - `prlimit`: address space 2 GB, file size 200 MB, NPROC, CPU time, open files;
   - log capped at 2 MB, PDF at 100 MB;
   - per-user and per-project rate limits;
   - LRU eviction of build dirs untouched for 7 days, and a volume size alarm.
6. **The app side never touches `/builds`.** Outputs arrive as streams over the socket, so a planted symlink like `output.pdf -> /data/app.db` has nothing to point at.
7. **Browser side:**
   - serve PDFs with `Content-Disposition`, `X-Content-Type-Options: nosniff` and a strict CSP;
   - render only in the PDF.js canvas;
   - escape log text, filenames and anything user-controlled.
8. **Zip import:** reject zip-slip paths and symlinks, and cap total size, file count and compression ratio (zip bombs).

**Pluggable `Sandbox` interface** in the worker, so it can be hardened without a rewrite:
- `uid`: the default above.
- `gvisor`: the same container with `runtime: runsc`, set by the admin in Compose. It needs no Docker socket and is recommended before open registration.
- `bwrap`: opt-in. Inside Docker it needs a custom seccomp profile, Ubuntu 24.04's AppArmor userns setting, and `/proc` handling, so spike it on the real host before relying on it.
- `none`: development only. It **refuses to start when `NODE_ENV=production`**.
- There is deliberately **no** "spawn a container per compile" mode: that needs `docker.sock`, which is root on the host.

**SyncTeX** runs as the project uid:
- forward search: `synctex view -i line:col:file -o out/main.pdf`;
- inverse search: `synctex edit -o page:x:y:out/main.pdf`.

The results are JSON boxes. The app maps build paths back to file ids, and the client draws highlights on the PDF.js overlay. Double-clicking the PDF jumps to the source line.

**TeX Live image strategy**
- Default: `texlive/texlive` (Island of TeX) at a pinned TL2026 tag, full scheme without docs and sources, roughly 4–5 GB (*size and tag names unverified*). Missing-package errors are the worst UX failure, and disk is cheap.
- A `compiler:tl2026-medium` variant (scheme-medium plus curated collections, about 1–2 GB) for small VPSes.
- Tag images by year. Projects store a `texlive_year`, because TL2026 already breaks some 2025 documents. A TL2027 image can later run side by side as another Compose service.

---

## 7. Data model (SQLite)

```
users(id, email UNIQUE COLLATE NOCASE, name, password_hash NULL, is_admin, created_at, disabled_at)
sessions(id_hash PK, user_id, created_at, last_seen_at, expires_at, user_agent)
projects(id, name, owner_id, root_folder_id, main_file_id NULL, engine, texlive_year,
         sandbox_uid UNIQUE, tree_rev, created_at, deleted_at)
project_members(project_id, user_id, role CHECK(owner|editor|viewer), added_by, created_at,
                PK(project_id, user_id))
invites(id, project_id, token_hash UNIQUE, role, created_by, expires_at, max_uses, uses, revoked_at)
files(id UUID, project_id, parent_id, name, kind CHECK(folder|text|binary), blob_hash NULL,
      size, epoch, created_by, created_at, updated_at, deleted_at)
      -- UNIQUE INDEX (project_id, parent_id, name) WHERE deleted_at IS NULL
      -- UNIQUE INDEX (project_id) WHERE parent_id IS NULL      (exactly one root row)
doc_state(file_id PK, epoch, ystate BLOB, text TEXT, text_hash, updated_at)
doc_updates(id INTEGER PK AUTOINCREMENT, file_id, epoch, update BLOB, user_id, created_at)
blobs(hash PK, size, mime, created_at)                      -- files on disk; mark-and-sweep GC
file_versions(file_id, blob_hash, uploaded_by, created_at)  -- binary replacement history
versions(id, project_id, kind CHECK(auto|compile|named|pre_restore), label NULL,
         created_by NULL, created_at)
version_files(version_id, path, file_id, blob_hash, PK(version_id, path))
version_authors(version_id, user_id)
builds(id, project_id, triggered_by, snapshot_id, engine, status, started_at,
       finished_at, duration_ms, error_count, warning_count)   -- outputs in data/outputs/<id>/
audit_log(id, actor_id, project_id NULL, action, detail_json, at)
instance_settings(key PK, value)                             -- registration mode, SMTP, sandbox
```

---

## 8. Repository layout (npm workspaces)

```
apps/server/        Hono API, Hocuspocus + persistence extension, orchestrator, history, CLI
  src/{auth,projects,files,collab,compile,history,db}/   ← collab/ isolates yjs + Hocuspocus
apps/web/           Vite SPA: editor/ (CM6 + yCollab), pdf/, tree/, history/, pages/
apps/compiler/      worker: unix-socket HTTP, manifest sync, Sandbox impls, uid helper, synctex
packages/shared/    zod schemas, API types, stateless-message types, role/permission logic
packages/latex-log-parser/   parser + fixture logs from real projects
docker/             Dockerfile.app, Dockerfile.compiler(.medium), texmf.cnf, compose.yaml,
                    compose.dev.yaml, Caddyfile.example, .env.example
tests/sync/         fast-check convergence/crash property tests
tests/sandbox/      malicious .tex corpus
e2e/                Playwright: two browsers co-editing, permissions, compile
```

**Developing on Windows 11:**
- Install Docker Desktop with the WSL2 backend and **keep the repo inside WSL2 (Ubuntu)**. File watching, permissions and the compiler then behave as in production.
- A native Windows Node process cannot reach a unix socket inside the Docker VM. If you still want to run the app natively on Windows, `compose.dev.yaml` switches the compiler to a dev-only TCP listener on `127.0.0.1`. The app refuses that transport in production.

---

## 9. Milestones (one full-time developer; roughly double for part-time)

| # | Scope | Done when |
|---|---|---|
| **M0: spikes** (≈1 wk) | Hocuspocus 4 and Hono on one Node HTTP server. Cookie auth in `onAuthenticate` (dummy-token behaviour, header access). SQLite update log plus compaction. Compiler container on Linux/WSL2 with the uid helper over the unix socket. LuaLaTeX with a pre-generated font cache. Check whether TL2026 latexmk creates `out/` subdirectories itself. | Two browsers co-edit a file, **`kill -9` of the server loses nothing**, and a PDF comes back from the network-less compiler. |
| **M1: MVP** (≈4–6 wk) | Signup/login with sessions and argon2, registration modes. Projects, members, roles, invite links, revocation. File tree with root row, uploads, soft delete. Co-editing with cursors and project presence. Manual compile with the full uid sandbox. PDF viewer. Log panel with basic `file:line:` errors. Compose file, Caddy example, `ligature backup`. **Malicious-TeX corpus in CI.** | Two users on a VPS co-write and compile a paper with images and a `.bib`. A viewer cannot edit or compile. Every corpus case (`\input{/etc/passwd}`, `\openout`, `\write18`, `\directlua{io.open/io.popen}`, infinite loop, log flood, huge image, reading another project's dir) fails safely. |
| **M2: compile loop** (≈2–3 wk) | Log parser package with fixtures and `@codemirror/lint` gutter markers. SyncTeX in both directions. Auto-compile after 2.5 s idle. Main-file detection, engine setting. Scroll kept across recompiles. Hardened zip import/export. Trash and restore. Rate limits. | Clicking an error or the PDF lands on the right line, and a broken zip cannot escape its directory. |
| **M3: history and robustness** (≈2 wk) | Versions and manifests, diff view, restore with automatic pre-restore version. Compaction with epoch bump plus the recovery dialog. Blob GC. Admin page. **fast-check property test**: N clients, random edits, disconnects, server crash and restart. | The property test passes in CI: all clients converge and the persisted text equals the clients' text. A restore can itself be undone. |
| **Folio UI** (done 2026-11-19) | The redesigned interface (chosen from 10 variants and a mix round): design tokens and self-hosted fonts, Vinculum logo and favicon, three-pane workspace with Contents / Files sidebar, Problems under the editor with inline explanations and a "load the package" quick fix, docked side panels, Settings split into shared (with "changed by …", recorded in the audit log) and personal (auto-compile, font size, wrapping). | The app looks and behaves like the approved Folio mockups. |
| **M4: self-host polish** (done 2026-11-19, spec [M4.md](M4.md)) | Audit log page. (OIDC dropped; password reset, gVisor and the CI-tested backup restore moved to M5+.) `/healthz` that also checks the database, the compiler and the WebSocket upgrade. | Admins can review the audit log, and health checks see real failures. |
| **Writer basics** (later; planned 2026-11-19) | (1) Autocomplete for `\ref{…}` / `\eqref{…}` with the project's labels and `\cite{…}` with its `.bib` keys. (2) Search (and replace) across the whole project, results grouped by file: now planned with rename, see **Rename and replace in all files** below. (3) Spell check of the prose (commands, math and comments skipped), language per project. (4) Word count of the document (main file and its inputs, like `texcount`). | Small, independent items (≈1–2 days each); done when a writer no longer needs another tool for them. |
| **Compile per project** (later; planned 2026-11-20) | One compile per project instead of one per person: when several co-authors' auto-compiles (or a manual compile) ask for the same project while a build of the same text is running or has just finished, the server gives them that build's result instead of compiling again. Same for a compile queued behind a build that timed out on identical sources (seen in the 1.0 deployment test: a second 90 s timeout). Measure first in the Docker stack (two editors auto-compiling at once). | Two people typing at once cause one compile per change, not two; no compile repeats an identical one that just finished or timed out. |
| **More for writers and readers** (later; planned 2026-11-20) | (1) **Math preview on hover**: pointing at `$…$`, `\[…\]` or an equation environment in the source shows it rendered in place (KaTeX/MathJax in the browser, no compile). (2) **Read-only share link**: an owner creates a revocable link that shows the latest PDF to someone without an account (supervisor, reviewer); no source, no editing. (3) **Dark mode**: a dark variant of the Folio design for the interface and the editor (personal setting, follows the system by default). (4) **French interface**, and a way to add other languages (interface strings in translation files). | Each item ships on its own. |
| **Who can join** (later, to rethink; noted 2026-11-21) | Two ideas, not decided yet (today: sign-up stays `invite-only`, where any project owner's invite link can also create an account). (1) **Add by username**: in the Members panel the owner types an existing user's exact username and picks editor/viewer; they join at once and see the project in their list. Exact match only (no search or suggestions, so nobody can list the server's accounts), a neutral answer for unknown names, rate-limited, audited. No email lookup (accounts have no email). (2) **Accounts by admin invite**: a new sign-up mode where only the admin creates sign-up links (single-use, expiring, optionally for a set username; the person chooses their own password), while project invite links only work for people who already have an account. Possibly the default for new servers. Needs (1), since owners can then only add existing accounts. Also considered: new invite links single-use by default; letting editors invite. | The owner of the server controls who has an account; project owners add people without passing links around. |
| **Audit log retention** (later; planned 2026-11-21) | The audit log is small (~200 bytes per entry with indexes, measured: about 4 MB a year for a team of 10), but it grows forever and failed logins can pile up during an attack. The daily maintenance job (which already purges the trash) deletes entries older than `LIGATURE_AUDIT_RETENTION_DAYS` (default 365; `0` = keep forever), and failed logins sooner (default 90 days). The latest `project.setting` entry of each project and setting is always kept, so Settings' "Changed by …" keeps working. Option: instead of deleting, archive old entries to compressed yearly files (`/data/audit-archive/<year>.jsonl.gz`, ~10x smaller, included in backups) for hosts who must keep a full history. Not per-entry compression (entries are too short to gain, and the audit page's filters and "Changed by …" read inside them). | The audit log stays bounded without losing what Settings and recent investigations need. |
| **Archive projects** (later; planned 2026-11-21) | An owner can **archive** a finished project: it leaves the main project list for an "Archived" section, becomes read-only for everyone, and is **stored compressed**. Text (documents, history versions) compresses well, typically 3-5x with zstd (built into Node's zlib) or gzip; uploaded images and PDFs are usually compressed already, so they stay as they are (content-addressed blobs, shared with other projects). Archiving compacts each document's live editing state and update log, then stores the text and version snapshots compressed; **unarchiving** restores them and the project is editable again (a few seconds for a large thesis). Nothing is lost: history, trash and members are kept. Optional later: the admin can archive projects untouched for N months, and the storage report shows the space saved. Backups contain archived projects as they are. | Old projects stop cluttering the list and take a fraction of the space, and come back intact when needed. |
| **Project chat** (later; planned 2026-11-21) | A Chat panel per project (next to History / Members / Settings): short messages between members, live over the project's existing WebSocket channel (no extra connection), stored in the database so people who join later see the conversation. Unread count on the panel button; `@name` mentions highlighted for the person; viewers can read and write (they are part of the team). No email notifications (Ligature sends no mail). Messages of a deleted account show "a former member"; the owner can delete a message; chat is included in backups and follows a retention setting like the audit log. | Co-authors can discuss the paper without leaving it. |
| **Format the LaTeX source** (later; planned 2026-11-21) | A "Format document" command (and Format selection; a keyboard shortcut) that re-indents and tidies the source: environments and braces indented, consistent spacing, optional wrapping of long lines, without changing what the document produces. Preferred engine: **tex-fmt** (fast, written in Rust) compiled to WebAssembly and run **in the browser**, so it costs the server nothing and works on the text as it is now; check its licence (MIT expected) before using it. Alternative: `latexindent` from TeX Live, run in the offline compiler container (the most configurable, but slower and a server round trip). The result is applied as one normal collaborative edit (a minimal diff, like a restore), so co-authors' cursors stay in place and Ctrl+Z undoes it. Personal settings: indent width, wrap column; optionally format on save. | Messy or pasted LaTeX becomes readable in one click, safely and undoably. |
| **Storage quota per user** (later; planned 2026-11-21) | Each account may use up to a set amount of storage, e.g. **1 GB** by default: the admin sets the default in Admin (or `LIGATURE_USER_QUOTA_MB`; `0` = unlimited) and can raise or lower it per user. What counts: the projects the user **owns** (uploaded files, document texts and their history; files shared between projects are content-addressed, so each project counts its own references), including their trash; not build outputs (recreated by a compile). Over the limit: uploads and zip imports are refused with a clear message ("Your projects use 1.02 GB of 1 GB: free space or ask an admin"), typing and compiling keep working (text is tiny next to files); a warning from 90 %. Users see their usage on the Account page (per project), admins in the Storage report. Ownership transfer moves a project's usage to the new owner, who must have room (else the transfer is refused with the reason). Emptying the trash and deleting old versions free space. | No single account can fill the server's disk. |
| **Rename and replace in all files** (later; planned 2026-11-21) | One mechanism, two features: the **server** applies a replace-all to every file's live document (Yjs, through the collaboration server), so the browser sends only the request (a few bytes), never whole files; people with an affected file open receive the change like normal typing, and positions are looked up again at the moment of applying, so someone typing at the same time cannot make it replace the wrong spot. (1) **Rename with F2** (no browser uses F2; Ctrl+R is reload, so not that): on a `\label{…}` or any reference to it (`\ref`, `\eqref`, `\autoref`, `\cref`, …), F2 or right-click → *Rename label* opens a box with the name selected, shows "3 references in 2 files", warns if the new name is taken; Enter renames everywhere at once. LaTeX-aware matching only: whole names inside those commands' braces, never prose, comments or a longer name (`eq:basquin` does not touch `eq:basquin2`); the matching code lives in `packages/shared` so the browser (counting) and the server (replacing) agree exactly. Labels built by macros are listed as "not changed", not guessed. Later the same key renames the project's own commands and citation keys (including in `.bib` files). (2) **Find and replace in all files** (Writer basics item 2): plain text or regular expression, results grouped by file, replace one or all, done by the same server path. Undo: the rename (or replace) is **one entry in your Ctrl+Z history** for the tab, like in VS Code: Ctrl+Z first undoes anything you typed after it, then, on reaching it, the browser sends the reverse operation to the server, which fixes every file at once (a short notice says "Rename undone in 3 files"); Ctrl+Y / Ctrl+Shift+Z redoes it. The reverse is itself a LaTeX-aware rename, not a restore of old text, so co-authors' typing since then is kept (and a `\ref` they added to the new name follows back); if the old name has been taken in the meantime, the undo stops and says why. The entry lives in the tab (gone after a reload, like normal Ctrl+Z history) and is yours only (another member's Ctrl+Z does not undo it). No separate "Undo" toast. Cost: only when used; finding uses the texts the browser already loaded for autocomplete (milliseconds for a thesis). | Renaming a label or replacing a word across a project is one step, safe while others type. |
| **M5+: later** | **Backup restore tested in CI** (back up, wipe, restore, check projects/versions/accounts; `ligature backup` itself exists since M1; moved from M4 on 2026-11-19; no separate upgrade guide). **Password reset** (admin-generated one-time reset link, no email needed; optional email via SMTP settings of an existing mailbox or provider). **gVisor sandbox** (guide + CI test; required before open registration). **In-house LaTeX language support for CodeMirror** (MIT, our own Lezer grammar replacing the basic `stex` mode: accurate highlighting, folding of environments/sections, autocomplete for commands, environments, `\ref` labels and `\cite` keys from the project `.bib`). Comments (anchored with `Y.RelativePosition`), git export or bridge, `y-indexeddb` offline mode, texlab LSP, multiple TeX Live years, track changes (last, on purpose). | Driven by real user requests. |

**About 5–8 weeks to a safe MVP (M0 + M1), and about 11 weeks to M4.**

---

## 10. Risks and mitigations

1. **Compile escape or denial of service.** Use the layered sandbox: no network, uid per project, all project I/O done as that uid, no secrets in the container, prlimit and timeout. Keep the malicious corpus in CI and require gVisor before open registration. Never mount `docker.sock`.
2. **Duplicated or lost text.** Only the server seeds content, server-side edits are applied as diffs, the epoch is part of the doc name, the update log is batched with `synchronous=FULL`, and compaction is transactional. Back this with property tests and a kill-the-server end-to-end test.
3. **Dependency churn (Yjs v14, Hocuspocus majors).** Pin `yjs@13.6.x`, `y-codemirror.next@0.3.x` and `@hocuspocus/*@4.8.x`, and keep them behind `collab/` on both sides. The stored format is plain Yjs updates, which y-websocket-server or YHub can also read.
4. **Sandbox fragility across hosts.** The default `uid` mode needs no user namespaces, seccomp changes or cgroup delegation. bwrap and gVisor are opt-in and spiked on the target host first.
5. **TeX Live breakage and image size.** Images are pinned per year, projects store `texlive_year`, full and medium variants exist, and missing `.sty` files are reported clearly.
6. **WebSockets behind proxies.** Ship Caddy and nginx examples (Upgrade headers, `proxy_read_timeout` of at least 1 h) and the `/healthz` WebSocket check.
7. **Large documents.** The 1 MB text threshold, lazy load and unload, compaction, and a raised WebSocket max payload for the first sync.
8. **Scope creep toward Overleaf.** See the non-goals below.

**Non-goals for v1:** track changes, a rich-text "visual editor", comments, a git bridge, offline mode, multi-node scaling (Redis), browser/WASM compiles, shell-escape/minted by default, Typst, and per-user quotas beyond rate limits.

---

## 11. Decisions

| Topic | Decision (2026-11-18) | Consequence |
|---|---|---|
| Licence | **MIT** | Do not copy code from AGPL projects (Overleaf, `codemirror-lang-latex`, TeXlyre, Aldine). They may be *read* for ideas only. LaTeX highlighting starts from the MIT `stex` legacy mode and is improved in-house later (a Lezer grammar is a possible M5+ item). |
| Devices | **Computers only** (decided 2026-11-20) | Ligature is built for a desktop or laptop screen with a keyboard. No phone layout is planned. A tablet in landscape with a keyboard works like a small laptop (the layout needs about 1100 px of width); it is not a target and is not tested. |
| Typesetting | **LaTeX only** (decided 2026-11-21) | Typst is not planned (removed from M5+). It may be reconsidered in the far future; until then the editor, compiler and features are built for LaTeX. |
| Users | **Trusted team / lab** | The default `uid` sandbox is sufficient. Registration stays `invite-only` by default. gVisor remains an optional hardening documented in M4, not a requirement. |
| Frontend | **Svelte 5 + Vite** (TypeScript) | Less boilerplate than React for a solo developer. CodeMirror, Yjs and PDF.js are framework-agnostic, so they are wrapped in thin Svelte components. |
| Backend language | **TypeScript on Node 24** | As in section 2. |
| TeX features | **Defaults** | pdfLaTeX, XeLaTeX and LuaLaTeX available; fonts only from TeX Live (font caches pre-generated in the image); shell-escape off. `minted` works only if an admin enables restricted shell-escape; `listings` is the recommended alternative. |
| Where PDFs compile | **On the server** | One TeX Live in the compiler container; browsers only download and display the PDF with PDF.js. No WASM TeX in the browser (a non-goal for v1). |

Sync design research and the alternatives considered: [SYNC.md](SYNC.md).

## 12. M0 results (2026-11-18)

**Done-criteria met** on Windows 11 with TinyTeX (TeX Live 2026): two browsers co-edit with live cursors; `kill -9` of the server loses nothing (automated, three scenarios); a real PDF comes back from the compiler worker. 300+ automated tests across `packages/shared`, `apps/server`, `apps/compiler` and `apps/web`.

**Verified facts**
- Hocuspocus 4.8: the provider always sends an Auth message (empty token is fine) and `onAuthenticate` always runs with `requestHeaders`, so **cookie auth works** with no ticket endpoint. The provider token may also be a function. Mounting on our own `ws` server via `hocuspocus.handleConnection(ws, Request)` gives one HTTP server for API + WebSocket.
- Read-only connections are enforced by the server (updates rejected), and `beforeHandleAwareness` lets the server stamp presence identity; both are covered by e2e tests.
- latexmk (TL2026) creates `out/<subdir>/` itself for `\include{chapters/x}` with `-outdir`.
- Native Windows development needs **no Docker**: compiler worker with `SANDBOX=none` + TinyTeX. Multi-user testing in one browser works via `*.localhost` subdomains (dev-only origin rule).

**Deviations from the plan**
- npm workspaces instead of pnpm (nothing extra to install).
- Persistence listens to `Y.Doc` `update` events directly (synchronous, same tick) instead of `onChange`.
- Compiler: `latexmk -norc`, absolute `-outdir`, per-project `src/` + `out/` layout, outputs served from a worker-owned store; disk quota and blob/build-dir eviction already in M0.

**Still unverified (needs Linux / Docker)**
- The `uid` sandbox (setuid helper, chown, prlimit, reaping) has never run; it needs Linux as root.
- Docker images are unbuilt; the Island of TeX `TL2026` tag and image sizes are unconfirmed; font caches with `TEXMFVAR` inside the project need checking.
- Known window: up to ~200 ms of acknowledged edits live only in the write buffer; if the server is killed *and* every client holding them is gone, they are lost (clients re-send them on reconnect otherwise). `y-indexeddb` (M5+) closes it.

## 13. M1 results (2026-11-18)

**Done-criteria met.** Verified in the browser: password login, project creation, upload of a PNG and a `.bib`,
a compile with the image and a bibtex-resolved citation, an invite link accepted by a second user (logged out ->
log in -> back to the invite -> joined), and removal of that member kicking their open editor immediately.
CI on Linux (GitHub Actions): the `uid` sandbox and the 12-case malicious-TeX corpus run **as root** with the
production TeX Live 2026 image and pass; both Docker images build and a smoke test drives signup, project, upload,
compile, PDF download and the `ligature` CLI through the real API. Locally ~470 tests pass.

**Resolved from M0's unverified list:** the `uid` sandbox works on Linux; Docker images build
(`texlive/texlive:latest-full` / `latest-medium`, pinned by digest); the TeX Live 2026 font cache works with a
per-project `TEXMFVAR` when it is pre-generated system-wide.

**Decisions taken in M1** (see `docs/M1.md` for the full contract)
- Usernames instead of emails (no SMTP needed yet). Sibling file names are unique case-insensitively.
- Text uploads are normalised to `\n` line endings and lose a UTF-8 BOM (a `\r` would desynchronise CodeMirror and Yjs).
- An admin cannot remove their own admin flag or disable themselves (`409 last-admin`).
- Role changes close the user's live connections too; they reconnect with the new role (e.g. read-only).
- The compiler runs TeX with `max_print_line=10000` so logs are not wrapped (needed for `file:line` parsing).

**Security findings (documented, tested as KNOWN GAPS in CI)**
- TeX Live 2026's kpathsea no longer applies `openin_any` to reading, and LuaTeX's `io` library ignores it anyway,
  so a document can **read world-readable files** of the compiler container (e.g. `/etc/passwd`). The container holds
  no secrets and each project runs as its own uid (other projects are 0700), so nothing sensitive is reachable.
- LuaTeX allows `lfs.chdir("..")` and then relative writes, so a document can write into **world-writable**
  directories outside its project. Production has none (read-only root, `/tmp` 0700, `ipc: none`); CI asserts this.
- Closing both completely needs a stronger sandbox (gVisor or bwrap) — required before open registration (M4).

**Still open after M1**
- Uploads are buffered in memory (bounded: at most 8 × 50 MB per process); streaming to disk is a later refactor.
- Rate limits, upload slots and WebSocket caps are in memory, per process (fine for one server).
- No blob garbage collection yet (M3).

## 14. M2 results (2026-11-18)

**Done-criteria met**, verified in the browser: deleting a folder puts **one** entry in the trash can (who, when,
size, "deleted forever in 30 days"); restoring it next to a new folder of the same name brings it back as
`chapters (restored)/` with the file content intact; auto-compile runs ~2.5 s after typing; an error shows as a gutter
marker + underline + problems-list entry (`main.tex:9`); double-clicking the PDF lands on the right source line and
"Show in PDF" highlights the right spot. ~890 automated tests locally; CI covers the same on Linux.

**What was built** (see `docs/M2.md`)
- `packages/latex-log-parser` (own MIT code): errors, LaTeX/package/class/font warnings, bad boxes, undefined
  references/citations, missing files, BibTeX/Biber, with file attribution from the TeX file stack; fixtures are real
  pdf/xe/lualatex logs (sanitised of local paths).
- `packages/synctex` (own MIT code): agrees with the `synctex` CLI on 99% of forward lookups and 97.8% of inverse
  clicks on text (pdfLaTeX/XeLaTeX). Known difference: in some LuaLaTeX layouts the CLI answers the `\end{document}`
  line where we return the real line (we prefer ours).
- Server: trash batches (migration 3), restore with clash renaming, purge, empty, 30-day retention; zip export and
  hardened import (limits enforced while inflating, symlinks/encrypted/duplicate/NFC-twin names refused, junk skipped,
  main file detected, atomic); diagnostics mapped to file ids; SyncTeX routes with a parsing worker thread and budgets;
  per-user compile rate limit and queue cap; main-file detection at compile time.
- Web: trash can panel, lint gutter + problems list, SyncTeX both ways, auto-compile toggle, Ctrl/Cmd+S, zip UI.

**Still open after M2**
- SyncTeX/diagnostic positions are mapped through *your own* edits since the build; edits others make to files you
  don't have open are not accounted for until the next build.
- Missing-package errors carry no line number (TeX's log doesn't give one); errors raised while a TeX Live package
  loads are attributed to the project file without a line.
- M1 uploads still have no body deadline (imports do); NFC/NFD twin names are only refused on zip import.

## 15. M3 results (2026-11-18)

**Done-criteria met.** The sync property test (fast-check; 3 clients; random concurrent edits, disconnects, offline
edits, `SIGKILL` + restart of the real server, a log-only recovery step and a graceful restart) passes locally and
in CI; it was mutation-checked (with persistence of updates disabled it fails on the first run). Verified in the
browser: a named version, a side-by-side diff against the current state, restore of the whole project (applied
in place, no reconnect), **Undo** from the toast, and the "Before restoring…" backups in the history list.

**Decision:** own versioning (content-addressed manifests in SQLite + the blob store), not git; a git export /
bridge can be layered on later.

**What was built** (see `docs/M3.md`)
- Versions: auto (5 min of activity, last client leaving), compile, named, pre-restore, import; dedupe by manifest
  hash; authors per version; the original state is versioned before the first change; retention thinning.
- Diff by file id then path (renames), against the previous version or the current state; per-file content and
  zip download of any version.
- Restore of a whole project or single files: pre-restore version, text applied as Yjs diffs, renames reverted,
  trashed files restored, purged files recreated, extra files moved to the trash; `version-restored` event with Undo.
- Maintenance: blob GC (live + trashed + version references, 24 h grace on mtime), orphan doc rows, 30-day purge of
  deleted projects, oversized-document rebuild with epoch bump and a recovery dialog, admin storage page.

**Still open after M3**
- No way yet to **erase content from history** (e.g. a pasted secret): named and pre-restore versions are never
  thinned. An owner/admin "purge from history" action is the natural follow-up.
- Labels nest when an undo is undone (`Before restoring "Before restoring "Draft 1""`).
- Version-list and diff requests against `current` take a full snapshot each time (rate-limited, not cached).
- Tests use fixed ports; on Linux the ephemeral port range must not overlap them (CI sets it; README explains).
