import type { Diagnostic } from '@ligature/shared'

/** Very small log reader: picks out `-file-line-error` lines ("./main.tex:12: Undefined control sequence."). */

export interface LogLine {
  text: string
  /** Set when the line is a file:line: error. */
  error?: { file: string; line: number; message: string }
}

const FILE_LINE_ERROR = /^(.*?):(\d+): (.*)$/

export function normalizeLogPath(file: string): string {
  return file.replace(/^\.\//, '').replace(/\\/g, '/')
}

export function parseLog(log: string): LogLine[] {
  return log.split(/\r?\n/).map(text => {
    const m = FILE_LINE_ERROR.exec(text)
    if (!m) return { text }
    const line = Number(m[2])
    if (!Number.isSafeInteger(line) || line < 1) return { text }
    return { text, error: { file: normalizeLogPath(m[1]!), line, message: m[3]! } }
  })
}

/** What the log panel shows for one build. */
export interface LogInfo {
  status: string
  durationMs: number | null
  log: string
  /** Problems parsed by the server (empty when unknown). */
  diagnostics: Diagnostic[]
  /** e.g. "your compile" or "compiled by Alice" */
  source?: string
}
