import type { Diagnostic } from '@ligature/shared'
import { parseLatexLog } from '@ligature/latex-log-parser'
import { findLogSrcRoot, PathMap } from './buildPaths.ts'

export interface DiagnosticsInput {
  /** The build log as returned by the worker. */
  log: string
  /** The build's path map: project-relative path -> file id. */
  paths: Record<string, string>
  /** The project id: locates the build's `src/` dir (`.../<projectId>/src/`) in absolute paths of the log. */
  projectId?: string
  /** The build's `src/` dir as it appears in the log, when the worker reports it. */
  rootDir?: string
}

/** At most this many diagnostics per build (docs/M2.md §2), errors first. */
export const MAX_DIAGNOSTICS = 500

/**
 * Diagnostics of one build: parsed from its log (`@ligature/latex-log-parser`) and mapped to project files
 * via the build's path map. Paths that are not files of the build keep `path` but get no `fileId`.
 * Never throws: a parser failure yields no diagnostics rather than a failed build.
 */
export function computeDiagnostics(input: DiagnosticsInput): Diagnostic[] {
  const map = new PathMap(input.paths)
  try {
    const rootDir = input.rootDir ?? findLogSrcRoot(input.log, input.projectId, map)
    const parsed = parseLatexLog(input.log, rootDir === undefined ? {} : { rootDir })
    const out: Diagnostic[] = []
    for (const p of parsed) {
      if (out.length >= MAX_DIAGNOSTICS) break
      const d: Diagnostic = { severity: p.severity, kind: p.kind, message: p.message }
      if (p.path !== undefined) {
        const fileId = map.fileId(p.path)
        if (fileId !== undefined) d.fileId = fileId
        d.path = fileId !== undefined ? map.pathOf(fileId) ?? p.path : p.path
      }
      if (p.line !== undefined) d.line = p.line
      if (p.endLine !== undefined) d.endLine = p.endLine
      out.push(d)
    }
    return out
  } catch (e) {
    console.error('log parser failed', e)
    return []
  }
}

/** Server-made diagnostics first, then parsed ones; capped, errors before warnings before info. */
export function mergeDiagnostics(extra: Diagnostic[], parsed: Diagnostic[]): Diagnostic[] {
  const rank = { error: 0, warning: 1, info: 2 } as const
  return [...extra, ...parsed]
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank[a.d.severity] - rank[b.d.severity] || a.i - b.i)
    .slice(0, MAX_DIAGNOSTICS)
    .map(x => x.d)
}
