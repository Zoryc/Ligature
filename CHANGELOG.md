# Changelog

Ligature follows [semantic versioning](https://semver.org): a new major version may need a manual step
when upgrading (it is then listed under **Upgrading**). Each version is a git tag (`v1.0.0`); hosts build
the images from it (`git checkout v1.0.0`, then `docker compose -f docker/compose.yaml up -d --build`).

## Unreleased

**Delete an account** ([docs/ACCOUNT-DELETION.md](docs/ACCOUNT-DELETION.md)). Immediate and permanent, after a
preview of exactly what will happen.
- **Your own account** (Account page): confirmed with your password. Projects where you are the only member are
  deleted with it; you leave the others. Refused while you own a project that has other members: transfer its
  ownership first (Members panel).
- **Any account, by an admin** (Admin → Users → Delete…): confirmed by typing the username. Ownership of the
  person's shared projects passes to the longest-standing editor (or viewer).
- Text they wrote in shared projects and the history stay, shown as "a former member". Their sessions,
  invites, username, display name and login addresses are removed (also from the audit log, which keeps the
  entries themselves); open tabs are logged out at once. The username can be used for a new account.
- The last active admin cannot be deleted.

## 1.1.0 — 2026-11-20

**Ligature no longer sets up a reverse proxy.** It runs on `127.0.0.1:3000` and you add it as one site to the
proxy you already use (Caddy, nginx, Traefik, ...), next to your other sites. The 1.0.0 guide replaced the
whole Caddyfile, which removed a server's other sites.

**Upgrading from 1.0.0:** nothing to do for Ligature itself (`git pull`, then `up -d --build`). If you
followed the 1.0.0 guide, your Caddyfile is already set up; to get the safer `X-Forwarded-For` handling below,
add `header_up X-Forwarded-For {client_ip}` inside its `reverse_proxy` block (see `docker/Caddyfile.example`).

**Deployment guide** ([docker/README.md](docker/README.md))
- Step 5, "Add Ligature to your reverse proxy", tested in Docker against both proxies:
  - **Caddy**: the site block is appended to a copy of your Caddyfile, validated, then swapped in, so a
    mistake never leaves a broken config (or one glued onto a last line without a newline).
  - **nginx** (new): a complete site config that works with Ubuntu 24.04's nginx 1.24 and newer. The
    certificate is obtained with `certbot certonly`, because plain `certbot --nginx` copies the default site,
    which then takes over the host name. The site is disabled again if `nginx -t` fails.
  - **A proxy in Docker**: connect it to `ligature_default` and use `ligature-app-1:3000` (unique on the host);
    nginx re-resolves it through Docker's DNS, so an upgrade does not leave it on an old address.
- The proxy sets `X-Forwarded-For` to the client's address itself (Caddy `{client_ip}`, nginx
  `$remote_addr`), so login rate limits cannot be bypassed with a forged header (behind a CDN, as long as
  the proxy is told how to find the real client; the guide says how).
- Safe on a server that already runs other things: `ufw enable` only on a fresh server; Docker is not
  reinstalled when present; the upgrade's clean-up removes only Ligature's old images (new image label
  `io.ligature.image`), never other projects' images or build cache; the backup script works from any
  directory (`LIGATURE_DIR`).
- New: running a second instance on the same server (`COMPOSE_PROJECT_NAME` in `docker/.env`).

**Interface**
- The drawn "Li" of the logo is rendered on whole pixels and no longer clipped at the edge of its box,
  so it is a little sharper at small sizes.

## 1.0.0 — 2026-11-20

The first release: a self-hosted, real-time collaborative LaTeX editor for a team that trusts each other.

**Writing together**
- Accounts, projects with owner / editor / viewer roles, invite links.
- Live co-editing (Yjs, server-authoritative), with each person's cursor and who is online.
- File tree with folders, uploads (drag and drop), zip import and export, and a trash can.
- History: automatic and named versions, side-by-side differences, restore of a file or the whole project
  (with undo).

**Compiling**
- pdfLaTeX, XeLaTeX and LuaLaTeX on the server (TeX Live), auto-compile while you type, Ctrl+S.
- Errors in the editor and in a Problems list, with plain-language explanations and a one-click
  "add the missing package" fix; LuaTeX, BibTeX and Biber failures explained too.
- SyncTeX: from the source to the PDF and back.
- Compiles run sandboxed: no network, one Unix user per project, read-only system, time / memory / disk
  limits, tested in CI against a set of malicious documents.

**Interface**
- The Folio design (paper, ink and one teal accent; square corners), the Vinculum logo, a Contents outline
  of the document across files, a Settings panel (shared project settings with "changed by …", and
  personal ones).

**Running a server**
- Docker Compose: two containers (app, offline compiler) built on your server, behind Caddy or any TLS
  proxy; a step-by-step guide for a fresh Ubuntu server ([docker/README.md](docker/README.md)).
- First admin through a one-time setup link printed in the server log (or `ligature create-admin`).
- Admin page: users, sign-up mode (invite only / open / closed), storage, and an audit log of who did what.
- `/healthz` for uptime monitors (database, disk, saving of edits, live connection, compiler).
- `ligature backup` and `ligature restore` (validated, keeps a safety copy, open editor tabs reload
  instead of overwriting the restored text), password reset from the command line.
- The version is shown to admins only (bottom of the Admin page) and by `ligature --version`.

**Known limits**
- For trusted users: keep sign-up on *invite only* or *closed* (see [SECURITY.md](SECURITY.md)) until the
  stronger gVisor sandbox is available.
- No email (password resets are done by an admin), no comments or track changes yet, no git sync.
