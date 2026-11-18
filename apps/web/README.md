# @ligature/web

The browser app: Svelte 5 + Vite + TypeScript. The UI is plain on purpose (simple CSS, no design system).

## Run (development)

From the repo root, in two terminals:

```sh
npm run dev:server   # API + collaboration server on http://127.0.0.1:3000
npm run dev:web      # Vite on http://localhost:5173 (proxies /api and /collab to :3000)
```

Open http://localhost:5173 and log in. In development the server seeds alice (owner, admin), bob (editor) and carol (viewer)
with the password `ligature-dev-password`; the login page also shows quick-login buttons when the server reports `devLogin`.
To try co-editing, use two browsers, or a second origin with its own cookies such as http://bob.localhost:5173.

Ports are configurable: `LIGATURE_API_PORT` (where the Vite proxy sends /api and /collab, default 3000) and
`LIGATURE_WEB_PORT` (Vite's own port, default 5173). The server's ALLOWED_ORIGINS must include the Vite origin
(in development any http://*.localhost:<port> origin is accepted).

Compiling needs the compiler worker on `http://127.0.0.1:7071` (see the repo docs). Without it, Recompile shows
"Compiler unavailable" in the log panel.

Keyboard: Ctrl/Cmd+S compiles (never the browser's save dialog); Ctrl+Alt+J shows the cursor's line in the PDF;
double-click in the PDF opens the source at that line. Auto-compile (owners/editors) is a per-project toggle stored in
`localStorage` under `ligature:auto-compile:<projectId>`, on by default.

Use `localhost`, not `127.0.0.1`. The server checks the `Origin` header against `http://localhost:5173`.
The Vite proxy forwards the browser's Origin as it is (`changeOrigin` is deliberately off).

## Scripts (run in `apps/web`)

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build to `dist/` (static files) |
| `npm run typecheck` | `svelte-check` (uses this package's own TypeScript 5.9, because svelte-check does not support TS 7 yet) |
| `npm test` | Vitest unit tests for the pure helpers (log parsing, tree ops, routes, errors, events, "PDF is behind", colours, trash display, diagnostic positions, auto-compile scheduler, PDF coordinates, zip import) |

## Layout

```
src/
  main.ts, App.svelte        hash routing: #/login, #/signup, #/invite/:token, #/projects, #/project/:id, #/account, #/admin
  pages/                     Login, Signup, Invite, Projects, Account, Admin, Project (tree | editor | PDF + log)
  lib/api.ts                 REST client (cookie session; 401 -> login page) + raw uploads with progress (XHR)
  lib/routes.ts              pure route parsing, safe ?next= handling
  lib/errors.ts              server error codes -> friendly messages
  lib/validation.ts          client-side username/password/display-name checks, who may sign up
  lib/treeOps.ts             paths, name checks, move targets, drop targets, upload planning
  lib/projectEvents.ts       MetaEvent / CLOSE reason / auth-failure -> actions for the project page
  lib/dialogs.svelte.ts      in-page confirm/prompt/select dialogs (DialogHost.svelte)
  lib/SettingsPanel.svelte   rename (owner), engine + main file (owner/editor)
  lib/MembersPanel.svelte    members, roles, transfer, invites (owner); leave (others)
  lib/collab.ts              one shared Hocuspocus socket per page, one provider per open file, meta doc for presence + events
  lib/presence.ts            sanitizes remote presence (awareness) states: colours derived from the user id, names capped
  lib/behind.ts              "PDF is behind" (state vector + delete set comparison against the build)
  lib/buildEvents.ts         tells our own compile-finished broadcasts from collaborators' ones
  lib/Editor.svelte          CodeMirror 6 + y-codemirror.next (Y.UndoManager undo, stex highlighting, read-only for viewers)
  lib/PdfView.svelte         pdf.js 6, lazy-loaded; only pages near the viewport have a canvas; keeps the scroll position;
                             zoom; double-click = SyncTeX inverse search; showBoxes() = fading forward-search highlight
  lib/LogPanel.svelte        build status, problems list (click: open the file at the line), raw log
  lib/FileTree.svelte        tree + file actions (new, rename, move, move to trash, set main, download, upload, drag-and-drop),
                             trash button with count; highlights a restored item
  lib/TrashPanel.svelte      trash can: restore, restore to…, delete forever, empty trash (owner)
  lib/trash.ts               trash sorting and display texts
  lib/diagnostics.ts         build diagnostics anchored to the text, mapped through Y.Text changes until the next build
  lib/autoCompile.ts         auto-compile scheduler (2.5 s after local edits, one at a time, back-off on 429/503) + per-project toggle
  lib/pdfCoords.ts           PDF points <-> page pixels at any zoom (SyncTeX), zoom steps
  lib/zipImport.ts           zip import name + report shown when the new project opens
```

## Deploying the build

`npm run build` writes static files to `dist/`. Whatever serves them (the app server or Caddy) must:

- serve `.mjs` as `text/javascript`: pdf.js loads `assets/pdf.worker.min-*.mjs` as a module worker, and browsers
  refuse module scripts with another MIME type;
- serve the page from the origin the server's Origin check expects, with `/api` and `/collab` on the same origin.

Source maps are not emitted; run `npx vite build --sourcemap` for a debug build.

## Server-side follow-ups (not in this package)

- Presence is relayed by the collaboration server unchecked. The client sanitizes colours and names, but a member can
  still claim another user's id or name; only the server can drop awareness states whose `user.id` is not the
  connection's user.
- "PDF is behind" sees deletion-only edits reliably only if the build result carries `snapshot.docSnapshots`
  (`fileId -> base64 Y.encodeSnapshot(Y.snapshot(liveDoc))`); without it the client falls back to a local baseline
  (see `src/lib/behind.ts`).
