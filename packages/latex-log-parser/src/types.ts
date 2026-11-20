/** Public types of the log parser. Mirrors `Diagnostic` in packages/shared/src/api.ts, with `path` instead of `fileId`. */

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface ParsedDiagnostic {
  severity: DiagnosticSeverity
  /**
   * 'tex' (TeX primitive errors, emergency stop, no output), 'latex', 'package:<name>', 'class:<name>', 'font',
   * 'badbox', 'undefined-reference', 'undefined-citation', 'missing-file', 'bibtex', 'biber', 'lua' (LuaTeX Lua errors), 'compiler'
   */
  kind: string
  message: string
  /** Project-relative path ('chapters/intro.tex'), when the problem can be attributed to a project file. */
  path?: string
  /** 1-based line in `path`. */
  line?: number
  /** For bad boxes: last line of the range ("at lines 12--15"). */
  endLine?: number
  /** The log lines the diagnostic was read from (trimmed, at most RAW_MAX_CHARS characters). */
  raw?: string
}

export interface ParseOptions {
  /**
   * Absolute path of the build's source directory as it appears in the log (the compiler runs latexmk there).
   * Absolute paths inside it become project-relative; every other absolute path (TeX Live, the build's out dir)
   * is not a project file.
   */
  rootDir?: string
}

export const MAX_DIAGNOSTICS = 500
export const RAW_MAX_CHARS = 1000
