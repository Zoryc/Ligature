/**
 * Container HEALTHCHECK: GET /healthz on the listener named by COMPILER_LISTEN (same default as the
 * worker). Exit 0 if it answers 200 within 4 s, else 1.
 *   node src/healthcheck.ts
 */
import { get } from 'node:http'
import { parseListen } from './config.ts'

function main(): void {
  const production = process.env.NODE_ENV === 'production'
  const l = parseListen(process.env.COMPILER_LISTEN ?? (production ? 'unix:/run/ligature/compiler.sock' : 'tcp:127.0.0.1:7071'))
  const target = l.kind === 'unix' ? { socketPath: l.path } : { host: l.host, port: l.port }
  const req = get({ ...target, path: '/healthz', timeout: 4000 }, res => {
    res.resume()
    process.exit(res.statusCode === 200 ? 0 : 1)
  })
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.on('error', () => process.exit(1))
}

try {
  main()
} catch {
  process.exit(1)
}
