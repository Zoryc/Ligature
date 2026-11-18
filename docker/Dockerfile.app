# syntax=docker/dockerfile:1
#
# Ligature app: API + collaboration server (apps/server) and the built SPA (apps/web).
# Build from the repository root:   docker build -f docker/Dockerfile.app -t ligature-app .

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
# better-sqlite3 / argon2 ship prebuilt binaries for linux-x64/arm64 glibc; no compiler toolchain needed.
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build -w @ligature/web
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
# Static SPA build. Not served yet: the server does not serve apps/web/dist today, and docker/Caddyfile.example
# only proxies to the app. Serving it (from the server, or Caddy with a copy of dist) is still open; see the PLAN.
COPY --from=build /src/apps/web/dist apps/web/dist

# Runs as the unprivileged "node" user (uid/gid 1000 in the official image). The compiler worker grants
# this gid access to its socket via COMPILER_SOCKET_GID=1000 (docker/compose.yaml).
RUN mkdir -p /data /run/ligature && chown node:node /data
USER node

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    COMPILER_URL=unix:/run/ligature/compiler.sock
EXPOSE 3000
VOLUME ["/data"]

WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/main.ts"]
