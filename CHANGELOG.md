# Changelog

Ligature follows [semantic versioning](https://semver.org): a new major version may need a manual step
when upgrading (it is then listed under **Upgrading**). Each version is a git tag (`v1.0.0`); hosts build
the images from it (`git checkout v1.0.0`, then `docker compose -f docker/compose.yaml up -d --build`).

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
