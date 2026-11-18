/**
 * Runtime values of the app <-> compiler contract.
 *
 * Types come from @ligature/shared (type-only imports are erased, so they cost nothing at runtime).
 * The few runtime values are duplicated here on purpose: the worker runs with plain Node type stripping,
 * which refuses to strip .ts files that live under node_modules, so importing the workspace package at
 * runtime is fragile in the container. test/contract.test.ts asserts these copies agree with the
 * originals in packages/shared.
 */
import type { CompileRequest, CompileResponse, CompileStatus, Engine, Manifest, OutputName, SyncRequest, SyncResponse }
  from '@ligature/shared'

export type { CompileRequest, CompileResponse, CompileStatus, Engine, Manifest, OutputName, SyncRequest, SyncResponse }

export const ENGINES: readonly Engine[] = ['pdflatex', 'xelatex', 'lualatex']
export const OUTPUT_NAMES: readonly OutputName[] = ['output.pdf', 'output.log', 'output.synctex.gz']

export const MAX_NAME_LEN = 255
export const MAX_PATH_LEN = 1024
export const MAX_DEPTH = 32

// Same character class as packages/shared/src/paths.ts.
const BAD_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/

export function isValidName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LEN) return false
  if (name === '.' || name === '..') return false
  if (BAD_CHARS.test(name)) return false
  if (name !== name.trim()) return false
  return true
}

export function isValidRelPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LEN) return false
  const parts = path.split('/')
  if (parts.length > MAX_DEPTH) return false
  return parts.every(isValidName)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH_RE = /^[0-9a-f]{64}$/

/** Lowercase canonical UUID (what crypto.randomUUID produces). */
export const isUuid = (s: string): boolean => UUID_RE.test(s)
/** sha256 as 64 lowercase hex chars. */
export const isHash = (s: string): boolean => HASH_RE.test(s)
export const isEngine = (s: unknown): s is Engine => typeof s === 'string' && (ENGINES as readonly string[]).includes(s)
export const isOutputName = (s: unknown): s is OutputName =>
  typeof s === 'string' && (OUTPUT_NAMES as readonly string[]).includes(s)

export const ENGINE_FLAG: Record<Engine, string> = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' }
