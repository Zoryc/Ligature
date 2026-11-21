/**
 * Personal editor preferences ("Only for you" in Settings): saved in this browser, for every project.
 * Auto-compile is personal too but per project (autoCompile.ts).
 */

export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20] as const

export interface Prefs {
  fontSize: number
  wrap: boolean
  /** The Problems panel under the editor is folded to its header. */
  problemsCollapsed: boolean
  /** Sidebar tab. */
  sidebar: 'contents' | 'files' | 'search'
}

const KEY = 'ligature.prefs'
const DEFAULTS: Prefs = { fontSize: 14, wrap: true, problemsCollapsed: false, sidebar: 'files' }

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Read stored preferences, keeping only valid values. */
export function parsePrefs(raw: string | null): Prefs {
  const out = { ...DEFAULTS }
  if (!raw) return out
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return out
  }
  if (!v || typeof v !== 'object') return out
  const o = v as Record<string, unknown>
  if (typeof o['fontSize'] === 'number' && (FONT_SIZES as readonly number[]).includes(o['fontSize'])) out.fontSize = o['fontSize']
  if (typeof o['wrap'] === 'boolean') out.wrap = o['wrap']
  if (typeof o['problemsCollapsed'] === 'boolean') out.problemsCollapsed = o['problemsCollapsed']
  if (o['sidebar'] === 'contents' || o['sidebar'] === 'files' || o['sidebar'] === 'search') out.sidebar = o['sidebar']
  return out
}

export const prefs: Prefs = $state(parsePrefs(storage()?.getItem(KEY) ?? null))

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  prefs[key] = value
  try {
    storage()?.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // private mode / quota: keep it for this page only
  }
}
