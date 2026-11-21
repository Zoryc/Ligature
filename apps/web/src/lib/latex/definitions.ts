/**
 * Go to definition (docs/GO-TO-DEFINITION.md): what is under the pointer (`targetAt`), which clicks jump
 * (`jumpModifier`, `caretAt`) and where it is defined (`findDefinition`). Pure; Editor.svelte asks for targets
 * while Ctrl/Cmd is held, Project.svelte resolves them
 * with the project index and the files' current texts.
 */

import { normalize, resolveInput } from '../outline.ts'
import { CITE_COMMANDS, GRAPHICS_COMMANDS, INPUT_COMMANDS, REF_COMMANDS } from './completionData.ts'
import type { BibEntry, LabelEntry, UserDefinition } from './completionTypes.ts'
import { commentStart } from './latexCompletion.ts'
import { indexBib, indexTex } from './projectIndex.ts'

export type TargetKind = 'ref' | 'cite' | 'input' | 'graphics' | 'command' | 'environment'

export interface Target {
  kind: TargetKind
  /** The label, bibliography key, path as written, or command / environment name (without backslash). */
  name: string
  /** What is underlined: offsets in the text given to `targetAt`. */
  from: number
  to: number
}

/** Whether the project defines a command or environment (only those are targets; built-ins are not). */
export type IsDefined = (kind: 'command' | 'environment', name: string) => boolean

// ---------- what is under the pointer ----------

type ArgKind = 'ref' | 'cite' | 'input' | 'graphics' | 'environment'

const ARG_KIND = new Map<string, ArgKind>([
  ...REF_COMMANDS.map(c => [c, 'ref'] as const),
  ...CITE_COMMANDS.map(c => [c, 'cite'] as const),
  ...INPUT_COMMANDS.map(c => [c, 'input'] as const),
  ...GRAPHICS_COMMANDS.map(c => [c, 'graphics'] as const),
  ['begin', 'environment'],
  ['end', 'environment'],
])

/** Comma-separated lists: each item is its own target (`\cite{a,b}`, `\cref{a,b}`). */
const LIST_KINDS = new Set<ArgKind>(['ref', 'cite'])

/** `[...]` arguments skipped before the braces (biblatex's `\parencite[see][12]{key}` has two). */
export const MAX_OPTIONALS = 3

/**
 * Lines longer than this are looked at only around the pointer: targetAt runs on every mouse move while the
 * modifier is held, and a minified line must not make that slow.
 */
const MAX_LINE = 10000
const WINDOW = 2000

export interface Token { name: string; from: number; to: number }

/** Control words of `code` in order. `\\` and `\%` are skipped whole, so `\\label` is not a \label. */
export function commands(code: string): Token[] {
  const out: Token[] = []
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '\\') continue
    let j = i + 1
    while (j < code.length && /[A-Za-z@]/.test(code[j] ?? '')) j++
    if (j > i + 1) {
      out.push({ name: code.slice(i + 1, j), from: i, to: j })
      i = j - 1
    } else i++
  }
  return out
}

export function skipSpace(code: string, i: number): number {
  while (code[i] === ' ' || code[i] === '\t') i++
  return i
}

/** Index of the delimiter closing the group opened at `i`, or -1 when it does not close on this line. */
export function closing(code: string, i: number, open: string, close: string): number {
  let depth = 0
  for (let j = i; j < code.length; j++) {
    const c = code[j]
    if (c === '\\') j++
    else if (c === open) depth++
    else if (c === close && --depth === 0) return j
  }
  return -1
}

/** The argument item of command `tok` under `col`, if `tok` is one whose argument we follow. */
function argumentAt(code: string, tok: Token, col: number, isDefined?: IsDefined): Target | null {
  const kind = ARG_KIND.get(tok.name)
  if (!kind) return null
  let i = tok.to
  if (code[i] === '*') i++
  i = skipSpace(code, i)
  for (let n = 0; code[i] === '[' && n < MAX_OPTIONALS; n++) {
    const end = closing(code, i, '[', ']')
    if (end === -1) return null
    i = skipSpace(code, end + 1)
  }
  if (code[i] !== '{') return null
  const close = closing(code, i, '{', '}')
  const end = close === -1 ? code.length : close // still being typed: up to the line's end
  if (col <= i || col > end) return null
  const content = code.slice(i + 1, end)
  const items = LIST_KINDS.has(kind) ? content.split(',') : [content]
  let at = i + 1
  for (const item of items) {
    const name = item.trim()
    const from = at + item.length - item.trimStart().length
    const to = from + name.length
    at += item.length + 1
    if (!name || col < from || col > to) continue
    if (/[\\{}]/.test(name)) return null // a macro inside (\input{\dir/x}): the macro may be the target
    if (kind === 'cite' && name === '*') return null // \nocite{*}: "every entry", not a key
    if (kind === 'environment' && isDefined && !isDefined('environment', name)) return null
    return { kind, name, from, to }
  }
  return null
}

function targetInLine(line: string, col: number, isDefined?: IsDefined): Target | null {
  const cut = commentStart(line)
  if (cut !== -1 && col > cut) return null
  const code = cut === -1 ? line : line.slice(0, cut)
  for (const tok of commands(code)) {
    if (col >= tok.from && col <= tok.to) {
      if (!isDefined || isDefined('command', tok.name)) return { kind: 'command', name: tok.name, from: tok.from, to: tok.to }
      continue // a built-in command (\section): not a target, but `\ref{` ends where its argument starts
    }
    const arg = argumentAt(code, tok, col, isDefined)
    if (arg) return arg
  }
  return null
}

/**
 * The go-to-definition target at `pos` in `text` (only `pos`'s line is read: arguments do not span lines here),
 * or null. With `isDefined`, commands and environments the project does not define are not targets.
 */
export function targetAt(text: string, pos: number, isDefined?: IsDefined): Target | null {
  if (pos < 0 || pos > text.length) return null
  let start = pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1
  const nl = text.indexOf('\n', pos)
  let end = nl === -1 ? text.length : nl
  if (end - start > MAX_LINE) {
    start = Math.max(start, pos - WINDOW)
    end = Math.min(end, pos + WINDOW)
  }
  const t = targetInLine(text.slice(start, end), pos - start, isDefined)
  return t && { ...t, from: t.from + start, to: t.to + start }
}

// ---------- the click ----------

/** The modifier keys of a mouse or keyboard event (both have them all). */
export interface ModifierKeys {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  getModifierState?(key: string): boolean
}

/**
 * Whether these keys make a click jump: Cmd on macOS, else Ctrl, and neither Alt nor Shift (those clicks stay
 * CodeMirror's). The hint uses the same test, so the underline shows exactly when a click would jump. Windows
 * reports AltGr (how German, French or Polish layouts type \ { } [ ]) as Ctrl+Alt: it must not show the hint.
 */
export function jumpModifier(e: ModifierKeys, mac: boolean): boolean {
  return (mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && !(e.getModifierState?.('AltGraph') ?? false)
}

/**
 * The caret goes to the clicked target before the jump, as in Visual Studio, so Back returns to where the click
 * was, not to an older caret the writer has scrolled away from. A selection only: fine for read-only viewers.
 */
export function caretAt(t: Pick<Target, 'from'>): { selection: { anchor: number } } {
  return { selection: { anchor: t.from } }
}

// ---------- where it is defined ----------

export interface DefinitionSources {
  /** The project's files (not folders): the main file first, then in the project's order. */
  files: readonly { id: string; path: string; text: boolean }[]
  /** A file's current text: the live editor text for the open file (null: not loaded or not a source file). */
  text: (fileId: string) => string | null
  index: {
    labels(): readonly LabelEntry[]
    bibEntries(): readonly BibEntry[]
    definitions(): readonly UserDefinition[]
  }
  /** The main file's folder ("" = root): \input and \includegraphics paths are relative to it. */
  mainDir: string
}

export type Definition =
  /** A line of a text file; `count` > 1 when the name is defined more than once (this is the first). */
  | { fileId: string; line: number; count: number }
  /** An image: show its preview. */
  | { fileId: string; preview: true }
  /** Not found: what to tell the user. */
  | { reason: string }

const TEX_FILE = /\.(tex|ltx|sty|cls)$/i
const BIB_FILE = /\.bib$/i
/** Tried in this order after the path as written, like graphicx. */
const IMAGE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg']

interface Place { fileId: string; line: number }

/**
 * Every place a name is defined, in file order (main file first). Each file's current text is searched;
 * a file without one (not loaded yet) contributes its indexed places. When the current texts have none (an
 * edit the index has not caught up with), the indexed places are the fallback.
 */
function places(
  src: DefinitionSources, isSource: RegExp, scan: (text: string, fileId: string) => number[], indexed: readonly Place[],
): Place[] {
  const order = new Map(src.files.map((f, i) => [f.id, i]))
  const byFile = new Map<string, Place[]>()
  for (const p of indexed) {
    const list = byFile.get(p.fileId)
    if (list) list.push(p)
    else byFile.set(p.fileId, [p])
  }
  const out: Place[] = []
  for (const f of src.files) {
    if (!f.text || !isSource.test(f.path)) continue
    const text = src.text(f.id)
    if (text === null) out.push(...(byFile.get(f.id) ?? []).toSorted((a, b) => a.line - b.line))
    else for (const line of scan(text, f.id)) out.push({ fileId: f.id, line })
  }
  if (out.length) return out
  return indexed.filter(p => order.has(p.fileId))
    .toSorted((a, b) => (order.get(a.fileId) ?? 0) - (order.get(b.fileId) ?? 0) || a.line - b.line)
}

function first(found: Place[], reason: string): Definition {
  const [p] = found
  return p ? { fileId: p.fileId, line: p.line, count: found.length } : { reason }
}

/** BibTeX has no comment syntax, but biber and most tools skip lines starting with %: so do we. */
function blankCommentLines(text: string): string {
  return text.replace(/^[ \t]*%.*$/gm, '')
}

/** The project's file at `path` relative to the main file's folder, trying `suffixes` in order. */
function resolveWith(path: string, mainDir: string, ids: ReadonlyMap<string, string>, suffixes: readonly string[]): string | null {
  const clean = path.replace(/^\.\//, '').replace(/"/g, '')
  const base = mainDir && !clean.startsWith('/') ? `${mainDir}/${clean}` : clean.replace(/^\//, '')
  for (const s of suffixes) {
    const id = ids.get(normalize(`${base}${s}`))
    if (id) return id
  }
  return null
}

/** The path as the user wrote it, with `.tex` added when it has no extension (that is what TeX reads). */
function texPath(path: string): string {
  return /\.[A-Za-z0-9]+$/.test(path.split('/').pop() ?? '') ? path : `${path}.tex`
}

/** Where `target` is defined in the project, or why it cannot be found. */
export function findDefinition(target: Target, src: DefinitionSources): Definition {
  const { name } = target
  switch (target.kind) {
    case 'ref': {
      const scan = (text: string, fileId: string) =>
        text.includes(name) ? indexTex(text, fileId).labels.filter(l => l.name === name).map(l => l.line) : []
      return first(places(src, TEX_FILE, scan, src.index.labels().filter(l => l.name === name)), `No \\label{${name}} in this project.`)
    }
    case 'cite': {
      const scan = (text: string, fileId: string) =>
        text.includes(name) ? indexBib(blankCommentLines(text), fileId).filter(e => e.key === name).map(e => e.line) : []
      return first(places(src, BIB_FILE, scan, src.index.bibEntries().filter(e => e.key === name)), `No entry ${name} in the project's .bib files.`)
    }
    case 'command':
    case 'environment': {
      const kind = target.kind
      const scan = (text: string, fileId: string) => text.includes(name)
        ? indexTex(text, fileId).definitions.filter(d => d.kind === kind && d.name === name).map(d => d.line)
        : []
      const indexed = src.index.definitions().filter(d => d.kind === kind && d.name === name)
      const shown = kind === 'command' ? `\\${name}` : `The ${name} environment`
      return first(places(src, TEX_FILE, scan, indexed), `${shown} is defined by LaTeX or a package, not in this project.`)
    }
    case 'input': {
      const texts = new Map(src.files.filter(f => f.text).map(f => [f.path, { id: f.id }]))
      const id = resolveInput(name, src.mainDir, texts)
      return id ? { fileId: id, line: 1, count: 1 } : { reason: `${texPath(name)} is not in this project.` }
    }
    case 'graphics': {
      const ids = new Map(src.files.map(f => [f.path, f.id]))
      const id = resolveWith(name, src.mainDir, ids, ['', ...IMAGE_EXTENSIONS])
      return id ? { fileId: id, preview: true } : { reason: `${name} is not in this project.` }
    }
  }
}
