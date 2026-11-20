---
name: test-in-docker
description: How to test Ligature — always in Docker. Use for any testing or verification of a change in this repository (running the test suites, the uid sandbox / malicious-TeX corpus, or trying the real app end to end), instead of running tests natively on Windows or using the native dev servers.
---

# Testing Ligature in Docker

The project owner wants every test run in Docker (Linux + TeX Live, like CI and production), not natively on
Windows. Native `npm test` skips the Linux-only tests and differs from CI; don't use it to report results.

## 0. Docker must be running

```powershell
docker info --format '{{.ServerVersion}}'    # fails => start it:
docker desktop start                          # then wait until `docker info` works (up to ~1 min)
```

In the Bash/PowerShell tools, Docker may not be on PATH: in PowerShell first run
`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`;
in Git Bash `export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"`.

## 1. Test suites: `npm run test:docker`

Runs in `docker/Dockerfile.test` (TeX Live medium + Node 24, the same base as CI). The image is rebuilt each
run, reusing unchanged layers: only the source layer (and `npm ci` when package-lock.json changed) is redone.

| Command | What |
|---|---|
| `npm run test:docker` | typecheck, every suite (CI=true: nothing silently skips), web build, as an unprivileged user — CI's `test` job |
| `npm run test:docker -- server` | one workspace (`server`, `web`, `compiler`, `shared`, `latex-log-parser`, `synctex`): its typecheck + tests |
| `npm run test:docker -- server test/restore.test.ts` | one workspace, only some test files (vitest args) |
| `npm run test:docker -- sandbox` | as root: the real uid sandbox tests + the malicious-TeX corpus — CI's `sandbox` job |
| `npm run test:docker -- all` | both |

The full run takes several minutes: start it with `run_in_background` and wait for the notification. Use the
single-workspace form while iterating, and the full `npm run test:docker` (plus `sandbox` when the compiler
changed) before committing. Report the exact pass/fail counts from its output.

## 2. The real app: `npm run stack -- up`

The production stack (`docker/compose.yaml` + `docker/compose.local.yaml`: app, offline compiler, Caddy) at
**http://localhost:8080**, compose project `ligature-local` with its own volumes.

- `npm run stack -- up` — build and start (`--wait` until healthy); prints the first-admin setup link on a
  fresh volume (production mode requires it). Create throwaway test accounts with generated passwords kept in
  the scratchpad, never in chat.
- Check: `curl http://localhost:8080/healthz`, then the browser pane at http://localhost:8080 for UI changes.
- `npm run stack -- logs` / `ps` / `stop` (keeps data and images) / `down` (removes local data volumes).
- After a change: `npm run stack -- up` again rebuilds only what changed (app image ~20 s; the 9.6 GB compiler
  image is reused unless docker/Dockerfile.compiler or apps/compiler changed).
- When done: `npm run stack -- stop`, and `docker desktop stop` to give the RAM back to the user.

## 3. Rules

- Commit only after the Docker test run passes; say which commands ran and their counts.
- If something can only be checked natively (e.g. a Windows-specific script), say so explicitly.
- Never bind or stop the user's own containers/ports other than the `ligature-local` project and `ligature-test` image.
