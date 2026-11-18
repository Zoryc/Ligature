# Running Ligature with Docker Compose

Two containers (`docker/compose.yaml`), no database server, no Redis, no `docker.sock`:

| Service | Image | What it holds |
|---|---|---|
| `app` | `docker/Dockerfile.app` (Node 24) | API, collaboration server, the web client (`apps/web/dist`, served by the app), the `ligature` CLI. Volume `data` → `/data` (`app.db`, `blobs/`, `outputs/`, `backups/`). Listens on `127.0.0.1:3000` only. |
| `compiler` | `docker/Dockerfile.compiler` (TeX Live 2026 + Node 24 + tini) | The compile worker, `network_mode: none`, read-only, `/tmp` root-only and `ipc: none` (no world-writable directory: a LuaLaTeX document can leave its project with `lfs.chdir("..")` and write wherever its uid may; see `apps/compiler/test/corpus/README.md`), `SANDBOX=uid` (one uid per project). Volumes `builds` (build dirs, caches) and `run` (its unix socket, shared with the app). It never sees `data`. |

## Deploy

Requirements: a Linux host with Docker Engine and the Compose plugin (v2.24+), a DNS name, and a reverse
proxy with TLS and WebSocket support (Caddy: `docker/Caddyfile.example`).

```sh
git clone <repo> ligature && cd ligature
cp docker/.env.example docker/.env      # set LIGATURE_ORIGIN=https://latex.example.org (exactly what users type)
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml ps  # both services "healthy"
```

Then open the site: **the first account to sign up becomes instance admin** (registration defaults to
`invite-only`; change it in the admin page). On a `closed` instance, or to get an admin without the web UI:

```sh
docker compose -f docker/compose.yaml exec app ligature create-admin alice     # asks for the password twice, no echo
```

Settings (`docker/.env`, see `.env.example`):

- `LIGATURE_ORIGIN` (required): the public origin; requests and WebSockets from any other origin are refused.
- `LIGATURE_TRUST_PROXY=1` behind Caddy, so login rate limits see client IPs instead of the proxy's.
- `LIGATURE_TEXLIVE_IMAGE`: the compiler's TeX Live base. Default: full scheme (`texlive/texlive:latest-full`,
  pinned by digest, about 2.8 GB compressed). For a small VPS the medium scheme (about 0.9 GB) is in
  `.env.example`. Island of TeX publishes the current release only as `latest-*` (rebuilt weekly); update the
  digest with `docker buildx imagetools inspect texlive/texlive:latest-full`.
- `LIGATURE_PORT`: host port on 127.0.0.1 (default 3000).

Upgrading: `git pull && docker compose -f docker/compose.yaml up -d --build`. Database migrations run when the
app starts. Take a backup first.

## The `ligature` CLI

Installed in the app image as `/usr/local/bin/ligature` (it runs `apps/server/src/cli.ts`, with `DATA_DIR=/data`):

| Command | |
|---|---|
| `ligature backup <dir>` | Online backup: a consistent SQLite snapshot of `app.db` (taken while the app keeps running) plus a copy of `blobs/`, in a new directory `<dir>/ligature-backup-<UTC timestamp>/`. Prints that path. |
| `ligature reset-password <username>` | New password from stdin (no echo on a terminal; first line of stdin otherwise). Deletes all of the user's sessions. |
| `ligature create-admin <username> [--display-name <name>]` | New instance admin, password from stdin. |

Passwords: 10 to 256 characters. In scripts: `printf '%s\n' "$PW" | docker compose -f docker/compose.yaml exec -T app ligature reset-password alice`.
If the app is not running, use `docker compose -f docker/compose.yaml run --rm --no-deps app ligature ...` instead of `exec app ligature ...`.
The commands work on the existing `DATA_DIR/app.db` only: they fail (and create nothing) when it does not exist, so
start the app once before `create-admin`, and check `DATA_DIR` if you see `no database at ...`.
Backup directories are created with mode 0700 (they contain password and session hashes).

Notes: a password reset logs the user out of the API immediately; collaborative editing connections that are
already open stay open until they reconnect (an admin can also disable the user in the admin page, which closes them).

## Back up

```sh
C="docker compose -f docker/compose.yaml"
dir=$($C exec -T app ligature backup /data/backups | tail -n 1)    # e.g. /data/backups/ligature-backup-20261118T094512Z
$C cp "app:$dir" ./backups/                                       # get it off the data volume (and off the host!)
$C exec -T app rm -rf "$dir"                                      # optional: don't keep copies on the volume
```

A backup directory contains:

- `app.db`: the whole database (accounts, projects, file tree, document text and history, invites, audit log),
  checked with `PRAGMA integrity_check`, in rollback-journal mode (one self-contained file);
- `blobs/`: the uploaded files (images, PDFs, ...), content-addressed. Copied after the database snapshot,
  so every blob the snapshot refers to is present (blobs are never deleted in M1);
- `backup.json`: format, time, schema version, blob count and size.

Not included, on purpose: `outputs/` (the last compiled PDFs; a recompile recreates them) and the compiler's
`builds` volume (only caches). Schedule the commands above with cron or a systemd timer and copy the result
to another machine; backups of the `data` volume made while the app runs are only consistent through `ligature backup`.

## Restore

```sh
C="docker compose -f docker/compose.yaml"
B=./backups/ligature-backup-20261118T094512Z      # a directory made by `ligature backup`
$C stop app
$C run --rm --no-deps --user node -v "$(realpath "$B"):/restore:ro" --entrypoint sh app -c '
  set -e
  cd /data
  rm -f app.db app.db-wal app.db-shm
  cp /restore/app.db app.db
  rm -rf blobs && cp -R /restore/blobs blobs
  rm -rf outputs'
$C up -d
```

Remove `app.db-wal` and `app.db-shm` together with the old `app.db` (a stale WAL would be replayed into the
restored database). Deleting `outputs/` is optional; without it, PDFs of builds made after the backup remain
downloadable until the next compile. Users' sessions in the backup are valid again after a restore.

To move an instance to another host: back up, copy the directory, deploy there, restore, update DNS.

## CI

`.github/workflows/ci.yml`, job `docker`, builds both images with the medium TeX Live scheme
(`scripts/ci/compose.ci.env`), starts this stack, and runs `scripts/ci/smoke.sh` against it: first signup
(admin), project, image upload, compile through the real compiler container, PDF download, then
`ligature backup` and `ligature reset-password` inside the app container.
