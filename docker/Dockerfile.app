# syntax=docker/dockerfile:1
#
# Ligature app: API + collaboration server (apps/server), which also serves the built SPA (apps/web/dist,
# WEB_DIST_DIR), plus the operator CLI as `ligature` on PATH.
# Build from the repository root:   docker build -f docker/Dockerfile.app -t ligature-app .
# (docker/Dockerfile.app.dockerignore keeps node_modules, dev databases and build caches out of the context.)

ARG NODE_IMAGE=node:24-bookworm-slim

# --- build: install the workspace and build the web client ----------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
# Manifests first, so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/compiler/package.json apps/compiler/package.json
COPY packages/shared/package.json packages/shared/package.json
# better-sqlite3 (prebuilds/<platform>.node) and @node-rs/argon2 / esbuild (per-platform optional packages)
# ship prebuilt binaries, so no compiler toolchain is needed. --ignore-scripts matters: without it npm runs
# its implicit `node-gyp rebuild` for better-sqlite3 (it has a binding.gyp), which needs python/make/g++.
RUN npm ci --no-audit --no-fund --ignore-scripts \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()" \
 && node -e "require('@node-rs/argon2')"
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build -w @ligature/web && test -f apps/web/dist/index.html
# The server runs from TypeScript through tsx (it uses non-erasable syntax), which is a devDependency,
# so dev dependencies are kept; drop only the web toolchain's weight if image size matters later.

# --- runtime ----------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json /src/tsconfig.base.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/packages/shared packages/shared
COPY --from=build /src/apps/server apps/server
# The SPA, served by the app itself for every non-/api, non-/collab GET (WEB_DIST_DIR below).
COPY --from=build /src/apps/web/dist apps/web/dist
# Operator CLI: `docker compose exec app ligature backup|reset-password|create-admin ...`
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/main.ts"]
