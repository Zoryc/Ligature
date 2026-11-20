#!/usr/bin/env node
// Run the test suite in Docker, on Linux with TeX Live, like CI (works the same on Windows, macOS and Linux).
//
//   npm run test:docker                       typecheck, every suite, web build (as an unprivileged user)
//   npm run test:docker -- server             only one workspace: server | web | compiler | shared | latex-log-parser | synctex
//   npm run test:docker -- server test/x.test.ts   ... and only some test files (vitest arguments)
//   npm run test:docker -- sandbox            the uid sandbox tests and the malicious-TeX corpus (as root)
//   npm run test:docker -- all                both
//
// The image (docker/Dockerfile.test) is rebuilt each run; Docker reuses every unchanged layer, so after the
// first build (TeX Live download) only the source layer is redone.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'ligature-test'

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repo, stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  return r.status ?? 1
}

function dockerReady() {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { cwd: repo, encoding: 'utf8' })
  if (r.error) {
    console.error('docker-test: the docker command was not found. Install Docker (Docker Desktop on Windows/macOS).')
    return false
  }
  if (r.status !== 0) {
    console.error('docker-test: Docker is not running. Start it (Docker Desktop, or: docker desktop start) and try again.')
    return false
  }
  return true
}

const args = process.argv.slice(2)
const mode = args[0] === 'sandbox' || args[0] === 'all' ? args.shift() : 'test'

if (!dockerReady()) process.exit(1)

console.log(`docker-test: building ${IMAGE} (unchanged layers are reused)`)
if (run('docker', ['build', '-f', 'docker/Dockerfile.test', '-t', IMAGE, '.']) !== 0) process.exit(1)

// Like CI: an init as PID 1 reaps orphaned TeX processes; the outgoing port range stays clear of the fixed
// test ports (391xx-399xx).
const base = ['run', '--rm', '--init', '--sysctl', 'net.ipv4.ip_local_port_range=50000 65000']
const modes = mode === 'all' ? ['test', 'sandbox'] : [mode]
let failed = 0
for (const m of modes) {
  console.log(`\ndocker-test: ${m}${args.length ? ' ' + args.join(' ') : ''}`)
  const status = run('docker', [...base, IMAGE, 'node', 'scripts/docker-test-entry.mjs', m, ...args])
  if (status !== 0) {
    failed++
    console.error(`docker-test: ${m} FAILED (exit ${status})`)
  } else {
    console.log(`docker-test: ${m} passed`)
  }
}
process.exit(failed ? 1 : 0)
