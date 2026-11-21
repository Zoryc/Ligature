/**
 * LaTeX autocomplete for CodeMirror (docs/AUTOCOMPLETE.md). The pure helpers (where the cursor is, math or
 * not, the snippet text, path suggestions) are unit-tested without an editor; `latexCompletion()` turns them
 * into a CompletionSource that reads the built-in lists and the project index.
 *
 * Speed: per keystroke CodeMirror re-filters the option list it already has (`validFor`), so the work is linear
 * in the candidates. Option arrays are built once (built-ins) or once per index version (the project's labels,
 * keys and commands), never per keystroke.
 */

import { insertCompletionText, pickedCompletion, snippet } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { normalize, stripComments } from '../outline.ts'
import * as builtin from './completionData.ts'
import type { ArgSpec, BibEntry, CommandInfo, EnvironmentInfo, UserDefinition } from './completionTypes.ts'
import { escapedAt, type ProjectIndex } from './projectIndex.ts'

// ---------- where the cursor is ----------

export type ArgKind = 'begin' | 'end' | 'ref' | 'cite' | 'input' | 'graphics' | 'package' | 'class'

export type LatexContext =
  /** After `\` and letters; `from` is the backslash. */
  | { kind: 'command'; from: number; prefix: string }
  /**
   * Inside the braces of a command we complete: `from` is where the current item starts (after the last comma
   * for lists), `cmdFrom` the command's backslash, `done` the list's earlier items.
   */
  | { kind: ArgKind; command: string; cmdFrom: number; from: number; prefix: string; done: string[] }

/** Command names (without backslash) whose argument we complete. */
export interface CommandSets {
  ref: ReadonlySet<string>
  cite: ReadonlySet<string>
  input: ReadonlySet<string>
  graphics: ReadonlySet<string>
  package: ReadonlySet<string>
}

/** Commands whose argument is a comma-separated list: the current item is after the last comma. */
const LISTS = new Set<ArgKind>(['ref', 'cite', 'package'])

/** Offset of the comment start (`%` not escaped) in a line, or -1. */
export function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '%') return i
  }
  return -1
}

/** Index of the `{` still open at the end of `line`, or -1. */
function openBrace(line: string): number {
  let depth = 0
  for (let i = line.length - 1; i >= 0; i--) {
    const c = line[i]
    if ((c !== '{' && c !== '}') || escapedAt(line, i)) continue
    if (c === '}') depth++
    else if (depth === 0) return i
    else depth--
  }
  return -1
}

/** Skip `[...]` groups, a star and spaces backwards from `j`; the index of the command name's last letter. */
function skipBackOverOptionals(line: string, j: number): number {
  for (;;) {
    while (j >= 0 && (line[j] === ' ' || line[j] === '\t')) j--
    if (line[j] !== ']') break
    let depth = 0
    for (; j >= 0; j--) {
      if (line[j] === ']') depth++
      else if (line[j] === '[' && --depth === 0) break
    }
    j--
  }
  if (line[j] === '*') j--
  return j
}

function argKind(name: string, sets: CommandSets): ArgKind | null {
  if (name === 'begin' || name === 'end') return name
  if (name === 'documentclass') return 'class'
  if (sets.ref.has(name)) return 'ref'
  if (sets.cite.has(name)) return 'cite'
  if (sets.input.has(name)) return 'input'
  if (sets.graphics.has(name)) return 'graphics'
  if (sets.package.has(name)) return 'package'
  return null
}

/**
 * What to suggest for `line`, the current line up to the cursor (offsets are within the line). Null when
 * nothing applies, including inside a comment.
 */
export function detectContext(line: string, sets: CommandSets): LatexContext | null {
  if (commentStart(line) !== -1) return null
  const cmd = /\\([A-Za-z@]*)$/.exec(line)
  if (cmd && !escapedAt(line, cmd.index)) return { kind: 'command', from: cmd.index, prefix: cmd[1] ?? '' }

  const open = openBrace(line)
  if (open === -1) return null
  const content = line.slice(open + 1)
  if (/[{}\\]/.test(content)) return null
  const end = skipBackOverOptionals(line, open - 1)
  const name = /\\([A-Za-z]+)$/.exec(line.slice(0, end + 1))
  if (!name?.[1] || escapedAt(line, name.index)) return null
  const kind = argKind(name[1], sets)
  if (!kind) return null

  const base = { command: name[1], cmdFrom: name.index }
  if (!LISTS.has(kind)) return { kind, ...base, from: open + 1, prefix: content, done: [] }
  const comma = content.lastIndexOf(',')
  const item = content.slice(comma + 1)
  const lead = item.length - item.trimStart().length
  const done = comma === -1 ? [] : content.slice(0, comma).split(',').map(s => s.trim()).filter(Boolean)
  return { kind, ...base, from: open + 1 + comma + 1 + lead, prefix: item.slice(lead), done }
}

// ---------- math mode ----------

/** Commands whose argument is text again inside math. */
const TEXT_IN_MATH = new Set(['text', 'textrm', 'textit', 'textbf', 'textsf', 'texttt', 'mbox', 'intertext', 'shortintertext', 'operatorname'])

interface Mode { math: boolean; by: string }

/**
 * Whether the end of `before` (text up to the cursor) is in math mode: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, the
 * display environments, minus `\text{…}` inside them. Scans from the last blank line (math cannot span
 * paragraphs), so it is local and cheap.
 */
export function inMath(before: string, displayEnvs: ReadonlySet<string>): boolean {
  const blank = lastBlankLine(before)
  const text = stripComments(blank === -1 ? before : before.slice(blank))
  const modes: Mode[] = [{ math: false, by: '' }]
  const braces: boolean[] = [] // per open brace: did it start a \text{...}?
  const top = () => modes[modes.length - 1] ?? { math: false, by: '' }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(text.slice(i, i + 40))
      const name = m?.[1] ?? ''
      if (name === '(' || name === '[') modes.push({ math: true, by: name })
      else if ((name === ')' && top().by === '(') || (name === ']' && top().by === '[')) modes.pop()
      else if (name === 'begin' || name === 'end') {
        const env = /^\s*\{([^{}]*)\}/.exec(text.slice(i + 1 + name.length, i + 80))
        if (env?.[1] !== undefined && displayEnvs.has(env[1].trim())) {
          if (name === 'begin') modes.push({ math: true, by: `env:${env[1].trim()}` })
          else if (top().by === `env:${env[1].trim()}`) modes.pop()
        }
      } else if (TEXT_IN_MATH.has(name) && top().math) {
        const after = /^\s*\{/.exec(text.slice(i + 1 + name.length))
        if (after) {
          modes.push({ math: false, by: '{' })
          braces.push(true)
          i += name.length + after[0].length
          continue
        }
      }
      i += Math.max(0, (m?.[0].length ?? 1) - 1)
    } else if (c === '$') {
      const by = text[i + 1] === '$' ? '$$' : '$'
      if (top().by === by) modes.pop()
      else modes.push({ math: true, by })
      if (by === '$$') i++
    } else if (c === '{') braces.push(false)
    else if (c === '}' && braces.pop() && top().by === '{') modes.pop()
  }
  return top().math
}

function lastBlankLine(text: string): number {
  const re = /\n[ \t]*\n/g
  let last = -1
  for (let m = re.exec(text); m; m = re.exec(text)) last = m.index
  return last
}

/** Deeper nesting drops the outermost environment: real documents nest a handful, and it bounds the work per \end. */
const MAX_DEPTH = 100

/** `\begin` and `\end` of `text` in order (comments ignored). */
function* environmentMarks(text: string): Generator<{ begin: boolean; name: string }> {
  const clean = stripComments(text)
  const re = /\\(begin|end)\s*\{([^{}]*)\}/g
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    if (!escapedAt(clean, m.index)) yield { begin: m[1] === 'begin', name: (m[2] ?? '').trim() }
  }
}

/** Environments open at the end of `before`, outermost first (comments ignored). */
export function openEnvironments(before: string): string[] {
  const stack: string[] = []
  for (const m of environmentMarks(before)) {
    if (m.begin) {
      if (stack.push(m.name) > MAX_DEPTH) stack.shift()
    } else {
      const k = stack.lastIndexOf(m.name)
      if (k !== -1) stack.length = k
    }
  }
  return stack
}

/**
 * The `\end`s in `after` that close environments opened before it (innermost first): the mirror of
 * openEnvironments. Stops once it has `limit` of them.
 */
export function closingEnvironments(after: string, limit = Infinity): string[] {
  const stack: string[] = []
  const out: string[] = []
  for (const m of environmentMarks(after)) {
    if (m.begin) {
      if (stack.push(m.name) > MAX_DEPTH) stack.shift()
      continue
    }
    const k = stack.lastIndexOf(m.name)
    if (k !== -1) stack.length = k
    else if (out.push(m.name) >= limit) break
  }
  return out
}

/**
 * Whether the `\begin` at the end of `before` already has its `\end` in `after`: then the user is renaming an
 * existing environment, and inserting a whole new one would leave the old `\end` orphaned. The `\end`s below
 * that close earlier environments mirror the ones open above: one more than those, or a first one that closes
 * nothing open above, belongs to this `\begin`. (An environment above that is not closed yet, because the user
 * is still writing it, only makes the list shorter: still a new `\begin`.)
 */
export function beginHasEnd(before: string, after: string): boolean {
  const open = openEnvironments(before)
  const closing = closingEnvironments(after, open.length + 1)
  const first = closing[0]
  if (first === undefined) return false
  return closing.length > open.length || !open.includes(first)
}

// ---------- snippet text ----------

/** Literal text inside a snippet template: `\{` and `\}` would otherwise lose their backslash. */
function lit(text: string): string {
  return text.replace(/\\(?=[{}])/g, '\\\\')
}

/** A placeholder name safe inside `${n:name}`. */
function field(n: number, name: string): string {
  return `\${${n}:${name.replace(/[{}]/g, '')}}`
}

function required(args: readonly ArgSpec[]): ArgSpec[] {
  return args.filter(a => a.kind === 'required')
}

/**
 * Snippet template of a command with placeholders for its required arguments, ending after the last one;
 * null when it has none (then plain `\name` is inserted).
 */
export function commandTemplate(name: string, args: readonly ArgSpec[]): string | null {
  const req = required(args)
  if (!req.length) return null
  return `${lit(`\\${name}`)}${req.map((a, i) => `{${field(i + 1, a.name)}}`).join('')}\${0}`
}

/** Snippet template of a whole environment: `\begin{name}` + required args, the body line, `\end{name}`. */
export function environmentTemplate(name: string, args: readonly ArgSpec[], body = ''): string {
  const req = required(args)
  const head = `${lit(`\\begin{${name}}`)}${req.map((a, i) => `{${field(i + 1, a.name)}}`).join('')}`
  return `${head}\n\t${lit(body)}\${${req.length + 1}}\n${lit(`\\end{${name}}`)}\${0}`
}

/** Argument specs for a user definition: its required arguments get numbered placeholders. */
export function userArgs(d: UserDefinition): ArgSpec[] {
  const n = Math.max(0, d.argCount - (d.optionalDefault ? 1 : 0))
  return Array.from({ length: n }, (_, i) => ({ kind: 'required' as const, name: `arg${i + 1}` }))
}

// ---------- paths ----------

/** `target` (from the project root) relative to the folder `dir` ("" = root). */
export function relativePath(target: string, dir: string): string {
  const a = dir ? normalize(dir).split('/') : []
  const b = normalize(target).split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

const IMAGE = /\.(png|jpe?g|pdf|eps|svg)$/i

/** Suggestions for \input-like (`.tex` without extension) or \includegraphics (images) arguments. */
export function pathSuggestions(paths: readonly string[], mainDir: string, kind: 'input' | 'graphics', mainPath = ''): string[] {
  const out: string[] = []
  for (const p of paths) {
    if (kind === 'input' && /\.tex$/i.test(p) && p !== mainPath) out.push(relativePath(p, mainDir).replace(/\.tex$/i, ''))
    else if (kind === 'graphics' && IMAGE.test(p)) out.push(relativePath(p, mainDir))
  }
  return out.sort()
}

/** "Knuth", "Knuth and Lamport", "Knuth et al." from a BibTeX author list. */
export function shortAuthor(author: string): string {
  const names = author.split(/\s+and\s+/i).map(n => n.trim()).filter(Boolean)
  const last = (n: string) => (n.includes(',') ? n.slice(0, n.indexOf(',')) : n.split(/\s+/).pop() ?? n).trim()
  if (names.length === 0) return ''
  if (names.length === 1) return last(names[0] ?? '')
  if (names.length === 2) return `${last(names[0] ?? '')} and ${last(names[1] ?? '')}`
  return `${last(names[0] ?? '')} et al.`
}

function bibDetail(e: BibEntry): string {
  const who = [e.author ? shortAuthor(e.author) : '', e.year ?? ''].filter(Boolean).join(' ')
  const title = e.title && e.title.length > 60 ? `${e.title.slice(0, 59)}…` : e.title ?? ''
  return [who, title].filter(Boolean).join(' · ')
}

// ---------- applying ----------

type Apply = (view: EditorView, completion: Completion, from: number, to: number) => void

/** End of the word continuing after `pos` (so accepting inside a word replaces all of it). */
function wordEnd(view: EditorView, pos: number, chars: RegExp): number {
  const line = view.state.doc.lineAt(pos)
  let end = pos
  while (end < line.to && chars.test(view.state.sliceDoc(end, end + 1))) end++
  return end
}

function insertText(view: EditorView, completion: Completion, text: string, from: number, to: number): void {
  view.dispatch({ ...insertCompletionText(view.state, text, from, to), annotations: pickedCompletion.of(completion) })
}

/** `\name`, with placeholders for its arguments unless they are already written after it. */
function applyCommand(name: string, template: string | null): Apply {
  return (view, completion, from, to) => {
    if (view.state.readOnly) return // read-only users see suggestions; nothing applies
    // Accepting inside `\sec|tion` replaces the whole name; after Ctrl+Space in plain text (no backslash at
    // `from`) the letters after the cursor are prose and stay.
    const end = view.state.sliceDoc(from, from + 1) === '\\' ? wordEnd(view, to, /[A-Za-z@]/) : to
    const next = view.state.sliceDoc(end, end + 1)
    if (!template || next === '{' || next === '[') insertText(view, completion, `\\${name}`, from, end)
    else snippet(template)(view, completion, from, end)
  }
}

/** An argument value; adds the closing brace when it is not there yet. */
function applyArg(value: string): Apply {
  return (view, completion, from, to) => {
    if (view.state.readOnly) return
    const end = wordEnd(view, to, /[^{},\s]/)
    const next = view.state.sliceDoc(end, end + 1)
    insertText(view, completion, next === '}' || next === ',' ? value : `${value}}`, from, end)
  }
}

/**
 * After `\begin{`: the whole environment for a new `\begin` with nothing after it on the line, else just the
 * name (text follows, the cursor is inside an existing name, or the `\begin` already has its `\end`: a rename).
 *
 * `offset` is the distance from `\begin` to the name. The start of `\begin` is worked out from `from` when
 * applying, never captured as a position: `from` is mapped through edits made while the popup is open
 * (a co-author typing above), a captured number is not.
 */
function applyEnvironment(name: string, template: string, offset: number): Apply {
  return (view, completion, from, to) => {
    const { state } = view
    if (state.readOnly) return
    const end = wordEnd(view, to, /[A-Za-z@*]/)
    const line = state.doc.lineAt(end)
    const rest = state.sliceDoc(end, line.to)
    const start = from - offset
    const fresh = end === to && start >= line.from && /^\}?\s*$/.test(rest) &&
      /^\\begin\s*\{$/.test(state.sliceDoc(start, from)) &&
      !beginHasEnd(state.sliceDoc(0, start), state.sliceDoc(line.to))
    if (!fresh) return applyArg(name)(view, completion, from, to)
    snippet(template)(view, completion, start, end + (rest.startsWith('}') ? 1 : 0))
  }
}

// ---------- the source ----------

export interface CompletionData {
  commands: readonly CommandInfo[]
  environments: readonly EnvironmentInfo[]
  packages: readonly string[]
  classes: readonly string[]
  /** Most used commands first: a ranking hint. */
  common: readonly string[]
  displayMath: readonly string[]
  refCommands: readonly string[]
  citeCommands: readonly string[]
  inputCommands: readonly string[]
  graphicsCommands: readonly string[]
  packageCommands: readonly string[]
}

export const BUILTIN: CompletionData = {
  commands: builtin.COMMANDS,
  environments: builtin.ENVIRONMENTS,
  packages: builtin.PACKAGES,
  classes: builtin.CLASSES,
  common: builtin.COMMON_COMMANDS,
  displayMath: builtin.DISPLAY_MATH_ENVIRONMENTS,
  refCommands: builtin.REF_COMMANDS,
  citeCommands: builtin.CITE_COMMANDS,
  inputCommands: builtin.INPUT_COMMANDS,
  graphicsCommands: builtin.GRAPHICS_COMMANDS,
  packageCommands: builtin.PACKAGE_COMMANDS,
}

export interface LatexCompletionOptions {
  /** The current project index (null: not ready; only built-in suggestions). */
  index: () => ProjectIndex | null
  /** The main file's folder from the project root ("" = root); \input and \includegraphics paths are relative to it. */
  mainDir: () => string
  /** The main file's path (left out of \input suggestions). */
  mainPath?: () => string
  data?: CompletionData
}

/** Ranking: CodeMirror adds `boost` (-99..99) to its match score, where a non-prefix match costs 700 or more. */
const MATH_FIRST = 40
/**
 * The largest penalty: CodeMirror scores an exact match 0 and a longer prefix match -100, so in text `\sec`
 * (secant, math only) would otherwise beat `\section`. With -99 a common text command sharing the prefix wins,
 * and the math command is still offered right below it.
 */
const MATH_OUTSIDE = -99
const OWN = 10

/** 0..30 for the most used commands, in order; 0 for the rest. */
function frequency(common: ReadonlyMap<string, number>, name: string): number {
  const rank = common.get(name)
  return rank === undefined ? 0 : Math.round(30 - (25 * rank) / Math.max(1, common.size))
}

function withDetail(detail: string | undefined, pkg: string | undefined): { detail?: string } {
  const d = [detail, pkg].filter(Boolean).join(' · ')
  return d ? { detail: d } : {}
}

/** The completion source for Editor.svelte's `autocompletion({ override: [...] })`. */
export function latexCompletion(opts: LatexCompletionOptions): CompletionSource {
  const data = opts.data ?? BUILTIN
  const strip = (names: readonly string[]) => new Set(names.map(n => n.replace(/^\\/, '')))
  const sets: CommandSets = {
    ref: strip(data.refCommands), cite: strip(data.citeCommands), input: strip(data.inputCommands),
    graphics: strip(data.graphicsCommands), package: strip(data.packageCommands),
  }
  const displayMath = new Set(data.displayMath)
  const common = new Map(data.common.map((n, i) => [n, i]))
  const builtinNames = new Set(data.commands.map(c => c.name))

  // Built-in options, built once per mode (math changes only the boosts).
  const commandOptions = memo((math: boolean) => data.commands.map((c): Completion => ({
    label: `\\${c.name}`,
    type: 'function',
    ...withDetail(c.detail, c.pkg),
    boost: frequency(common, c.name) + (c.math ? (math ? MATH_FIRST : MATH_OUTSIDE) : 0),
    apply: applyCommand(c.name, commandTemplate(c.name, c.args)),
  })))

  // Project-derived options: rebuilt when the index changes, never per keystroke.
  let projectVersion = -1
  let project: { commands: Completion[]; envs: UserDefinition[]; labels: Completion[]; keys: Completion[] } | null = null
  const fromProject = (index: ProjectIndex | null) => {
    if (!index) return { commands: [], envs: [], labels: [], keys: [] }
    if (project && projectVersion === index.version) return project
    const defs = index.definitions()
    const where = (fileId: string, line: number) => `${index.pathOf(fileId) ?? '?'}:${line}`
    project = {
      commands: defs.filter(d => d.kind === 'command').map(d => ({
        label: `\\${d.name}`,
        type: 'function',
        detail: `defined in ${where(d.fileId, d.line)}`,
        boost: OWN + frequency(common, d.name),
        apply: applyCommand(d.name, commandTemplate(d.name, userArgs(d))),
      })),
      envs: defs.filter(d => d.kind === 'environment'),
      labels: index.labels().map(l => ({
        label: l.name,
        type: 'constant',
        detail: [l.context, where(l.fileId, l.line)].filter(Boolean).join(' · '),
        apply: applyArg(l.name),
      })),
      keys: index.bibEntries().map(e => ({
        label: e.key,
        type: 'text',
        ...withDetail(bibDetail(e), undefined),
        ...(e.title ? { info: `${e.type}: ${e.title}` } : {}),
        apply: applyArg(e.key),
      })),
    }
    projectVersion = index.version
    return project
  }

  /** `offset`: from `\begin` to the name (see applyEnvironment). */
  const environmentOptions = (math: boolean, own: UserDefinition[], offset: number): Completion[] => {
    const ownNames = new Set(own.map(d => d.name))
    const list: { info: EnvironmentInfo; boost: number; detail?: string }[] = [
      ...own.map(d => ({ info: { name: d.name, args: userArgs(d) }, boost: OWN, detail: `defined in ${opts.index()?.pathOf(d.fileId) ?? '?'}:${d.line}` })),
      ...data.environments.filter(e => !ownNames.has(e.name)).map((e, i) => ({
        info: e,
        // Earlier entries of the built-in list are the more common ones.
        boost: Math.round(20 - (20 * i) / Math.max(1, data.environments.length)) + (e.math && math ? MATH_FIRST : 0),
      })),
    ]
    return list.map(({ info, boost, detail }) => ({
      label: info.name,
      type: 'class',
      ...withDetail(detail ?? info.detail, info.pkg),
      boost,
      apply: applyEnvironment(info.name, environmentTemplate(info.name, info.args, info.body), offset),
    }))
  }

  return (cx: CompletionContext): CompletionResult | null => {
    const line = cx.state.doc.lineAt(cx.pos)
    const ctx = detectContext(cx.state.sliceDoc(line.from, cx.pos), sets)
    const before = () => cx.state.sliceDoc(Math.max(0, cx.pos - 6000), cx.pos)
    const index = opts.index()

    if (!ctx || ctx.kind === 'command') {
      if (!ctx && (!cx.explicit || commentStart(cx.state.sliceDoc(line.from, cx.pos)) !== -1)) return null
      if (ctx && !ctx.prefix && !cx.explicit) return null // opens by itself after "\" plus one letter
      const math = inMath(before(), displayMath)
      const own = fromProject(index).commands
      const ownNames = new Set(own.map(o => o.label))
      const base = commandOptions(math)
      const result: CompletionResult = {
        from: ctx ? line.from + ctx.from : cx.pos,
        options: own.length ? [...own, ...base.filter(o => !ownNames.has(o.label))] : base,
        validFor: /^\\[A-Za-z@]*$/,
      }
      // Ctrl+Space in plain text is a one-off: typing anything but a command closes the popup. Without this,
      // CodeMirror would ask again "explicitly" after each keystroke, the list would follow the cursor through
      // the prose and Enter would insert a command instead of a new line.
      return ctx ? result : { ...result, update: (_r, _from, _to, next) => ({ from: next.pos, options: [] }) }
    }

    const from = line.from + ctx.from
    const word = { from, validFor: /^[^{},\s]*$/ }
    const done = new Set(ctx.done)
    const notDone = (o: Completion) => !done.has(o.label)
    switch (ctx.kind) {
      case 'begin': {
        const own = fromProject(index).envs
        return { from, options: environmentOptions(inMath(before(), displayMath), own, ctx.from - ctx.cmdFrom), validFor: /^[A-Za-z@*]*$/ }
      }
      case 'end': {
        // A longer window than for math: \begin{document} is usually far above.
        const open = openEnvironments(cx.state.sliceDoc(Math.max(0, cx.pos - 20000), cx.pos))
        const innermost = [...new Set(open.reverse())]
        const others = [...data.environments.map(e => e.name), ...fromProject(index).envs.map(d => d.name)]
          .filter(n => !innermost.includes(n))
        const options: Completion[] = [
          ...innermost.map((n, i) => ({ label: n, type: 'class', detail: i === 0 ? 'open here' : 'open', boost: 99 - i, apply: applyArg(n) })),
          ...[...new Set(others)].map(n => ({ label: n, type: 'class', apply: applyArg(n) })),
        ]
        return { from, options, validFor: /^[A-Za-z@*]*$/ }
      }
      case 'ref':
        return { ...word, options: fromProject(index).labels.filter(notDone) }
      case 'cite':
        return { ...word, options: fromProject(index).keys.filter(notDone) }
      case 'package':
        return { ...word, options: data.packages.filter(p => !done.has(p)).map(p => ({ label: p, type: 'namespace', apply: applyArg(p) })) }
      case 'class':
        return { ...word, options: data.classes.map(c => ({ label: c, type: 'namespace', apply: applyArg(c) })) }
      case 'input':
      case 'graphics': {
        const paths = pathSuggestions(index?.filePaths() ?? [], opts.mainDir(), ctx.kind, opts.mainPath?.() ?? '')
        return { from, options: paths.map(p => ({ label: p, type: 'text', apply: applyArg(p) })), validFor: /^[^{}]*$/ }
      }
    }
  }
}

/** A function of a boolean, computed once per value. */
function memo<T>(f: (b: boolean) => T): (b: boolean) => T {
  const cache = new Map<boolean, T>()
  return b => {
    let v = cache.get(b)
    if (v === undefined) cache.set(b, (v = f(b)))
    return v
  }
}
