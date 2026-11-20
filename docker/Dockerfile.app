# syntax=docker/dockerfile:1
#
# Ligature app: API + collaboration server (apps/server), which also serves the built SPA (apps/web/dist,
# WEB_DIST_DIR), plus the operator CLI as `ligature` on PATH.
# Build from the repository root:   docker build -f docker/Dockerfile.app -t ligature-app .
# (docker/Dockerfile.app.dockerignore keeps node_modules, dev databases and build caches out of the context.)
#
# Stages: `manifests` (package.json files + lockfile) feeds `build` (every dependency, builds the web client)
# and `server-deps` (the server's production dependencies only). The final image takes the server, its
# production node_modules and the built web client: no Vite, Svelte, CodeMirror, TypeScript or Vitest.
# All stages use the same base, so native modules match the final image's Node ABI and glibc.

ARG NODE_IMAGE=node:24-bookworm-slim

# --- manifests: what npm ci needs, shared by both install stages -----------------------------------
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
# Manifests first, so the dependency layers are cached across source edits.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/compiler/package.json apps/compiler/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/latex-log-parser/package.json packages/latex-log-parser/package.json
COPY packages/synctex/package.json packages/synctex/package.json
# Every workspace package needs its package.json here, or npm ci silently skips linking it into
# node_modules/@ligature/ (apps/compiler/test/deployConfig.test.ts checks this list against packages/*).

# --- build: install the whole workspace and build the web client ------------------------------------
FROM manifests AS build
# better-sqlite3 (prebuilds/<platform>.node) and @node-rs/argon2 / esbuild (per-platform optional packages)
# ship prebuilt binaries, so no compiler toolchain is needed. --ignore-scripts matters: without it npm runs
# its implicit `node-gyp rebuild` for better-sqlite3 (it has a binding.gyp), which needs python/make/g++.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN npm run build -w @ligature/web && test -f apps/web/dist/index.html

# --- server-deps: the server's production dependencies and sources ----------------------------------
FROM manifests AS server-deps
# -w @ligature/server --omit=dev: only what the server needs at runtime, plus the workspace packages it
# imports (packages/shared, latex-log-parser, synctex, linked into node_modules/@ligature/). The server
# runs its TypeScript through tsx (it uses non-erasable syntax), so tsx is a production dependency.
# better-sqlite3 ships its C sources and the prebuilt binaries of 8 platforms (~25 MB); only this
# platform's glibc binary is loaded (lib/binding.js), so the rest goes.
# The checks fail the build here, not at the first request, if a native module or tsx is missing.
RUN npm ci --omit=dev -w @ligature/server --no-audit --no-fund --ignore-scripts \
 && find node_modules/better-sqlite3/prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete \
 && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()" \
 && node -e "require('@node-rs/argon2')" \
 && test -x node_modules/.bin/tsx \
 && rm -rf /root/.npm
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server

# --- runtime ----------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
# Lets `docker image prune --filter label=io.ligature.image` remove only Ligature's old images (docker/README.md).
LABEL io.ligature.image=app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-deps /src/package.json /src/tsconfig.base.json ./
COPY --from=server-deps /src/node_modules node_modules
COPY --from=server-deps /src/packages packages
COPY --from=server-deps /src/apps/server apps/server
# The SPA, served by the app itself for every non-/api, non-/collab GET (WEB_DIST_DIR below).
COPY --from=build /src/apps/web/dist apps/web/dist
# Operator CLI: `docker compose exec app ligature backup|restore|reset-password|create-admin ...`
COPY --chmod=0755 docker/ligature /usr/local/bin/ligature

# Runs as the unprivileged "node" user (uid/gid 1000 in the official image). The compiler worker grants
# this gid access to its socket via COMPILER_SOCKET_GID=1000 (docker/compose.yaml).
# /data is the volume with app.db, blobs/ and build outputs; /data/backups is the default backup target.
RUN mkdir -p /data/backups /run/ligature && chown -R node:node /data
USER node

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/apps/web/dist \
    COMPILER_URL=unix:/run/ligature/compiler.sock
EXPOSE 3000
VOLUME ["/data"]

# /healthz checks the database, disk space, document store and a real /collab WebSocket over loopback
# (docs/M4.md §1). scope=app leaves out the compiler: restarting this container would not fix a stopped
# compiler, which has its own HEALTHCHECK. Each check has a 2 s timeout, well inside --timeout.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz?scope=app').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/main.ts"]
