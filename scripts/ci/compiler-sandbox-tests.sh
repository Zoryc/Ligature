#!/usr/bin/env bash
# The compiler tests that need Linux and root: the real 'uid' sandbox (apps/compiler/test/uidSandbox.test.ts)
# and the malicious-TeX corpus with SANDBOX=uid (apps/compiler/test/corpus.test.ts, docs/M1.md §8).
# Missing prerequisites fail; nothing skips. Re-executes itself with sudo when not root.
#
#   scripts/ci/compiler-sandbox-tests.sh [extra vitest args]
#
# Needs: Linux, sudo, Node 24, `npm ci` done, latexmk + lualatex on PATH, prlimit, and a checkout that
# unprivileged uids can read (the per-project helper runs as uid >= 100000 and loads apps/compiler/src).
# On a host prepared like the production container (no world-writable /tmp, /var/tmp, /dev/shm; see the CI
# job), set CORPUS_NO_WORLD_WRITABLE=1 so that corpus case 4 fails on a write there instead of warning.
# The rest of the compiler suite runs as a normal user (`npm test`): with SANDBOX=none the helper
# refuses to run as root.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E env "PATH=$PATH" bash "$here/$(basename "${BASH_SOURCE[0]}")" "$@"
fi

# The helper must be readable by project uids: report (and fail) early instead of 40 failed compiles.
if ! setpriv --reuid=65534 --regid=65534 --clear-groups test -r "$repo/apps/compiler/src/helper.ts" 2>/dev/null; then
  echo "error: uid 65534 cannot read $repo/apps/compiler/src/helper.ts; make the checkout world-readable:" >&2
  namei -l "$repo/apps/compiler/src/helper.ts" >&2 || true
  exit 1
fi

cd "$repo/apps/compiler"
export SANDBOX=uid
export CI="${CI:-true}"
echo "node $(node --version), $(latexmk -v 2>/dev/null | sed -n 2p || true), uid $(id -u), SANDBOX=$SANDBOX"
exec "$repo/node_modules/.bin/vitest" run test/ciPrerequisites.test.ts test/uidSandbox.test.ts test/corpus.test.ts "$@"
