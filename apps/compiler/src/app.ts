/** Assemble and start a worker from a Config (used by worker.ts and by the tests). */
import type { Server } from 'node:http'
import type { Config } from './config.ts'
import { createHttpServer } from './http.ts'
import { listenOn } from './listen.ts'
import { defaultHelperArgv } from './runner.ts'
import { createSandbox } from './sandbox/index.ts'
import { CompilerService } from './service.ts'

export interface RunningWorker {
  server: Server
  service: CompilerService
  /** e.g. "tcp:127.0.0.1:7071" or "unix:/run/ligature/compiler.sock" */
  address: string
  close(): Promise<void>
}

export async function startWorker(cfg: Config, opts: { env?: NodeJS.ProcessEnv; helperArgv?: string[] } = {}): Promise<RunningWorker> {
  const sandbox = createSandbox(cfg.sandbox, { prlimit: cfg.prlimit, latexmk: cfg.latexmk, env: opts.env ?? process.env })
  const service = new CompilerService({
    buildsDir: cfg.buildsDir,
    sandbox,
    latexmk: cfg.latexmk,
    helperArgv: opts.helperArgv ?? defaultHelperArgv(),
    maxTimeoutMs: cfg.maxTimeoutMs,
    quota: cfg.quota,
    blobCache: cfg.blobCache,
    buildDirMaxIdleMs: cfg.buildDirMaxIdleMs,
    minFreeBytes: cfg.minFreeBytes,
  })
  await service.init()
  const server = createHttpServer(service)
  const address = await listenOn(server, cfg.listen, cfg.socketGid)
  return {
    server, service, address,
    close: () => new Promise<void>(resolve => {
      service.close()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
