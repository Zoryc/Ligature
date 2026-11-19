import type { Engine } from '@ligature/shared'

/** How the TeX engines are written for people (also in the audit log, so it lives outside the settings panel). */
export const ENGINE_LABELS: Record<Engine, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' }

export function engineLabel(e: string): string {
  return (ENGINE_LABELS as Record<string, string>)[e] ?? e
}
