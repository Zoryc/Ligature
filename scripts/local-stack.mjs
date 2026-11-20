#!/usr/bin/env node
// The production stack (docker/compose.yaml) on this machine, behind Caddy at http://localhost:8080, to try
// the real deployment: `npm run stack -- <command>`.
//
//   up       build the images and start (first build: TeX Live download); prints the first-admin setup link
//   ps       the containers and their health
//   logs     follow the logs (app, compiler, caddy)
//   stop     stop the containers, keep images and data (fast to start again)
//   down     remove the containers and the local data volumes (images are kept)
//
// It uses its own compose project (`ligature-local`, own volumes) and LIGATURE_ORIGIN=http://localhost:8080,
// LIGATURE_PORT=3100 (3000 is the dev server's), whatever docker/.env says.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: 'ligature-local',
  LIGATURE_ORIGIN: 'http://localhost:8080',
  LIGATURE_PORT: process.env.LIGATURE_PORT ?? '3100',
  LIGATURE_TRUST_PROXY: '1',
}
const compose = ['compose', '-f', 'docker/compose.yaml', '-f', 'docker/compose.local.yaml']

function docker(args, capture = false) {
  const r = spawnSync('docker', args, { cwd: repo, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' })
  if (r.error) {
    console.error('stack: the docker command was not found. Install Docker (Docker Desktop on Windows/macOS).')
    process.exit(1)
  }
  return r
}

const cmd = process.argv[2] ?? 'ps'
if (docker(['info', '--format', '{{.ServerVersion}}'], true).status !== 0) {
  console.error('stack: Docker is not running. Start it (Docker Desktop, or: docker desktop start) and try again.')
  process.exit(1)
}

switch (cmd) {
  case 'up': {
    const r = docker([...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '600'])
    if (r.status !== 0) process.exit(r.status ?? 1)
    const logs = docker([...compose, 'logs', '--no-color', 'app'], true).stdout ?? ''
    const setup = logs.split('\n').filter(l => l.includes('No accounts yet')).at(-1)
    console.log('\nLigature is running at http://localhost:8080')
    if (setup) console.log(`First admin: ${setup.replace(/^.*?\[ligature\] /, '')}`)
    break
  }
  case 'ps': process.exit(docker([...compose, 'ps']).status ?? 1); break
  case 'logs': process.exit(docker([...compose, 'logs', '-f', '--tail=200']).status ?? 1); break
  case 'stop': process.exit(docker([...compose, 'stop']).status ?? 1); break
  case 'down': process.exit(docker([...compose, 'down', '-v']).status ?? 1); break
  default:
    console.error(`stack: unknown command "${cmd}" (up, ps, logs, stop, down)`)
    process.exit(2)
}
