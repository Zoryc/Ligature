#!/usr/bin/env bash
# End-to-end smoke test of a running Ligature stack (docker/compose.yaml), through the public API only:
# sign up the first user (becomes admin), create a project, upload an image, compile, download the PDF.
# With SMOKE_CLI=1 it also exercises the operator CLI inside the app container (`docker compose exec`,
# so COMPOSE_FILE / COMPOSE_ENV_FILES must point at the stack): backup, reset-password.
#
#   scripts/ci/smoke.sh [base-url]        default http://127.0.0.1:3000
# Env: LIGATURE_ORIGIN (Origin header for mutating requests; default: the base URL), SMOKE_CLI=1,
#      SMOKE_TIMEOUT (seconds to wait for the app, default 180). Needs curl and jq.
set -euo pipefail

BASE="${1:-http://127.0.0.1:3000}"
ORIGIN="${LIGATURE_ORIGIN:-$BASE}"
USER_NAME="ci-admin"
PASSWORD="ci-smoke-password-1"
NEW_PASSWORD="ci-smoke-password-2"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
COOKIE=""

log() { printf '[smoke] %s\n' "$*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

# api METHOD PATH [JSON-BODY] -> body in $tmp/body, headers in $tmp/headers, prints the HTTP status.
# The session cookie is passed explicitly: in production it is Secure, which curl's cookie jar would
# not send back over plain http.
api() {
  local method=$1 path=$2 body=${3-}
  local args=(-sS -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' -X "$method" -H "Origin: $ORIGIN")
  [ -n "$COOKIE" ] && args+=(-H "Cookie: $COOKIE")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  curl "${args[@]}" "$BASE$path"
}

# expect STATUS METHOD PATH [BODY]
expect() {
  local want=$1; shift
  local got
  got="$(api "$@")"
  if [ "$got" != "$want" ]; then
    log "$1 $2 -> HTTP $got (expected $want)"
    head -c 4000 "$tmp/body" >&2 || true
    echo >&2
    fail "$1 $2"
  fi
  log "$1 $2 -> $got"
}

session_cookie() {
  local c
  c="$(grep -i '^set-cookie: ligature_session=' "$tmp/headers" | head -n 1 | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]*).*/\1/' | tr -d '\r')"
  [ -n "$c" ] || fail "no ligature_session cookie in the response"
  printf '%s' "$c"
}

# 1. Wait for the app.
deadline=$(( $(date +%s) + ${SMOKE_TIMEOUT:-180} ))
until curl -fsS -o "$tmp/body" "$BASE/api/instance" 2>/dev/null; do
  [ "$(date +%s)" -lt "$deadline" ] || fail "the app did not answer $BASE/api/instance in time"
  sleep 2
done
log "instance: $(cat "$tmp/body")"
[ "$(jq -r .hasUsers "$tmp/body")" = "false" ] || fail "expected a fresh instance (hasUsers=false)"

# 2. The SPA is served by the app (WEB_DIST_DIR), with the app-shell CSP.
code="$(curl -sS -o "$tmp/index.html" -D "$tmp/headers" -w '%{http_code}' "$BASE/")"
[ "$code" = 200 ] || fail "GET / -> $code"
grep -qi '<!doctype html' "$tmp/index.html" || fail "GET / is not the SPA's index.html"
grep -qi '^content-security-policy:' "$tmp/headers" || fail "GET / has no Content-Security-Policy"
code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/some/client/route")"
[ "$code" = 200 ] || fail "SPA fallback GET /some/client/route -> $code"
log "SPA served"

# 3. First signup becomes instance admin.
expect 200 POST /api/auth/signup "{\"username\":\"$USER_NAME\",\"displayName\":\"CI Admin\",\"password\":\"$PASSWORD\"}"
[ "$(jq -r .isAdmin "$tmp/body")" = "true" ] || fail "the first account is not admin"
COOKIE="$(session_cookie)"
expect 200 GET /api/me
[ "$(jq -r .username "$tmp/body")" = "$USER_NAME" ] || fail "GET /api/me returned the wrong user"

# 4. Create a project (main.tex from the template) and upload an image into it.
expect 200 POST /api/projects '{"name":"CI smoke"}'
project="$(jq -r .id "$tmp/body")"
root="$(jq -r .rootId "$tmp/body")"
[ "$(jq -r '.tree[] | select(.name == "main.tex") | .kind' "$tmp/body")" = "text" ] || fail "no main.tex in the new project"
log "project $project"
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$tmp/pixel.png"
code="$(curl -sS -o "$tmp/body" -w '%{http_code}' -X POST -H "Origin: $ORIGIN" -H "Cookie: $COOKIE" \
  -H 'Content-Type: application/octet-stream' --data-binary "@$tmp/pixel.png" \
  "$BASE/api/projects/$project/upload?parentId=$root&name=pixel.png")"
[ "$code" = 200 ] || { cat "$tmp/body" >&2; fail "upload -> $code"; }
[ "$(jq -r .kind "$tmp/body")" = "binary" ] || fail "the uploaded PNG is not a binary file"
log "uploaded pixel.png"

# 5. Compile through the real compiler container and download the PDF.
expect 200 POST "/api/projects/$project/compile"
status="$(jq -r .status "$tmp/body")"
build="$(jq -r .buildId "$tmp/body")"
if [ "$status" != "success" ]; then
  jq -r .log "$tmp/body" | tail -n 60 >&2
  fail "compile status $status"
fi
log "compile: success in $(jq -r .durationMs "$tmp/body") ms (build $build)"
code="$(curl -sS -o "$tmp/output.pdf" -w '%{http_code}' -H "Cookie: $COOKIE" "$BASE/api/projects/$project/builds/$build/output.pdf")"
[ "$code" = 200 ] || fail "GET output.pdf -> $code"
[ "$(head -c 5 "$tmp/output.pdf")" = "%PDF-" ] || fail "output.pdf does not start with %PDF-"
log "PDF downloaded: $(wc -c < "$tmp/output.pdf") bytes"

# 6. Operator CLI inside the app container.
if [ "${SMOKE_CLI:-0}" = "1" ]; then
  backup="$(docker compose exec -T app ligature backup /data/backups | tail -n 1 | tr -d '\r')"
  [ -n "$backup" ] || fail "ligature backup printed no path"
  docker compose exec -T app test -s "$backup/app.db" || fail "no app.db in $backup"
  docker compose exec -T app test -s "$backup/backup.json" || fail "no backup.json in $backup"
  log "ligature backup -> $backup"

  printf '%s\n' "$NEW_PASSWORD" | docker compose exec -T app ligature reset-password "$USER_NAME"
  expect 401 GET /api/me                       # the reset deleted every session
  COOKIE=""
  expect 401 POST /api/auth/login "{\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}"
  expect 200 POST /api/auth/login "{\"username\":\"$USER_NAME\",\"password\":\"$NEW_PASSWORD\"}"
  log "ligature reset-password works"
fi

log "OK"
