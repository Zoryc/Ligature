// Inside the test container (docker/Dockerfile.test), started by scripts/docker-test.mjs as root.
//   test [workspace] [vitest args]   as the unprivileged user `ci`, like CI's `test` job
//   sandbox [vitest args]            as root, like CI's `sandbox` job (uid sandbox + malicious-TeX corpus)
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'

const [mode = 'test', ...rest] = process.argv.slice(2)
const WORKSPACES = {
  server: '@ligature/server', web: '@ligature/web', compiler: '@ligature/compiler', shared: '@ligature/shared',
  'latex-log-parser': '@ligature/latex-log-parser', synctex: '@ligature/synctex',
}

function sh(cmd, args, env = {}, asCi = false) {
  const full = asCi ? ['setpriv', ['--reuid=ci', '--regid=ci', '--init-groups', 'env', 'HOME=/home/ci', `PATH=${process.env.PATH}`, cmd, ...args]] : [cmd, args]
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(full[0], full[1], { stdio: 'inherit', env: { ...process.env, ...env } })
  return r.status ?? 1
}

// CI=true: tests that need TeX or POSIX fail instead of skipping. The corpus runs in `sandbox` mode.
const TEST_ENV = { CI: 'true', CORPUS_SKIP_REASON: 'runs in the sandbox mode (uid sandbox, as root)' }

function testMode() {
  const ws = rest[0] && WORKSPACES[rest[0]] ? WORKSPACES[rest.shift()] : null
  if (ws) {
    // One workspace: its typecheck (if any) and its tests (optionally only some files).
    const steps = [['npm', ['run', 'typecheck', '-w', ws, '--if-present']], ['npm', ['test', '-w', ws, ...(rest.length ? ['--', ...rest] : [])]]]
    for (const [c, a] of steps) if (sh(c, a, TEST_ENV, true) !== 0) return 1
    return 0
  }
  if (rest.length) {
    console.error(`unknown workspace "${rest[0]}": use one of ${Object.keys(WORKSPACES).join(', ')}`)
    return 2
  }
  for (const [c, a] of [['npm', ['run', 'typecheck']], ['npm', ['test']], ['npm', ['run', 'build', '-w', '@ligature/web']]]) {
    if (sh(c, a, TEST_ENV, true) !== 0) return 1
  }
  return 0
}

function sandboxMode() {
  // Like the production compiler container: no world-writable directory a document could climb into
  // (corpus case 4 then fails on a write there). The tests' own temp dirs go to a 0755 directory.
  mkdirSync('/srv/ligature-tmp', { recursive: true, mode: 0o755 })
  for (const d of ['/tmp', '/var/tmp', '/dev/shm']) if (existsSync(d)) chmodSync(d, 0o700)
  return sh('bash', ['scripts/ci/compiler-sandbox-tests.sh', ...rest], { TMPDIR: '/srv/ligature-tmp', CORPUS_NO_WORLD_WRITABLE: '1' })
}

process.exit(mode === 'sandbox' ? sandboxMode() : mode === 'test' ? testMode() : (console.error(`unknown mode ${mode}`), 2))
