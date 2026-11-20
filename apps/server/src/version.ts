import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Ligature version: the root package.json's `version` (the repository root in development,
 * /app/package.json in the Docker image). Shown by `ligature --version`, the startup log line and the
 * admin page, so a host knows exactly what runs (CHANGELOG.md, git tag v<version>).
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()
