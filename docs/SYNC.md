# Communication models for Ligature

*Architecture decision record, 2026-11-18. Facts were checked against npm, crates.io, Hex, PyPI, GitHub source and vendor docs on or about this date. Items marked **(unverified)** could not be confirmed from a primary source.*

> **How this relates to [PLAN.md](PLAN.md).** This document is the research behind the sync design. The two agree on the model: server-authoritative Yjs, one doc per text file, a file tree that is not a CRDT, a snapshot barrier for compiles, and blobs for binary files. Where they differ in detail, **PLAN.md is authoritative**:
> - **Auth:** session cookie plus `Origin` check in `onAuthenticate` (PLAN §5). The short-lived token in §3.3 below is the fallback if Hocuspocus 4 doesn't expose request headers there. If used, the provider's token must be fetched fresh on every (re)connect, never single-use.
> - **Persistence:** updates are batched every ~200 ms with `synchronous=FULL`, not written one by one (§3.7 below). That keeps the event loop free during bursts of edits.
> - **History:** content-addressed manifests in SQLite (PLAN §4), not a per-project git repo.
> - **Text doc size cap:** 1 MB (PLAN), not 2 MB.
> - **Doc naming:** PLAN adopted the naming from §3.4 here: `proj/<projectId>/file/<fileId>/g<epoch>`, plus `proj/<projectId>/meta` for the project channel.

---

## 1. Answer

**Use server-authoritative Yjs v13: one `Y.Doc` per text file, served by Hocuspocus v4 in a single Node process, with the browser on CodeMirror 6 through `y-codemirror.next`.** The project file tree is not a CRDT. It is a server-owned manifest in SQLite or Postgres that changes only through validated RPCs. Each RPC bumps a project version and broadcasts an ordered event.

- **Binary files** (images, PDFs) are uploaded over HTTP into a content-addressed (sha256) store.
- **Persistence** is your own code: an append-only update log plus snapshot compaction, not Hocuspocus's stock full-snapshot store.
- **Compiles** start from a "snapshot barrier": the server reads its in-memory docs in one synchronous event-loop step and writes them into the compile directory.

This gives the user what they asked for: one authoritative copy on the server, which holds the full current project state on disk for latexmk. Most of the hard parts come ready-made:
- remote cursors and per-user undo (`y-codemirror.next` plus `Y.UndoManager`)
- reconnect catch-up (state-vector sync)
- optional offline editing (`y-indexeddb`)
- auth and read-only hooks, many docs over one socket, and load/unload lifecycle (Hocuspocus)

All of it is MIT-licensed and the most widely used stack in this space (yjs about 16.3M downloads/week, @hocuspocus/server about 2.07M/week). The pure central-OT option, `@codemirror/collab`, has a simpler algorithm. But you would hand-build transport, presence, reconnect, persistence and offline, so it is the runner-up (section 4), not the default. At 1-50 users and LaTeX files of roughly 10-300 KB, CRDT speed and memory are not deciding factors. The deciding factors are editor binding, undo, server hooks and maintenance, and Yjs wins on all four.

---

## 2. Comparison of realistic candidates

| Candidate | Concurrency model | Server role | Offline | History / undo | Maturity (Nov 2026) | Implementation effort | Fit for Ligature |
|---|---|---|---|---|---|---|---|
| **Yjs v13 + Hocuspocus v4 (Node)** | CRDT (YATA). State-vector sync, binary updates | Live `Y.Doc` per file in memory. Auth, read-only, persistence and lifecycle hooks. Writes files to disk | Good: clients keep full state; `y-indexeddb` for durable offline | Per-user local undo built in (`Y.UndoManager`). CRDT time travel only with `gc:false`, so keep history at app level | yjs 13.6.33 (2026-09-23) stable; Hocuspocus 4.8.0 (2026-10-28), v4 stable since 2026-05-08, Node 22+; y-codemirror.next 0.3.6 (2026-08-18) but slow cadence (previous release 2024-06) | **Low-medium.** Custom persistence, tree RPC and compile barrier | **Recommended** |
| **Yjs via Rust yrs server** (yrs-axum, yrs-warp, hocuspocus-rs) or **Go ygo** | Same CRDT, same wire format | Same role, native process | Same (client side unchanged) | Same; no server-side UndoManager needed | yrs 0.28.1 (2026-11-04) is solid. Server crates are small, single-maintainer (yrs-axum 0.8.2, 2025-03; yrs-warp 0.9.0, 2025-07; hocuspocus-rs 0.1.x). Deln0r/ygo v1.41.0 (2026-11-17) is very active, about 96 stars, no known importers. reearth/ygo calls itself "production-grade"; actual production use at Re:Earth **(unverified)** | Medium-high. You fill hook and extension gaps yourself | Only if the backend must be Rust or Go. Spike against the Hocuspocus provider first |
| **Loro 1.18** | CRDT (Fugue plus Eg-walker-inspired), full op log | You write most of it. Loro Protocol / loro-websocket (Oct 2025) is thin | Good | Best: full-history checkout, shallow snapshots, local-only UndoManager | loro-crdt 1.18.0 (2026-11-16), fast-moving, recent panic and data-loss hardening. loro-codemirror 0.3.3 has had no release since 2025-10-07 (about 9k/week) | High | Switch only if built-in time travel or branching becomes a core feature |
| **Automerge 3** | CRDT (RGA family), full history always | automerge-repo / samod. Designed local-first | Excellent | Full history; **no built-in undo** (issue #985 became discussion #1551 on 2026-09-10; maintainer points to third-party automerge-patcher) | JS 3.5.0 (2026-09-16), Rust 0.12.0. CodeMirror plugin 0.2.0 (2025-07), about 1.8k/week, no documented remote cursors | High | Not recommended: missing undo, thin CodeMirror binding |
| **@codemirror/collab central authority** | OT-style central rebasing. The server fixes the order and rebases stale updates (`rebaseUpdates`, 6.1.0+) | Owns a plain string plus an ordered update log per file. Must run `@codemirror/state`, so the server is JS | Only while the server keeps every update since the client's base version; needs a 3-way-merge fallback | CodeMirror's native undo works. The op log is a natural basis for history and blame | 6.1.1 (2023-09-14), API complete. GitHub repo archived 2026-04-15 because it moved to code.haverbeke.berlin (behind Anubis bot protection). Low activity | Medium-high: you build transport, presence, reconnect, persistence and log compaction | **Runner-up** (section 4) |
| **ShareDB OT** | Jupiter-style client-server OT, pluggable types (ot-text-unicode) | Batteries included: op log in Mongo or Postgres, pub/sub, presence, middleware | Good while the full op log is kept | DB-backed op history; no editor undo integration | sharedb 8.0.0 (2026-11-12, breaking). Many 2026 security advisories. Newest CodeMirror binding found is sharedb-codemirror 0.3.0 (2020, almost certainly CM5; "only binding" **unverified**) | High: you write and own a CM6 adapter. Possible UTF-16 vs code-point index mismatch **(unverified)** | Viable but inferior to both of the above |
| **Weidner server reconciliation** (ID per character) | Server applies "insert after ID" literally; clients undo, apply, redo | Authoritative; easy validation | Good: no log-retention dependence | Build your own | Blog post 2025-05-21. Articulated 1.4.0 (2026-10-28) is only the ID-list data structure; protocol and reconciliation are DIY | High; no CM6 binding | Interesting only if ID-anchored comments or long offline become top priorities |
| **Differential Synchronization** (Fraser 2009) | Shadow copies, diff, fuzzy patch | Holds a shadow per client | Tolerant of anything, but fuzzy patches can silently drop edits | No per-user attribution or undo | Google diff-match-patch archived (2024). Forks are maintained occasionally (@sanity/diff-match-patch 3.2.1, 2026-09-21; diff-match-patch-es 2.0.1) | Medium | **Fallback only:** merging external edits (uploads, git sync) into the live doc |
| **WebRTC P2P à la TeXlyre** | Yjs over y-webrtc (y-websocket optional) | Signalling only; no authoritative copy | Good (IndexedDB) | Yjs undo; each peer compiles its own copy | TeXlyre v0.14.1 (2026-11-05), AGPL, pre-1.0 | n/a | **Rejected:** no authoritative server copy, no consistent compile snapshot, binaries need peers online |

Also considered and rejected:
- **yhub (formerly y-redis):** AGPL or commercial, beta, needs Redis/Valkey plus Postgres (S3 optional) and a worker process. Overkill.
- **y-sweet:** no release since v0.9.1 (2025-09-16), last commit 2025-12-04, after Jamsocket joined Modal.
- **@y/websocket-server:** officially "a development server or a starting point".
- **PartyKit / y-partyserver:** tied to Cloudflare.
- **Liveblocks server:** AGPL, meant for local development and CI.
- **json-joy:** its CodeMirror binding has tens of downloads a week (`collaborative-codemirror` 29/week, last release 2025-05-16, CM6 compatibility unverified).
- **Collabs:** dormant since 2023-09.
- **Diamond Types:** README says WIP; npm packages last published 2023-05.

---

## 3. Recommended wire protocol and lifecycle

### 3.1 Packages
- Pin `yjs@13.6.x`, `y-codemirror.next@0.3.x`, `@hocuspocus/server@4.x` / `@hocuspocus/provider@4.x`, and `y-indexeddb` (optional).
- Do **not** use the v14 line yet:
  - `@y/y` is still RC. Its npm `latest` tag points to the stale `14.0.0-rc.7`; active work is on `beta` = rc.30.
  - `@y/codemirror` is `0.0.0-4` beta.
  - Plain `npm i yjs` still installs v13; the v14 prerelease tags on `yjs` are opt-in.
  - The v13 and v14 binary update formats are reportedly compatible both ways (secondary source, **unverified**). The snapshot and history API does change: v13 Snapshot is deprecated in favour of ContentIds and AttributionsRenderer.

### 3.2 Transport
- One `wss://` WebSocket per browser tab, same origin as the app, behind the reverse proxy. Hocuspocus multiplexes every open file doc plus the project channel over it.
- Skip WebTransport. It became Baseline in March 2026 with Safari 26.4, but it needs QUIC/UDP through the proxy, Yjs servers don't support it, and a Safari 26.4 handshake problem has been reported.
- An SSE-plus-POST fallback for hostile university proxies can come later.

### 3.3 Connect and auth
1. The browser has an HttpOnly session cookie with SameSite=Lax or Strict.
2. At the upgrade, check `Origin` against an explicit allowlist with no wildcards (OWASP).
3. The client fetches a short-lived (for example 60 s) per-project token from an authenticated HTTP endpoint. The provider sends it in the **first message**, and `onAuthenticate` checks it. Never put tokens in the URL query string, because they leak into logs.
4. `onAuthenticate` returns a context (`userId`, `role`) and sets the connection read-only for viewers. Enforce read-only on the server, never only in the UI. Hocuspocus docs are inconsistent between `connection.readOnly` and `connectionConfig.readOnly`; check this in a spike.
5. To show the user why access was refused, accept the upgrade and close with a 44xx code. Browsers report a rejected upgrade only as an opaque 1006.
6. Re-check permissions on long-lived sockets with `requestToken`/`onTokenSync` or a periodic session check. When someone is removed from a project, close their connections to that project on the server right away.
7. Keep v4's pre-auth queue limits (`maxUnauthenticatedQueueSize` 5 MiB, 1000 messages, 100 pending docs).

### 3.4 Document naming: one doc per text file
- Name docs `proj/<projectId>/file/<fileId>/g<generation>`.
- **fileId** is stable across rename and move, so a rename never touches the text doc.
- **generation** (an epoch) increases when a file is deleted and recreated, or reset by a history restore. A stale client, including one replaying `y-indexeddb` state, then cannot merge old content into the new doc. This is the same idea as Zed's channel-buffer epoch.
- Content is `doc.getText('content')`. Keep GC **on**, set explicitly when constructing every `Y.Doc`; some adapters, such as y-leveldb, have silently enabled GC.
- Only `.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.txt` and similar text files get a Y.Doc. Cap the size of a single text doc; Overleaf uses 2 MB.
- Do **not** use one big project Y.Doc. Per-file docs allow lazy loading, cheap awareness, per-file history and per-file locking. This is the layout Overleaf, TeXlyre, CoCalc and Zed all converge on.

### 3.5 File-tree operations: a separate, server-authoritative channel
- Manifest table: `(project_id, file_id, parent_id, name, kind: text|binary|folder, content_hash, generation, deleted_at)` plus `projects.tree_version`.
- Operations: `create`, `rename`, `move`, `delete`, `setMainFile`, `setCompiler`. They arrive as HTTP POST or as stateless messages on the project channel.
- The server validates each one (permissions, name collisions, move cycles, moves into deleted folders). In one DB transaction it applies the change and increments `tree_version`. It then broadcasts `{treeVersion, op}` to the project room.
- Clients apply events strictly in version order. If they see a gap, they re-fetch the whole manifest.
- This is Overleaf's `emitToRoom` pattern (`reciveNewDoc`, `reciveEntityRename`, …) and Zed's "forward mutating request to the authority". For per-property settings, last-writer-wins in the server's order (the Figma model) is enough.
- **Delete** steps:
  1. Flush and compact the doc.
  2. Close its connections with a "file deleted" code.
  3. Refuse later updates for that `fileId/generation`.
  4. Soft-delete the row.
- Project channel: one extra Hocuspocus document per project (`proj/<projectId>/meta`). It holds no persisted content and exists to carry tree events (stateless broadcast; check the exact API in a spike) and project-level presence: who is online and which file they have open.

### 3.6 Awareness (presence)
- Standard y-protocols awareness on each file doc carries cursors and selections (`{user: {id, name, color}, cursor}`), rendered by `y-codemirror.next`. Project presence goes on the meta doc.
- Never persist awareness. Validate shape and size and rate-limit in `beforeHandleAwareness`. Clients drop stale states after 30 s with no refresh.
- When outbound buffers are full, drop or merge pending awareness updates (latest wins) first.

### 3.7 Persistence: update log plus snapshot
- **Don't** use the stock Database or SQLite extension as-is. It stores a full `Y.encodeStateAsUpdate(doc)` on a debounced timer (server defaults: debounce 2 s, maxDebounce 10 s), so every save rewrites the whole doc and edits held only by the server can be lost in a crash.
- Use these tables, in SQLite WAL mode with `synchronous=NORMAL` or `FULL`, or in Postgres:
  - `doc_updates(doc_name, seq, update BLOB, user_id, ts)`, append-only. Write each incoming update as it arrives, from `onChange` or `beforeHandleMessage`. Confirm that the `onChange` payload exposes the raw update in a spike.
  - `doc_snapshots(doc_name, upto_seq, state BLOB, text TEXT, sv BLOB)`.
- Compaction runs in the background and in `onStoreDocument`. It takes either `Y.mergeUpdates`, or the live doc's `encodeStateAsUpdate`. In one transaction it inserts the snapshot (including a plain-text copy) and deletes the covered `seq` range. Also compact when the last client leaves, before unloading.
- `onLoadDocument`: apply the latest snapshot, then every update with `seq > upto_seq`.
- **History is application-level.** Commit snapshot text to a per-project bare git repo on a timer and on each compile, or keep it in `doc_snapshots`. Do not depend on Yjs snapshots: they need `gc:false`, which the Yjs README states officially, and the v14 API changes.
- Restoring an old version means applying a **forward diff** to the live `Y.Text` with origin `restore`, never swapping in a fresh `Y.Doc`. If a fresh doc is unavoidable, bump `generation`.
- Crash window: Hocuspocus may broadcast before your append commits. That is acceptable because every connected client holds full state and resends it on reconnect through SyncStep1/2, and `y-indexeddb` covers the case where all clients have also closed. If strict write-before-broadcast is required, fork the thin y-websocket server instead (section 4).

### 3.8 Load and unload lifecycle
- Load on first connect, de-duplicating concurrent loads (Hocuspocus does this).
- Unload after the last client leaves and pending stores have flushed (`unloadImmediately: true` is the default). Optionally add a short grace period to absorb reconnects.
- On SIGTERM, flush all pending stores before exiting.

### 3.9 Reconnect and offline
- The Yjs SyncStep1/SyncStep2 state-vector exchange does catch-up after any gap, with no log-retention limit. That is the main advantage over `@codemirror/collab` and over Overleaf's "Op too old" cutoff (`MAX_AGE_OF_OP = 80`; the vendored model defaults to 40).
- Use `y-indexeddb` per doc name, which includes the generation, so offline edits survive a reload.
- On reconnect, the client first re-fetches the manifest. Any local doc whose `fileId/generation` no longer exists is discarded; offer the user a "recover my offline text" download rather than merging it.
- Undo: `y-codemirror.next` plus `Y.UndoManager`, tracking only local origins.

### 3.10 Server-originated edits
Uploads that replace a `.tex`, a git-bridge pull, or a formatter run all go the same way:
1. Diff old text against new with a maintained diff-match-patch fork or fast-diff.
2. Apply the result as a `Y.Text` transaction with origin `server:<reason>`.
3. Collaborators see ordinary edits, and undo stays per-user.

### 3.11 Compile snapshot consistency: the "snapshot barrier"
1. When a compile is requested, take a per-project compile lock. Only one build per project at a time; coalesce repeated requests.
2. **Synchronously, in one event-loop turn** (Node is single-threaded, so this is atomic with respect to incoming updates):
   - record `tree_version`;
   - for each text file in the manifest, take `ytext.toString()` from the live doc if it is loaded, else the materialized `text` of its latest snapshot plus log;
   - record each doc's state vector.
3. Write to a per-project persistent working directory, rewriting only files whose content hash changed. Use an Overleaf-style structure hash (sorted `fileId:path` and `fileId:hash:path` plus compile options). If the hash changed, do a full re-sync of the directory: delete removed files, place binaries from the content-addressed store by hardlink or copy. After a failed build, the next one is full.
4. Run `latexmk` in a sandbox with no shell-escape, a CPU/time/memory limit, and no network. Overleaf CE runs compiles as a plain subprocess; sandboxed containers are Server Pro only, so do not copy CE here.
5. Tag the PDF and SyncTeX output with `{treeVersion, stateVectors}`. The client can then map SyncTeX positions, or warn when the file has moved on since the build.
6. Edits that arrive during the build go into the next build. No database flush is needed because the in-memory docs are authoritative. Overleaf, by contrast, must flush Redis to Mongo or hash-gate a Redis read.

### 3.12 Binary files
- Upload over HTTP with multipart or resumable upload and size limits.
- Store as sha256 in a content-addressed store on disk or S3. The manifest row points at the hash. Broadcast the tree event.
- Binaries never enter a CRDT.
- Replacing an image means a new hash, an updated manifest row, and a new tree version.

### 3.13 Comments and tracked changes (later)
- Anchor comments with `Y.RelativePosition` pairs. Keep thread bodies in the relational DB.
- **Never** write comment markers into the `.tex` source, as TeXlyre does. That pollutes diffs and git and has to be stripped before compile.

---

## 4. Runner-up: `@codemirror/collab` central authority

**Design:** one authority per text file in the same Node process. The authority holds a plain string plus an ordered `ChangeSet` log persisted to SQLite or Postgres. It rebases stale client updates on the server with `rebaseUpdates`, which avoids starving high-latency clients. It keeps the full per-file log, or a long window, so offline clients can still rebase. A three-way-merge fallback (diff-match-patch fork) covers clients whose base version has been compacted away. The tree, binaries and compile barrier stay exactly as in section 3.

**Switch to it if:**
- **You need Overleaf-style review features first.** Tracked changes and comments as ranges transformed by the same op stream (Overleaf's `ranges-tracker`) are more natural with a linear server-ordered log than with Yjs.
- **You want per-op server validation or rewriting.** Examples: region-level permissions, rejecting edits to locked files mid-op, or a server-ordered log as the system of record for history and blame.
- **`y-codemirror.next` stalls or breaks against a CM6 release.** It has gone about 2 years between releases before. Note that `@codemirror/collab` itself has not had a release since 2023-09, but it shares CM6's native ChangeSet format and its API is complete.
- **You want zero per-character metadata** and accept giving up robust long-offline editing.

**Cost of switching:** you write the transport, reconnect state machine, presence, log compaction and multi-doc multiplexing yourself. The official example's scheduling is described in its own docs as crude. Because both designs put text docs behind a per-file abstraction and keep tree, binaries and compile separate, the switch touches only the text-sync layer.

**Other switch triggers:**
- **Backend must be Rust or Go:** keep Yjs on the client and use yrs (set the UTF-16 offset kind to match JS/CodeMirror; check this) or ygo. Run a protocol spike against the Hocuspocus provider first.
- **Built-in time travel or branching ("the paper as of last Tuesday", per-character) becomes core:** evaluate Loro, and budget for hardening loro-codemirror and building your own server.
- **You need strict write-before-broadcast durability:** fork the roughly 300-line y-websocket server, keeping the same wire protocol and Yjs, and build auth, read-only enforcement, multiplexing and backpressure yourself.

---

## 5. Pitfalls checklist

**Versions**
- [ ] Pin Yjs v13. `@y/y` `latest` is a stale RC (rc.7); v14 `@y/codemirror` is beta; v14 replaces the snapshot API.
- [ ] The `@y/websocket-server` README on npm (0.1.5) lags the repo. The repo says "development server"; don't treat it as production.

**Persistence and history**
- [ ] Construct every `Y.Doc` with GC set explicitly. Storage adapters have silently enabled GC.
- [ ] Don't rely on Yjs snapshots for version history (they need `gc:false`). Use app-level snapshots or git.
- [ ] Never "restore" by replacing a Y.Doc. Clients merge the old content back ("zombie text"). Apply forward diffs, or bump `generation`.
- [ ] Don't use Hocuspocus's stock Database/SQLite store for large docs: it writes a full snapshot each time and has an up-to-10 s crash window. Its debounce values are **server-level** settings, not Database-extension options.
- [ ] Don't add Redis on a single box. The Hocuspocus Redis extension does not reduce CPU (every instance handles every message), and its docs say not to connect servers through Redis if the goal is reducing CPU load.

**Docs and the file tree**
- [ ] Key docs by stable `fileId` plus `generation`, never by path.
- [ ] Deletes: close sockets, refuse late updates, discard stale `y-indexeddb` state.
- [ ] Keep the tree out of the CRDT. A Yjs-map tree (TeXlyre) cannot arbitrate rename collisions or moves into deleted folders.
- [ ] Clients must apply tree events in version order and re-fetch the manifest when they see a gap.
- [ ] Keep binaries out of the CRDT. Use content-addressed storage and broadcast metadata only.

**Compile**
- [ ] Build the compile snapshot from **server** memory for **all** dirty docs, not just the files open in the requesting client (CoCalc's `save_all()` weakness).
- [ ] Use a per-project compile lock and coalesce requests. After a failed build, do a full re-sync.
- [ ] Sandbox latexmk: no `\write18`, resource limits, no network. Overleaf CE does not sandbox.

**Auth and permissions**
- [ ] Tokens never in URL query strings. Enforce an Origin allowlist at every handshake. Use 44xx close codes so clients can see why access was refused.
- [ ] Enforce read-only on the server. Re-check permissions mid-session.

**Limits and backpressure**
- [ ] Size limits must allow for Yjs initial sync. SyncStep2 can far exceed OWASP's generic 64 KB message cap. Cap client-to-server updates and awareness strictly, not server-to-client sync.
- [ ] Outbound backpressure: watch `ws.bufferedAmount`. Drop or merge pending awareness first. If the buffer keeps growing, close with a retryable code; never drop doc updates.
- [ ] Awareness is ephemeral: validate it, rate-limit it, never persist it.

**Encoding and benchmarks**
- [ ] Index units: CM6 and Yjs (JS) use UTF-16. A yrs backend must use the UTF-16 offset kind (check). ShareDB's ot-text-unicode reportedly uses code points **(unverified)**.
- [ ] Don't trust cross-library memory numbers from `dmonad/crdt-benchmarks`. WASM memory is reported as 0 B, versions are 2023-era (yjs 13.6.11, automerge 2.1.10, loro 0.10.1, Node 20.5), and Loro uses snapshot encoding. Vendor figures (Automerge's 700 MB to 1.3 MB Moby Dick example, Loro's 8.4 MB/361 KB) are illustrative only.
- [ ] Eg-walker's memory claim: the abstract says "an order of magnitude", the body says "1-2 orders of magnitude". Cite carefully.

**Overleaf as a reference (corrected from source)**
- Its 5-minute Redis-to-Mongo flush is checked **lazily** when docs are fetched (for example on compile), not on a timer. A continuous background flush exists but is off by default.
- "Every N updates" flushes **project-history**, not Mongo. It is now `FLUSH_PROJECT_EVERY_N_OPS = 500`, though the code comment still says 100.
- When the last client leaves, real-time waits `FLUSH_IF_EMPTY_DELAY` = 500 ms in current source, then calls `flushProjectToMongoAndDelete`. The Overleaf wiki and docs describe about 5 minutes: a doc/source discrepancy **(unverified which applies to CE today)**.
- On an incremental compile, web sends **all** docs from Redis and CLSI writes only the changed ones. The request limit is 7 MB. A 409 from CLSI triggers a full-compile retry.
- There is also a newer history-v1-based compile path; whether it is the default **(unverified)**.
- Overleaf's frontend being CodeMirror 6 is from memory **(unverified)**.

**Other unverified or uncertain items**
- Whether reearth/ygo actually runs in production at Re:Earth.
- y-sweet checkpoint cadence and the exact wording of Jamsocket's "operate as normal" statement.
- The Typst web app's sync protocol (undocumented) and its in-browser WASM compile (secondary sources only).
- Zero's 1.0 date (InfoQ 2026-06-08 vs a reported March 2026 GA).
- Zero having no text merge (inferred from its docs not mentioning one).
- That `onChange` in Hocuspocus v4 exposes the raw update, and the exact stateless-broadcast API name (check in a spike).

**Corrections to individual project facts**
- HedgeDoc 1.12.1 and 1.12.2 (2026-11-04) are marked **withdrawn**; 1.12.0 is "Latest".
- HedgeDoc 2 persists on an interval only if `persistInterval` is configured. It is still 2.0.0-alpha.3.
- TeXlyre's provider setting is `collab-provider-type` (`webrtc` default, or `websocket` for y-websocket or yhub). main's package.json says 0.14.5 (unreleased).
- ot.js's repo is not archived, but its README asks for a maintainer ("bit rotting"). Firepad is archived.
- Replicache's last release was 15.3.0 (2025-07-02); it is in maintenance mode.
- Articulated provides only the ID-list data structure, not the protocol.

---

## 6. Sources

**Yjs and ecosystem**
- https://registry.npmjs.org/yjs · https://registry.npmjs.org/@y/y · https://github.com/yjs/yjs/releases
- https://github.com/yjs/yjs/blob/v13.6.33/README.md · https://github.com/yjs/yjs/blob/main/INTERNALS.md
- https://api.npmjs.org/downloads/point/last-week/yjs
- https://github.com/yjs/y-codemirror.next · https://registry.npmjs.org/y-codemirror.next · https://registry.npmjs.org/@y/codemirror
- https://github.com/yjs/y-protocols · https://github.com/yjs/y-websocket-server · https://registry.npmjs.org/@y/websocket-server
- https://github.com/yjs/yhub · https://discuss.yjs.dev/t/garbage-collection-and-version-snapshotting/1839
- https://docs.yjs.dev/ecosystem/ports-to-other-languages · https://nick-the-sick.pckt.blog/yjs-14-at-yprosemirror-wwv64pw (secondary)
- https://github.com/dmonad/crdt-benchmarks

**Hocuspocus**
- https://tiptap.dev/blog/release-notes/hocuspocus-4-stable-release · https://github.com/ueberdosis/hocuspocus/releases · https://registry.npmjs.org/@hocuspocus/server
- https://tiptap.dev/docs/hocuspocus/server/hooks · https://tiptap.dev/docs/hocuspocus/server/configuration
- https://tiptap.dev/docs/hocuspocus/server/extensions/database · https://tiptap.dev/docs/hocuspocus/server/extensions/sqlite · https://tiptap.dev/docs/hocuspocus/server/extensions/redis
- https://raw.githubusercontent.com/ueberdosis/hocuspocus/main/packages/extension-database/src/Database.ts
- https://raw.githubusercontent.com/ueberdosis/hocuspocus/main/packages/server/src/Hocuspocus.ts
- https://raw.githubusercontent.com/ueberdosis/hocuspocus/main/packages/extension-redis/src/Redis.ts

**Ports and alternative servers**
- https://crates.io/api/v1/crates/yrs · https://github.com/y-crdt/y-crdt/releases · https://pypi.org/pypi/pycrdt/json
- https://hex.pm/api/packages/y_ex · https://github.com/satoren/y_ex
- https://github.com/reearth/ygo · https://github.com/Deln0r/ygo · https://pkg.go.dev/github.com/Deln0r/ygo/server
- https://lib.rs/crates/yrs-warp · https://docs.rs/crate/yrs-axum/latest/source/README.md · https://docs.rs/crate/hocuspocus-rs/0.1.2
- https://github.com/jamsocket/y-sweet · https://registry.npmjs.org/@y-sweet/sdk · https://modal.com/blog/jamsocket-is-joining-modal
- https://github.com/cloudflare/partykit · https://liveblocks.io/blog/open-sourcing-the-liveblocks-sync-engine-and-dev-server

**Loro, Automerge, Eg-walker and others**
- https://github.com/loro-dev/loro · https://registry.npmjs.org/loro-crdt · https://registry.npmjs.org/loro-codemirror · https://www.loro.dev/docs/advanced/undo · https://loro.dev/llms-full.txt · https://loro.dev/blog/loro-protocol
- https://automerge.org/blog/automerge-3/ · https://registry.npmjs.org/@automerge/automerge · https://github.com/automerge/automerge/issues/985 · https://registry.npmjs.org/@automerge/automerge-codemirror
- https://arxiv.org/abs/2409.14252 · https://martin.kleppmann.com/2025/03/30/eg-walker-collaborative-text.html · https://github.com/josephg/diamond-types · https://registry.npmjs.org/diamond-types-node
- https://github.com/streamich/json-joy · https://registry.npmjs.org/collaborative-codemirror · https://registry.npmjs.org/@collabs/collabs

**Central OT and server reconciliation**
- https://codemirror.net/examples/collab/ · https://marijnhaverbeke.nl/blog/collaborative-editing-cm.html · https://marijnhaverbeke.nl/blog/collaborative-editing.html
- https://github.com/codemirror/collab · https://raw.githubusercontent.com/codemirror/collab/main/CHANGELOG.md · https://registry.npmjs.org/@codemirror/collab
- https://github.com/share/sharedb/releases · https://registry.npmjs.org/sharedb · https://registry.npmjs.org/sharedb-codemirror
- https://github.com/Operational-Transformation/ot.js · https://github.com/FirebaseExtended/firepad
- https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs_22.html · https://josephg.com/blog/crdts-are-the-future/
- https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- https://replicache.dev/ · https://doc.replicache.dev/concepts/how-it-works · https://infoq.com/news/2026/06/zero-version-1 · https://registry.npmjs.org/@rocicorp/zero
- https://mattweidner.com/2025/05/21/text-without-crdts.html · https://registry.npmjs.org/articulated
- https://neil.fraser.name/writing/sync/ · https://github.com/google/diff-match-patch · https://registry.npmjs.org/@sanity/diff-match-patch
- https://www.moment.dev/blog/lies-i-was-told-pt-2

**Collaborative editors studied**
- https://github.com/overleaf/overleaf/tree/main/services · https://github.com/overleaf/overleaf/wiki/Editor-and-Compile-Process · https://docs.overleaf.com/on-premises/getting-started/microservices#editor-and-compile-process
- https://github.com/overleaf/overleaf/blob/main/services/document-updater/config/settings.defaults.js
- https://github.com/overleaf/overleaf/blob/main/services/document-updater/app/js/HistoryManager.js
- https://raw.githubusercontent.com/overleaf/overleaf/main/services/document-updater/app/js/ShareJsUpdateManager.js
- https://raw.githubusercontent.com/overleaf/overleaf/main/services/document-updater/app/js/HistoryOTUpdateManager.js
- https://github.com/overleaf/overleaf/blob/main/services/real-time/app/js/WebsocketController.js
- https://github.com/overleaf/overleaf/blob/main/services/web/app/src/Features/Compile/ClsiManager.mjs
- https://github.com/overleaf/overleaf/blob/main/services/web/app/src/Features/Compile/ClsiStateManager.mjs
- https://github.com/overleaf/overleaf/blob/main/services/web/app/src/Features/Editor/EditorController.mjs
- https://github.com/overleaf/overleaf/blob/main/libraries/ranges-tracker/index.cjs
- https://docs.overleaf.com/on-premises/release-notes/release-notes-6.x.x
- https://github.com/TeXlyre/texlyre · https://texlyre.github.io/blog
- https://github.com/sagemathinc/cocalc/blob/master/src/packages/sync/editor/generic/sync-doc.ts · https://raw.githubusercontent.com/sagemathinc/cocalc/master/src/docs/syncstrings.md
- https://github.com/hedgedoc/hedgedoc/blob/master/lib/realtime.js · https://github.com/hedgedoc/hedgedoc/blob/develop/backend/src/realtime/realtime-note/realtime-note.service.ts · https://github.com/hedgedoc/hedgedoc/releases
- https://github.com/zed-industries/zed/blob/main/crates/collab/src/rpc.rs · https://github.com/zed-industries/zed/blob/main/crates/collab/src/db/queries/buffers.rs · https://zed.dev/blog/crdts
- https://typst.app/docs/web-app/comments/ · https://typst.app/blog/2025/folders-reviews

**Transport and security**
- https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/WebSocket_Security_Cheat_Sheet.md
- https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API · https://caniuse.com/webtransport · https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/
- https://textslashplain.com/2019/12/04/the-pitfalls-of-eventsource-over-http-1-1/
