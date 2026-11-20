# Running Ligature with Docker Compose

Two containers (`docker/compose.yaml`), no database server, no Redis, no `docker.sock`:

| Service | Image | What it holds |
|---|---|---|
| `app` | `docker/Dockerfile.app` (Node 24, Debian slim, about 0.4 GB) | API, collaboration server, the web client (`apps/web/dist`, served by the app), the `ligature` CLI, and the server's production dependencies only. Volume `data` → `/data` (`app.db`, `blobs/`, `outputs/`, `backups/`). Listens on 3000 inside the container, published on `127.0.0.1:${LIGATURE_PORT:-3000}` only. |
| `compiler` | `docker/Dockerfile.compiler` (TeX Live 2026 + Node 24 + tini) | The compile worker, `network_mode: none`, read-only, `/tmp` root-only and `ipc: none` (no world-writable directory: a LuaLaTeX document can leave its project with `lfs.chdir("..")` and write wherever its uid may; see `apps/compiler/test/corpus/README.md`), `SANDBOX=uid` (one uid per project). Volumes `builds` (build dirs, caches) and `run` (its unix socket, shared with the app). It never sees `data`. |

You build both images on your own server from this repository (`up -d --build`); there are no published
images to pull.

## Deploy on a fresh Ubuntu 24.04 server

**Before you start**

- A VPS with at least **2 vCPU and 4 GB RAM**.
- Disk: the compiler image with the full TeX Live is about **9.6 GB** on disk (about 2.8 GB to download);
  with the medium scheme (`LIGATURE_TEXLIVE_IMAGE` in `.env.example`) about 3 GB. The app image is about
  0.4 GB. Plus room for your projects and backups.
- The first build takes about **10 to 15 minutes**.
- A domain name with an **A (and/or AAAA) record** pointing at the server, e.g. `latex.example.org`.
- Ports **80 and 443** open, both in ufw and in your provider's firewall (Caddy needs 80 to get the TLS
  certificate):

  ```sh
  sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable
  ```

- No mail server is needed: Ligature sends no email.

Run the commands below as a normal user with `sudo`.

### 1. Install Docker

Docker Engine with the Compose and Buildx plugins, from Docker's own apt repository (the Ubuntu
`docker.io` package is too old). Full instructions: <https://docs.docker.com/engine/install/ubuntu/>.

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker compose version     # v2.24 or later
```

To run `docker` without `sudo`, add yourself to the `docker` group, then log out and back in
(members of this group are effectively root on the host):

```sh
sudo usermod -aG docker "$USER"
```

### 2. Install Caddy

Caddy is the reverse proxy: it gets and renews the TLS certificate itself. From Caddy's apt repository
(<https://caddyserver.com/docs/install#debian-ubuntu-raspbian>):

```sh
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

It starts right away with a placeholder page; Ligature is not reachable through it until step 6.

### 3. Get Ligature and configure it

```sh
sudo git clone https://github.com/Zoryc/Ligature /opt/ligature
sudo chown -R "$USER": /opt/ligature
cd /opt/ligature
cp docker/.env.example docker/.env
nano docker/.env
```

In `docker/.env`, set:

- `LIGATURE_ORIGIN=https://latex.example.org`: exactly what users type in the browser. Scheme + host
  (+ port if not 443), **no trailing slash, no path**. Requests and WebSockets from any other origin are refused.
- `LIGATURE_TRUST_PROXY=1` (already set in the example): Caddy overwrites `X-Forwarded-For`, so login rate
  limits see the real client IPs.

### 4. Build and start

All `docker compose` commands in this guide run in `/opt/ligature`.

```sh
docker compose -f docker/compose.yaml up -d --build      # first time: 10 to 15 minutes
docker compose -f docker/compose.yaml ps                 # both services "(healthy)" after a minute
docker compose -f docker/compose.yaml logs app
```

On a fresh instance the app's log has a line like:

```
[ligature] No accounts yet. Create the first (admin) account at https://latex.example.org/#/signup?setup=<token>
```

### 5. Create your admin account (before the site goes public)

```sh
docker compose -f docker/compose.yaml exec app ligature create-admin alice    # asks for the password twice, no echo
```

Passwords are 10 to 256 characters. Alternatively, right after step 6, open the setup link from the log:
in production the first signup **requires** that token (`setup-token-required` without it), so nobody who
finds the site first can make themselves admin. The server prints a new token at every start until the
first account exists; use the one from the latest log.

### 6. Put Caddy in front

```sh
sudo cp docker/Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i 's/latex.example.org/YOUR.DOMAIN/' /etc/caddy/Caddyfile     # your host name
sudo systemctl reload caddy
```

The port in its `reverse_proxy 127.0.0.1:3000` line must match `LIGATURE_PORT` (default 3000).

### 7. Check

```sh
curl -fsS https://latex.example.org/healthz      # {"ok":true,"status":"ok",...}
```

And that Caddy passes WebSocket upgrades (expect `HTTP/1.1 101 Switching Protocols`; any other status, or a
`200` with the web page, means the proxy does not pass upgrades and the editor will stay "Offline"):

```sh
curl -si --http1.1 --max-time 3 https://latex.example.org/collab \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://latex.example.org' | head -n 1
```

Then log in at `https://latex.example.org` with the admin account.

### 8. Choose who can sign up

In the admin page, **Registration**:

| Mode | Who can sign up |
|---|---|
| `invite-only` (default) | only with a project invite link (they join that project) |
| `open` | anyone who can reach the site |
| `closed` | nobody; admins create accounts in the admin page |

No email is ever sent: share invite links yourself. Forgotten passwords are reset by an admin (admin page)
or with `ligature reset-password` (below).

## Settings

In `docker/.env` (see `.env.example`); apply a change with `docker compose -f docker/compose.yaml up -d`
(add `--build` for the TeX Live ones).

| Variable | Default | |
|---|---|---|
| `LIGATURE_ORIGIN` | (required) | The public origin: scheme + host [+ port], no trailing slash, no path. Requests and WebSockets from any other origin are refused. |
| `LIGATURE_TRUST_PROXY` | `0` in compose, `1` in `.env.example` | `1` behind Caddy, so login rate limits see client IPs instead of the proxy's. Set `0` only if the app port is reachable by anything but your reverse proxy. |
| `LIGATURE_PORT` | `3000` | Host port the app is published on, on **127.0.0.1 only** (inside the container it always listens on 3000). Must match the `reverse_proxy` line of the Caddyfile. Never publish the app on `0.0.0.0`: Docker's port forwarding bypasses ufw. |
| `LIGATURE_TRASH_RETENTION_DAYS` | `30` | Deleted files stay in the trash can this long, then are purged. |
| `LIGATURE_TEXLIVE_IMAGE` | full scheme | The compiler's TeX Live base: `texlive/texlive:latest-full` pinned by digest (about 2.8 GB compressed). The medium scheme (about 0.9 GB) is in `.env.example`. Island of TeX publishes the current release only as `latest-*` (rebuilt weekly); update the digest with `docker buildx imagetools inspect texlive/texlive:latest-full`. |
| `LIGATURE_TEXLIVE_EXTRA` | (none) | Extra CTAN packages installed into the compiler image at build time, space-separated (e.g. `biblatex biber tikz-cd` on top of the medium scheme). The compiler has no network, so this is the only way to add packages; rebuild after changing it. |

## Monitoring

Point an uptime monitor at `https://<host>/healthz` (no login). It answers **200** when the instance works
and **503** when something a user's work depends on is broken, with a JSON report of each check: the
database, free disk space in `/data` (a warning below 1 GB, a failure below 100 MB), whether edits are being
saved, a real WebSocket connection to `/collab`, and the compiler. Failures carry short reason codes
(`timeout`, `refused`, `http-403`, `low-disk`, `write-failed`, `unreachable`, ...); the details are in the
app's log; a failed write of edits is logged once, as `[docStore] writing edits failed`, and the server keeps
running so that `/healthz` can report it. The result is cached for 5 s, so polling it often is harmless.
`GET /api/health` still answers `{ "ok": true }` while the process runs (liveness only).

The app container's own HEALTHCHECK uses `/healthz?scope=app`, which leaves out the compiler (the compiler
container has its own HEALTHCHECK, and restarting the app would not fix it).

`/healthz` opens its WebSocket over loopback inside the container, so a reverse proxy that drops WebSocket
upgrades is **not** detected by it: use the `curl` upgrade test of step 7.

On Docker Desktop (Windows, macOS) the disk check sees Docker's virtual disk, not your real drive.

## Logs

```sh
docker compose -f docker/compose.yaml logs -f --tail=200 app compiler
journalctl -u caddy -f
```

Container logs are rotated (`x-logging` in `compose.yaml`: Docker's `local` driver, 5 files of 10 MB per
container).

## The `ligature` CLI

Installed in the app image as `/usr/local/bin/ligature` (it runs `apps/server/src/cli.ts`, with `DATA_DIR=/data`):

| Command | |
|---|---|
| `ligature backup <dir>` | Online backup: a consistent SQLite snapshot of `app.db` (taken while the app keeps running) plus a copy of `blobs/`, in a new directory `<dir>/ligature-backup-<UTC timestamp>/`. Prints that path. |
| `ligature restore <dir>` | Restores a backup directory made by `ligature backup` (run it with the app stopped, see [Restore](#restore)). |
| `ligature reset-password <username>` | New password from stdin (no echo on a terminal; first line of stdin otherwise). Deletes all of the user's sessions. |
| `ligature create-admin <username> [--display-name <name>]` | New instance admin, password from stdin. |

Passwords: 10 to 256 characters. In scripts: `printf '%s\n' "$PW" | docker compose -f docker/compose.yaml exec -T app ligature reset-password alice`.
If the app is not running, use `docker compose -f docker/compose.yaml run --rm --no-deps app ligature ...` instead of `exec app ligature ...`.
The commands work on the existing `DATA_DIR/app.db` only: they fail (and create nothing) when it does not exist, so
start the app once before `create-admin`, and check `DATA_DIR` if you see `no database at ...`.
Backup directories are created with mode 0700 (they contain password and session hashes).

A password reset logs the user out of the API immediately; collaborative editing connections that are
already open stay open until they reconnect (an admin can also disable the user in the admin page, which closes them).

## Back up

A nightly backup into `/var/backups/ligature`, kept 14 days. Install the script:

```sh
sudo tee /usr/local/bin/ligature-backup > /dev/null <<'EOF'
#!/usr/bin/env bash
# Online backup of Ligature, copied out of the data volume into /var/backups/ligature.
set -euo pipefail
cd /opt/ligature
C="docker compose -f docker/compose.yaml"
dest=/var/backups/ligature
mkdir -p "$dest" && chmod 700 "$dest"
dir=$($C exec -T app ligature backup /data/backups | tail -n 1)   # /data/backups/ligature-backup-<time>
[ -n "$dir" ]
$C cp "app:$dir" "$dest/"              # lands in $dest/ligature-backup-<time>
$C exec -T app rm -rf "$dir"           # only reached if the copy succeeded (set -e)
find "$dest" -mindepth 1 -maxdepth 1 -type d -name 'ligature-backup-*' -mtime +14 -exec rm -rf {} +
EOF
sudo chmod 755 /usr/local/bin/ligature-backup
sudo /usr/local/bin/ligature-backup && sudo ls /var/backups/ligature
echo '30 3 * * * root /usr/local/bin/ligature-backup >> /var/log/ligature-backup.log 2>&1' | sudo tee /etc/cron.d/ligature-backup
```

**Copy the backups off the server** too (rsync, restic, your provider's storage...): a backup on the same
disk does not survive losing the server.

A backup directory contains:

- `app.db`: the whole database (accounts, projects, file tree, document text and history, invites, audit log),
  checked with `PRAGMA integrity_check`, in rollback-journal mode (one self-contained file);
- `blobs/`: the uploaded files (images, PDFs, ...), content-addressed. Copied after the database snapshot,
  then checked: every blob the snapshot refers to is present (if the app's daily clean-up deleted one during
  the copy, it is copied again; if it is gone, the backup fails, leaves nothing behind, and can simply be
  run again);
- `backup.json`: format, time, schema version, blob count and size.

Not included, on purpose: `outputs/` (the last compiled PDFs; a recompile recreates them) and the compiler's
`builds` volume (only caches). Copies of the `data` volume made while the app runs are only consistent
through `ligature backup`.

## Restore

```sh
cd /opt/ligature
B=/var/backups/ligature/ligature-backup-20261118T094512Z      # absolute path of a backup directory
docker compose -f docker/compose.yaml stop app
sudo chown -R 1000:1000 "$B"                                  # the app container runs as uid 1000
docker compose -f docker/compose.yaml run --rm --no-deps -v "$B:/restore:ro" app ligature restore /restore
docker compose -f docker/compose.yaml up -d
```

`ligature restore` validates the backup first, keeps the current data as a safety copy in
`/data/pre-restore-<timestamp>/`, then swaps the files in. Editor tabs that were open reload: edits made
after the backup are not written over the restored text, they show up in the tab's recovery dialog instead.

Everyone has to log in again after a restore: the sessions saved in the backup are deleted, so that a
logout, password reset or revoked session since the backup is not undone. Passwords, accounts and invites
are those of the backup. A read-only backup (e.g. `chmod -R a-w`) is fine: the restored files get normal
modes.

To move an instance to another server: back up, copy the directory over, deploy there (steps 1 to 4), restore,
then update DNS.

## Upgrade

```sh
sudo /usr/local/bin/ligature-backup                  # 1. back up
cd /opt/ligature
git pull                                             # 2. new code
diff docker/.env.example docker/.env                 # 3. new settings? copy what you need into .env
docker compose -f docker/compose.yaml up -d --build  # 4. rebuild and restart (migrations run at start)
docker compose -f docker/compose.yaml ps             # 5. both "(healthy)"
curl -fsS https://latex.example.org/healthz
docker image prune -f && docker builder prune -f     # 6. free the disk space of old images and build cache
```

**Rollback:** `git checkout <previous tag or commit>` (see `git log --oneline`), then
`docker compose -f docker/compose.yaml up -d --build`. If the new version changed the database schema, the
old code refuses to start (`... has database schema vN, but this version of Ligature only knows schemas up
to ...`): restore the backup taken in step 1. Go back to the latest code later with `git checkout main`.

## Windows and macOS (Docker Desktop)

For a local trial the same compose stack works with Docker Desktop (use
`LIGATURE_ORIGIN=http://localhost:3000` and open that URL; no Caddy needed). Run the backup and restore
commands in WSL, or in Git Bash with `export MSYS_NO_PATHCONV=1` (otherwise Git Bash rewrites container paths
such as `/data/backups` into Windows paths). The disk check of `/healthz` sees Docker's virtual disk.

## CI

`.github/workflows/ci.yml`, job `docker`, builds both images with the medium TeX Live scheme
(`scripts/ci/compose.ci.env`), starts this stack, and runs `scripts/ci/smoke.sh` against it: first signup
(admin), project, image upload, compile through the real compiler container, PDF download, then
`ligature backup` and `ligature reset-password` inside the app container.
