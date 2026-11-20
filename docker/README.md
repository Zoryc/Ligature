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
- A **TLS reverse proxy** on the server (Caddy, nginx, Traefik, ...). Ligature does not install or configure
  one: it listens on `127.0.0.1:3000` only, and step 5 adds it to your proxy next to your other sites. No
  proxy yet? Caddy is the simplest (it gets the certificate itself): install it from
  <https://caddyserver.com/docs/install#debian-ubuntu-raspbian>, then use the Caddy block of step 5.
- Ports **80 and 443** open for your proxy, in ufw and in your provider's firewall (80 is also needed to get
  the TLS certificate). If the server already has a firewall, just allow 80 and 443 in it (with ufw:
  `sudo ufw allow 80/tcp && sudo ufw allow 443`). Only on a **fresh** server with no firewall yet, turn ufw on
  with `sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable`:
  `ufw enable` blocks every port not allowed, which would cut off other services (or SSH on a non-standard port).
- No mail server is needed: Ligature sends no email.

Run the commands below as a normal user with `sudo`.

### 1. Install Docker

**Already have Docker?** If `docker compose version` prints v2.24 or later and `docker buildx version` works,
skip this step: do not reinstall it, since replacing a Docker installation restarts every container on the
server. (Ubuntu's own `docker.io` package usually lacks Buildx; read Docker's docs before switching packages.)

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

### 2. Get Ligature and configure it

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
- `LIGATURE_TRUST_PROXY=1` (already set in the example): login rate limits then use the client address your
  proxy puts in `X-Forwarded-For`. The Caddy and nginx configs of step 5 set it to the client's address
  themselves, so a client cannot fake it; with another proxy, make sure it does the same.
- `LIGATURE_PORT` only if port 3000 is already used on the server (the app is published on
  `127.0.0.1:<port>`; use the same port in step 5).

### 3. Build and start

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

Ligature now runs on `127.0.0.1:3000`, reachable only from the server itself.

### 4. Create your admin account (before the site goes public)

```sh
docker compose -f docker/compose.yaml exec app ligature create-admin alice    # asks for the password twice, no echo
```

Passwords are 10 to 256 characters. Alternatively, right after step 5, open the setup link from the log:
in production the first signup **requires** that token (`setup-token-required` without it), so nobody who
finds the site first can make themselves admin. The server prints a new token at every start until the
first account exists; use the one from the latest log.

### 5. Add Ligature to your reverse proxy

Add one site for your host name that forwards to `127.0.0.1:3000` (or your `LIGATURE_PORT`). Your other
sites are not touched. Whatever the proxy, it must:

- pass **WebSocket upgrades** (on `/collab`; without them the editor stays "Offline"),
- keep the **Host** header, and set **`X-Forwarded-For`** to the client's address (overwrite, not append),
- allow **uploads up to 200 MB** and **requests up to 10 minutes** (zip imports, long compiles).

**Caddy** on the host: add the site block of [`docker/Caddyfile.example`](Caddyfile.example) to your
Caddyfile, next to your other sites. The commands append it to a **copy**, validate the copy, and only then
replace the live file, so a mistake never leaves a broken Caddyfile behind:

```sh
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.new
{ echo; sed 's/latex.example.org/YOUR.DOMAIN/' docker/Caddyfile.example; } | sudo tee -a /etc/caddy/Caddyfile.new > /dev/null
sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new \
  && sudo mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

If `validate` fails, the live Caddyfile is unchanged: fix `/etc/caddy/Caddyfile.new` (or delete it) and run
the last command again. `reload` applies the new site without interrupting your other sites. The block sets
`X-Forwarded-For` itself, from the client address Caddy determined (a forged header from a client is
replaced). If your Caddy sits behind a CDN with `trusted_proxies`, configure how it finds the real client, as
for your other sites (Cloudflare: `client_ip_headers CF-Connecting-IP`, or `trusted_proxies_strict`).

**nginx** on the host: [`docker/nginx.example.conf`](nginx.example.conf) is a complete site (HTTP to HTTPS
redirect, WebSockets, upload size, timeouts). Get the certificate with `certonly`: plain `certbot --nginx`
would install it into a copy of your default site, which then takes over the host name.

```sh
sudo apt-get install -y certbot python3-certbot-nginx           # if certbot is not installed yet
sudo certbot certonly --nginx -d YOUR.DOMAIN                     # only gets the certificate; changes no site
sed 's/latex.example.org/YOUR.DOMAIN/g' docker/nginx.example.conf | sudo tee /etc/nginx/sites-available/ligature > /dev/null
sudo ln -s /etc/nginx/sites-available/ligature /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx || sudo rm /etc/nginx/sites-enabled/ligature
```

The last line disables the site again if the check fails, so a reload of your other sites cannot break.
It works with Ubuntu 24.04's nginx (1.24) and newer.

**A proxy that runs in Docker** (a Caddy, nginx or Traefik container): inside that container `127.0.0.1` is the
container itself, so it cannot reach the app's published port. Connect it to Ligature's network:

```sh
docker network connect ligature_default <your-proxy-container>
```

and use the app container's name, **`ligature-app-1:3000`**, as the upstream (unique on the host; the short
name `app` can also mean another project's container on a shared proxy):

- Caddy: `reverse_proxy ligature-app-1:3000` (Caddy looks the name up again for each connection).
- nginx: it looks names up only once at start, so after a Ligature upgrade (new container, new address) it
  would keep the old one. Use Docker's DNS and a variable, which makes nginx look it up again:

  ```nginx
  resolver 127.0.0.11 valid=10s;
  set $ligature_upstream http://ligature-app-1:3000;
  proxy_pass $ligature_upstream;
  ```

- Traefik: a router for your host name whose service URL is `http://ligature-app-1:3000` (file provider);
  Traefik passes WebSockets by default.

The network and container names come from the compose project name, `ligature` by default (`docker network ls`,
`docker ps`). Run `network connect` again if you recreate the proxy container, or declare `ligature_default` as
an external network in your proxy's compose file.

### 6. Check

```sh
curl -fsS https://latex.example.org/healthz      # {"ok":true,"status":"ok",...}
```

And that your proxy passes WebSocket upgrades (expect `HTTP/1.1 101 Switching Protocols`; any other status, or a
`200` with the web page, means the proxy does not pass upgrades and the editor will stay "Offline"):

```sh
curl -si --http1.1 --max-time 3 https://latex.example.org/collab \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://latex.example.org' | head -n 1
```

Then log in at `https://latex.example.org` with the admin account.

### 7. Choose who can sign up

In the admin page, **Registration**:

| Mode | Who can sign up |
|---|---|
| `invite-only` (default) | only with a project invite link (they join that project) |
| `open` | anyone who can reach the site (not recommended yet: see below) |
| `closed` | nobody; admins create accounts in the admin page |

Ligature is built for a team that trusts each other: until the stronger gVisor sandbox is available, keep
sign-up on `invite-only` or `closed` rather than opening it to strangers ([SECURITY.md](../SECURITY.md)).

No email is ever sent: share invite links yourself. Forgotten passwords are reset by an admin (admin page)
or with `ligature reset-password` (below).

## Settings

In `docker/.env` (see `.env.example`); apply a change with `docker compose -f docker/compose.yaml up -d`
(add `--build` for the TeX Live ones).

| Variable | Default | |
|---|---|---|
| `LIGATURE_ORIGIN` | (required) | The public origin: scheme + host [+ port], no trailing slash, no path. Requests and WebSockets from any other origin are refused. |
| `LIGATURE_TRUST_PROXY` | `0` in compose, `1` in `.env.example` | `1` behind a reverse proxy that sets `X-Forwarded-For` to the client's address (the Caddy and nginx configs of step 5 do), so login rate limits see client IPs instead of the proxy's. Set `0` only if the app port is reachable by anything but your reverse proxy. |
| `LIGATURE_PORT` | `3000` | Host port the app is published on, on **127.0.0.1 only** (inside the container it always listens on 3000). Must match the upstream port in your reverse proxy (step 5). Never publish the app on `0.0.0.0`: Docker's port forwarding bypasses ufw. |
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
upgrades is **not** detected by it: use the `curl` upgrade test of step 6.

On Docker Desktop (Windows, macOS) the disk check sees Docker's virtual disk, not your real drive.

## Logs

```sh
docker compose -f docker/compose.yaml logs -f --tail=200 app compiler
```

and your proxy's own logs (e.g. `journalctl -u caddy -f`, or `/var/log/nginx/error.log`).

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

A nightly backup into `/var/backups/ligature`, kept 14 days. Install the script (if Ligature is not in
`/opt/ligature`, change `LIGATURE_DIR` at its top):

```sh
sudo tee /usr/local/bin/ligature-backup > /dev/null <<'EOF'
#!/usr/bin/env bash
# Online backup of Ligature, copied out of the data volume into $LIGATURE_BACKUPS.
set -euo pipefail
LIGATURE_DIR="${LIGATURE_DIR:-/opt/ligature}"            # where you cloned Ligature
LIGATURE_BACKUPS="${LIGATURE_BACKUPS:-/var/backups/ligature}"
cd "$LIGATURE_DIR"
C="docker compose -f docker/compose.yaml"
dest="$LIGATURE_BACKUPS"
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

To move an instance to another server: back up, copy the directory over, deploy there (steps 1 to 3), restore, add it to the proxy (step 5),
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
docker image prune -f --filter label=io.ligature.image   # 6. free the space of Ligature's old images only
```

Step 6 removes only Ligature's previous images (they carry the label `io.ligature.image`), never other
projects' images. On a server used only by Ligature, `docker builder prune -f` also frees the build cache;
after a TeX Live update, `docker images texlive/texlive` lists the old base image to remove.

**Rollback:** `git checkout <previous tag or commit>` (see `git log --oneline`), then
`docker compose -f docker/compose.yaml up -d --build`. If the new version changed the database schema, the
old code refuses to start (`... has database schema vN, but this version of Ligature only knows schemas up
to ...`): restore the backup taken in step 1. Go back to the latest code later with `git checkout main`.

## A second instance on the same server

For example a test copy next to the real one: clone into another directory and give it its own name, port
and host name in its `docker/.env`:

```sh
sudo git clone https://github.com/Zoryc/Ligature /opt/ligature-test && sudo chown -R "$USER": /opt/ligature-test
cd /opt/ligature-test && cp docker/.env.example docker/.env
# in docker/.env:  COMPOSE_PROJECT_NAME=ligature-test   LIGATURE_PORT=3001   LIGATURE_ORIGIN=https://test.example.org
```

Everything then follows that name: containers `ligature-test-app-1`, network `ligature-test_default`, volumes
`ligature-test_data` ... (the two instances share nothing). Add it to your proxy with port 3001 (step 5), and
back it up with `LIGATURE_DIR=/opt/ligature-test LIGATURE_BACKUPS=/var/backups/ligature-test ligature-backup`.

## Windows and macOS (Docker Desktop)

For a local trial the same compose stack works with Docker Desktop: from the repository, `npm run stack -- up`
starts it behind a local Caddy at <http://localhost:8080> (`docker/compose.local.yaml`; `npm run stack -- stop`
to stop it). Or without any proxy: `LIGATURE_ORIGIN=http://localhost:3000` in `docker/.env`, then open that URL. Run the backup and restore
commands in WSL, or in Git Bash with `export MSYS_NO_PATHCONV=1` (otherwise Git Bash rewrites container paths
such as `/data/backups` into Windows paths). The disk check of `/healthz` sees Docker's virtual disk.

## CI

`.github/workflows/ci.yml`, job `docker`, builds both images with the medium TeX Live scheme
(`scripts/ci/compose.ci.env`), starts this stack, and runs `scripts/ci/smoke.sh` against it: first signup
(admin), project, image upload, compile through the real compiler container, PDF download, then
`ligature backup` and `ligature reset-password` inside the app container.
