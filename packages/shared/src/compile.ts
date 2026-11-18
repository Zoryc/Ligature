/** Contract between the app and the compiler worker. */

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex'
export const ENGINES: readonly Engine[] = ['pdflatex', 'xelatex', 'lualatex']

export type CompileStatus = 'success' | 'failure' | 'timeout' | 'error'

/** path (relative, '/'-separated) -> sha256 hex of content */
export type Manifest = Record<string, string>

/** POST /projects/:id/sync  body: SyncRequest  -> SyncResponse */
export interface SyncRequest { manifest: Manifest }
export interface SyncResponse { missing: string[] /* sha256 hashes the worker does not have */ }

/** PUT /blobs/:sha256  body: raw bytes  -> 204 (worker verifies the hash) */

/** POST /projects/:id/compile  body: CompileRequest  -> CompileResponse */
export interface CompileRequest {
  /** Same manifest as the preceding sync; the worker materialises exactly this. */
  manifest: Manifest
  mainFile: string
  engine: Engine
  /** Wipe out/ before building. */
  clean?: boolean
  timeoutMs?: number
}
export interface CompileResponse {
  status: CompileStatus
  durationMs: number
  /** Output files available via GET /projects/:id/output/:name */
  outputs: string[]
  /** Tail-capped log text. */
  log: string
}

/** GET /projects/:id/output/:name  -> raw bytes (pdf | log | synctex.gz) */
export const OUTPUT_NAMES = ['output.pdf', 'output.log', 'output.synctex.gz'] as const
export type OutputName = (typeof OUTPUT_NAMES)[number]
