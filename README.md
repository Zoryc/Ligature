# Ligature

A self-hostable, real-time collaborative LaTeX editor with user accounts.

> Status: **M2 done** — accounts, projects with members and invite links, file tree with uploads and a trash can,
> live co-editing, sandboxed compiles with auto-compile, errors in the editor gutter, SyncTeX (PDF ↔ source), zip
> import/export, Docker deployment ([docker/README.md](docker/README.md)). Early software: expect rough edges.
> See [docs/PLAN.md](docs/PLAN.md) for the architecture and roadmap, [docs/M1.md](docs/M1.md) and
> [docs/M2.md](docs/M2.md) for the API contract, and [docs/SYNC.md](docs/SYNC.md) for the sync-model research.

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

## Tests

```sh
npm test            # all packages
```

The compiler's real-TeX tests run automatically when `latexmk` is on `PATH`.

## Layout

| Path | What |
|---|---|
| `apps/server` | Hono API + Hocuspocus (Yjs) collaboration server, SQLite persistence, compile orchestration |
| `apps/web` | Svelte 5 SPA: CodeMirror 6 editor, PDF.js viewer |
| `apps/compiler` | Sandboxed latexmk worker (unix socket in production) |
| `packages/shared` | Contracts and validation shared by all of the above |
| `docker/` | Production images and compose file |

## License

MIT

> **Running the tests on Linux:** the server and compiler tests listen on fixed ports 39100–39999, inside Linux's
> default range for outgoing connections (32768–60999), which can rarely cause `EADDRINUSE`. CI moves that range
> (`net.ipv4.ip_local_port_range = 50000 65000`); do the same locally if you see it.
