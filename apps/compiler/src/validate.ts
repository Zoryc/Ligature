/** Strict validation of request bodies. Nothing from the network touches the disk before passing these. */
import { isEngine, isHash, isValidRelPath, type Engine, type Manifest } from './contract.ts'
import { DEFAULT_TIMEOUT_MS, MAX_MANIFEST_ENTRIES, MIN_TIMEOUT_MS } from './limits.ts'

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function checkKeys(o: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `unknown field ${JSON.stringify(k)}`
  return null
}

/**
 * A manifest maps relative '/'-separated paths to sha256 hashes.
 * Rejects bad paths (.., absolute, control chars, ...), bad hashes, too many entries,
 * and paths that are both a file and a directory ("a" and "a/b").
 */
export function parseManifest(v: unknown): Result<Manifest> {
  if (!isPlainObject(v)) return fail('manifest must be an object')
  const entries = Object.entries(v)
  if (entries.length > MAX_MANIFEST_ENTRIES) return fail(`manifest has more than ${MAX_MANIFEST_ENTRIES} entries`)
  const files = new Set<string>()
  for (const [path, hash] of entries) {
    if (!isValidRelPath(path)) return fail(`invalid path ${JSON.stringify(path.slice(0, 200))}`)
    if (typeof hash !== 'string' || !isHash(hash)) return fail(`invalid hash for ${JSON.stringify(path)}`)
    files.add(path)
  }
  for (const path of files) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (files.has(dir)) return fail(`${JSON.stringify(dir)} is both a file and a directory`)
    }
  }
  // Object.fromEntries defines own properties, so a "__proto__" path stays an ordinary key.
  return { ok: true, value: Object.fromEntries(entries) as Manifest }
}

export function parseSyncRequest(v: unknown): Result<{ manifest: Manifest }> {
  if (!isPlainObject(v)) return fail('body must be an object')
  const bad = checkKeys(v, ['manifest'])
  if (bad) return fail(bad)
  const m = parseManifest(v.manifest)
  return m.ok ? { ok: true, value: { manifest: m.value } } : m
}

export interface ValidCompileRequest {
  manifest: Manifest
  mainFile: string
  engine: Engine
  clean: boolean
  timeoutMs: number
}

/**
 * One path segment of a main file. latexmk builds `pdflatex %O "%S"` as ONE string and runs it through
 * /bin/sh, where `$(...)`, backticks and `$VAR` still expand inside double quotes; TeX in turn treats
 * `%` as a comment and a leading `&` as a format name on its command line. So the main file's name is
 * whitelisted (letters and digits in any script, space, `_ . + , = @ -`), each segment starting with a
 * letter, digit or `_` (so never `-`, `.` or a space). Other files of the project are never put on a
 * command line and only need isValidRelPath.
 */
const MAIN_SEGMENT = /^[\p{L}\p{N}_][\p{L}\p{N}_ .+,=@-]*$/u

/**
 * Why the requested main file cannot be built, in words for the user; null if it can.
 * These are the user's (or the app's fallback "main.tex") mistakes, not malformed requests,
 * so the worker answers them with a normal `failure` result instead of HTTP 400.
 */
export function mainFileProblem(mainFile: string, manifest: Manifest): string | null {
  if (!Object.hasOwn(manifest, mainFile)) {
    return `The main file "${mainFile}" does not exist in this project. Choose an existing .tex file as the main file.`
  }
  if (!/\.tex$/i.test(mainFile)) return `The main file "${mainFile}" is not a .tex file. Choose a .tex file as the main file.`
  if (!mainFile.split('/').every(s => MAIN_SEGMENT.test(s))) {
    return `The main file "${mainFile}" cannot be compiled because of its name. Main file and folder names may only ` +
      'contain letters, digits, spaces and _ . + , = @ - and must start with a letter, digit or _. Rename it and compile again.'
  }
  return null
}

/** A well-formed compile request whose main file cannot be built (see mainFileProblem). */
export interface UnbuildableMainFile { manifest: Manifest; problem: string }

export type CompileParse =
  | { ok: true; value: ValidCompileRequest }
  | { ok: false; error: string }
  | { ok: 'unbuildable'; value: UnbuildableMainFile }

export function parseCompileRequest(v: unknown, maxTimeoutMs: number): CompileParse {
  if (!isPlainObject(v)) return fail('body must be an object')
  const bad = checkKeys(v, ['manifest', 'mainFile', 'engine', 'clean', 'timeoutMs'])
  if (bad) return fail(bad)
  const m = parseManifest(v.manifest)
  if (!m.ok) return m
  const { mainFile, engine, clean, timeoutMs } = v
  if (typeof mainFile !== 'string' || !isValidRelPath(mainFile)) return fail('invalid mainFile')
  if (!isEngine(engine)) return fail('invalid engine')
  if (clean !== undefined && typeof clean !== 'boolean') return fail('clean must be a boolean')
  if (timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > maxTimeoutMs)) {
    return fail(`timeoutMs must be an integer in [${MIN_TIMEOUT_MS}, ${maxTimeoutMs}]`)
  }
  // Checked last, so a request that is malformed in any other way is still a 400.
  const problem = mainFileProblem(mainFile, m.value)
  if (problem !== null) return { ok: 'unbuildable', value: { manifest: m.value, problem } }
  return {
    ok: true,
    value: { manifest: m.value, mainFile, engine, clean: clean ?? false, timeoutMs: timeoutMs ?? Math.min(DEFAULT_TIMEOUT_MS, maxTimeoutMs) },
  }
}
