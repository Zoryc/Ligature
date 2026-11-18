/** Binding the HTTP server to a unix socket (production) or a TCP port (development only). */
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Listen } from './config.ts'
import { errnoCode } from './fsSafe.ts'

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0

/**
 * Unix socket: the directory is created root-owned with mode 0700, so sandboxed compile processes
 * (other uids) cannot reach the worker. If socketGid is set (app container runs as a non-root user),
 * the directory becomes root:<gid> 0710 and the socket root:<gid> 0660 — project gids are >= 100000,
 * so they still cannot connect.
 */
export async function listenOn(server: Server, l: Listen, socketGid: number | null = null): Promise<string> {
  if (l.kind === 'tcp') {
    // loadConfig refuses a non-loopback host unless ALLOW_TCP=1; this is the reminder when it was allowed.
    const loopback = l.host === 'localhost' || l.host === '::1' || /^127(\.\d{1,3}){3}$/.test(l.host)
    if (!loopback) console.warn(`[compiler] WARNING: TCP listener on non-loopback ${l.host}; the worker has no authentication`)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(l.port, l.host, () => { server.off('error', reject); resolve() })
    })
    const a = server.address() as AddressInfo
    return `tcp:${a.address}:${a.port}`
  }

  const dir = dirname(l.path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const st = await lstat(dir)
  if (!st.isDirectory()) throw new Error(`socket directory ${dir} is not a directory`)
  if (isRoot()) {
    await chown(dir, 0, socketGid ?? 0)
    await chmod(dir, socketGid === null ? 0o700 : 0o710)
  } else if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`socket directory ${dir} is not owned by this user`)
  }
  try {
    const s = await lstat(l.path)
    if (!s.isSocket()) throw new Error(`${l.path} exists and is not a socket`)
    await unlink(l.path) // stale socket from a previous run
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') throw e
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(l.path, () => { server.off('error', reject); resolve() })
  })
  await chmod(l.path, socketGid === null ? 0o600 : 0o660)
  if (isRoot()) await chown(l.path, 0, socketGid ?? 0)
  return `unix:${l.path}`
}
