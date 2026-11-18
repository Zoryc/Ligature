/**
 * Ligature compiler worker entrypoint.
 *   node src/worker.ts            (Node >= 23.6 strips types by default; older: --experimental-strip-types)
 * Configuration: environment variables, see config.ts / README.md.
 */
import { startWorker } from './app.ts'
import { loadConfig } from './config.ts'

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)
  const w = await startWorker(cfg)
  console.log(`[compiler] listening on ${w.address}  sandbox=${cfg.sandbox}  builds=${cfg.buildsDir}  latexmk=${JSON.stringify(cfg.latexmk)}`)
  let stopping = false
  const stop = (sig: string) => {
    if (stopping) return
    stopping = true
    console.log(`[compiler] ${sig}: shutting down`)
    void w.close().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

main().catch((e: unknown) => {
  console.error(`[compiler] fatal: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
