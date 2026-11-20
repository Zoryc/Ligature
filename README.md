# Ligature

A self-hostable, real-time collaborative LaTeX editor with user accounts.

> Status: **M4 done** — accounts, projects with members and invite links, file tree with uploads and a trash can,
> live co-editing, sandboxed compiles with auto-compile, errors in the editor gutter, SyncTeX (PDF ↔ source), zip
> import/export, **project history** (versions, side-by-side diff, restore with undo), storage housekeeping, Docker
> deployment ([docker/README.md](docker/README.md)) with a `/healthz` that checks the real paths, an admin audit log
> page. The interface uses the **Folio** design (paper, ink and one
> teal accent; square corners) with a Contents outline, plain-language error explanations with one-click fixes, and
> a Settings panel; the logo and brand files are in [docs/brand](docs/brand). Early software: expect rough edges.
> See [docs/PLAN.md](docs/PLAN.md) for the architecture and roadmap, [docs/M1.md](docs/M1.md),
> [docs/M2.md](docs/M2.md), [docs/M3.md](docs/M3.md) and [docs/M4.md](docs/M4.md) for the API contract, and [docs/SYNC.md](docs/SYNC.md) for
> the sync-model research.

## Try it locally (Windows, macOS, Linux)

Requirements: Node 24+, and a TeX distribution with `latexmk` on `PATH`
(for example [TinyTeX](https://yihui.org/tinytex/) or TeX Live). Docker is only needed for production.

```sh
npm install
npm start -w @ligature/compiler   # compiler worker on 127.0.0.1:7071 (dev mode, no sandbox)
npm run dev:server                # API + collaboration server on 127.0.0.1:3000
npm run dev:web                   # web UI on http://localhost:5173
```

Open http://localhost:5173 and log in as `alice` (owner, admin), `bob` (editor) or `carol` (viewer) —
in development they all have the password `ligature-dev-password`.
To be two users at once in one browser, use a second tab at http://bob.localhost:5173 —
each `*.localhost` host has its own login cookie.

## Deploy

Two containers behind a TLS reverse proxy, run with Docker Compose:

```
browser ──HTTPS + WebSocket──> Caddy (TLS, :443)
                                 │  127.0.0.1:3000
                                 v
                      ┌─ app container :3000 ──────────────┐      volume data:
                      │ HTTP API + web client + /collab WS │ ───> app.db, blobs/,
                      │ (and the `ligature` CLI)           │      outputs/, backups/
                      └────────────────┬───────────────────┘
                                       │ unix socket (volume run)
                                       v
                      ┌─ compiler container ───────────────┐      volume builds:
                      │ TeX Live + compile worker          │ ───> build dirs, caches
                      │ no network at all                  │
                      └────────────────────────────────────┘
```

- **app** image: Node, the server, the built web client and the `ligature` CLI (backup, restore, password
  reset, create admin); nothing else.
- **compiler** image: TeX Live (full scheme by default, medium for small servers) and the compile worker.

You build both images yourself on the server from this repository; there is no registry to pull from.

```sh
sudo git clone https://github.com/Zoryc/Ligature /opt/ligature && sudo chown -R "$USER": /opt/ligature && cd /opt/ligature
cp docker/.env.example docker/.env                    # set LIGATURE_ORIGIN=https://your.domain
docker compose -f docker/compose.yaml up -d --build   # first build: 10 to 15 minutes
docker compose -f docker/compose.yaml exec app ligature create-admin alice
```

The full guide for a fresh Ubuntu server (Docker, Caddy, admin account, backups, restore, upgrades):
[docker/README.md](docker/README.md).

## Tests

```sh
npm test            # all packages
```

The real-TeX tests (compiler, log parser, SyncTeX, server compiles) run automatically when `latexmk` is on `PATH`.
The sync property test (random edits, disconnects and `kill -9` of the real server) runs 25 cases by default;
set `PROPERTY_RUNS=200` for a longer local run.

**On Linux:** the server and compiler tests listen on fixed ports 39100–39999, inside Linux's default range for
outgoing connections (32768–60999), which can rarely cause `EADDRINUSE`. CI moves that range
(`net.ipv4.ip_local_port_range = 50000 65000`); do the same locally if you see it.

## Layout

| Path | What |
|---|---|
| `apps/server` | Hono API + Hocuspocus (Yjs) collaboration server, SQLite persistence, compile orchestration, history |
| `apps/web` | Svelte 5 SPA: CodeMirror 6 editor, PDF.js viewer |
| `apps/compiler` | Sandboxed latexmk worker (unix socket in production) |
| `packages/shared` | Contracts and validation shared by all of the above |
| `packages/latex-log-parser` | TeX/latexmk log → diagnostics |
| `packages/synctex` | SyncTeX parser: PDF ↔ source lookups |
| `docker/` | Production images and compose file |

## License

MIT
