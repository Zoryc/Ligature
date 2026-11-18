/** Zip import helpers (docs/M2.md §5): the default project name and the report shown after an import. */
import type { ImportReport } from '@ligature/shared'

/** Server limit for an imported archive. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024

const MAX_NAME = 120

/** "My Thesis.zip" -> "My Thesis"; falls back to "Imported project". */
export function defaultProjectName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.zip$/i, '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (base || 'Imported project').slice(0, MAX_NAME).trim()
}

export interface ReportView {
  summary: string
  /** "path (reason)" per skipped entry, at most `max`; `more` = how many were left out. */
  skipped: string[]
  more: number
}

export function reportView(name: string, report: ImportReport, max = 20): ReportView {
  const main = report.detectedMainFile ? ` Main file: ${report.detectedMainFile}.` : ' No main file was found; choose one in Settings.'
  const n = report.skipped.length
  const skippedText = n === 0 ? ' Nothing was skipped.' : ` ${n} entr${n === 1 ? 'y was' : 'ies were'} skipped:`
  return {
    summary: `Imported "${name}".${main}${skippedText}`,
    skipped: report.skipped.slice(0, max).map(s => `${s.path} (${s.reason})`),
    more: Math.max(0, n - max),
  }
}

/** Reports of imports made in this tab, waiting to be shown when their project opens. */
const pending = new Map<string, ImportReport>()

export function rememberImportReport(projectId: string, report: ImportReport): void {
  pending.set(projectId, report)
}

/** The report for `projectId` (once). */
export function takeImportReport(projectId: string): ImportReport | null {
  const r = pending.get(projectId) ?? null
  pending.delete(projectId)
  return r
}
