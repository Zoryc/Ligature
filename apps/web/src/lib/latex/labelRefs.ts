/**
 * Rename a label (docs/RENAME-AND-REPLACE.md §4): where a label's name is written (`\label{…}` and the reference
 * commands), which one is under the cursor, and whether a new name is usable. Pure. It reads the source line by
 * line with the scanners of go to definition (definitions.ts), so `\\label` and comments are treated the same way:
 * an argument must close on its line, as there.
 */

import { REF_COMMANDS, REF_RANGE_COMMANDS } from './completionData.ts'
import { closing, commands, MAX_OPTIONALS, skipSpace } from './definitions.ts'
import { commentStart } from './latexCompletion.ts'

export interface LabelKey {
  /** The name as written, without the spaces around it. */
  name: string
  /** Where the name itself is, in the text given. */
  from: number
  to: number
  /** In `\label{…}` (the definition) or in a reference command. */
  kind: 'label' | 'ref'
}

/** Longest label name: the index reads no longer ones (projectIndex.ts), and a rename accepts no longer one. */
export const MAX_LABEL = 200

const REFS = new Set(REF_COMMANDS)
const RANGES = new Set(REF_RANGE_COMMANDS)

/** The `{…}` argument at `i` (after spaces): its content's bounds and the index after it; null if none closes here. */
function braces(code: string, i: number): { from: number; to: number; end: number } | null {
  i = skipSpace(code, i)
  if (code[i] !== '{') return null
  const close = closing(code, i, '{', '}')
  return close === -1 ? null : { from: i + 1, to: close, end: close + 1 }
}

/**
 * The keys of one argument: the comma-separated items of a reference list, the whole content otherwise. An
 * argument with a macro inside (`#1`, `\x`, nested braces) is built at run time: none of its items is a name.
 */
function keysOf(code: string, arg: { from: number; to: number }, list: boolean, kind: LabelKey['kind'], out: LabelKey[]) {
  const content = code.slice(arg.from, arg.to)
  if (/[\\{}#]/.test(content)) return
  let at = arg.from
  for (const item of list ? content.split(',') : [content]) {
    const name = item.trim()
    const from = at + item.length - item.trimStart().length
    at += item.length + 1
    if (name) out.push({ name, from, to: from + name.length, kind })
  }
}

/** Every label key of one line (offsets in the line), in order. */
function keysInLine(line: string): LabelKey[] {
  const cut = commentStart(line)
  const code = cut === -1 ? line : line.slice(0, cut)
  const out: LabelKey[] = []
  if (!code.includes('\\')) return out
  for (const tok of commands(code)) {
    const label = tok.name === 'label'
    const ref = REFS.has(tok.name)
    const range = RANGES.has(tok.name)
    if (!label && !ref && !range) continue
    let i = tok.to
    if (code[i] === '*') i++
    if (!label) {
      i = skipSpace(code, i)
      for (let n = 0; code[i] === '[' && n < MAX_OPTIONALS; n++) {
        const end = closing(code, i, '[', ']')
        if (end === -1) break
        i = skipSpace(code, end + 1)
      }
    }
    const first = braces(code, i)
    if (!first) continue
    keysOf(code, first, ref, label ? 'label' : 'ref', out)
    if (range) {
      const second = braces(code, first.end)
      if (second) keysOf(code, second, false, 'ref', out)
    }
  }
  return out
}

/** Calls `f` with each line of `text` and its offset (a CRLF line keeps its \r: no key ends with it). */
function eachLine(text: string, f: (line: string, start: number) => void): void {
  let start = 0
  while (start <= text.length) {
    const nl = text.indexOf('\n', start)
    const end = nl === -1 ? text.length : nl
    f(text.slice(start, end), start)
    if (nl === -1) break
    start = nl + 1
  }
}

/** Every place `name` is written as a label or a reference, in order: the bounds of the name itself. */
export function labelOccurrences(text: string, name: string): LabelKey[] {
  const out: LabelKey[] = []
  if (!name || !text.includes(name)) return out
  eachLine(text, (line, start) => {
    if (!line.includes(name)) return
    for (const k of keysInLine(line)) if (k.name === name) out.push({ ...k, from: k.from + start, to: k.to + start })
  })
  return out
}

/** The labels a text defines (`\label{…}`), with their 1-based lines. */
export function labelsDefined(text: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = []
  let n = 0
  eachLine(text, line => {
    n++
    if (!line.includes('label')) return
    for (const k of keysInLine(line)) if (k.kind === 'label') out.push({ name: k.name, line: n })
  })
  return out
}

/** The label name under the cursor at `pos` (in `\label{…}` or a reference key; its end counts as inside), or null. */
export function labelAt(text: string, pos: number): LabelKey | null {
  if (pos < 0 || pos > text.length) return null
  const start = pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1
  const nl = text.indexOf('\n', pos)
  const line = text.slice(start, nl === -1 ? text.length : nl)
  const col = pos - start
  const k = keysInLine(line).find(x => col >= x.from && col <= x.to)
  return k ? { ...k, from: k.from + start, to: k.to + start } : null
}

/** Where a label is defined, for the warning "already a label". */
export interface LabelPlace { path: string; line: number }

/**
 * What is wrong with a new label name (spaces at both ends do not count), or null when it can be used.
 * `existing` says where a name is already defined as a label.
 */
export function labelNameProblem(raw: string, existing: (name: string) => LabelPlace | null): string | null {
  const name = raw.trim()
  if (!name) return 'Type the new name.'
  if (/[{}\\%#,\r\n]/.test(name)) return 'A label name can\'t contain { } \\ % # , or a line break.'
  if (name.length > MAX_LABEL) return `A label name can't be longer than ${MAX_LABEL} characters.`
  const at = existing(name)
  return at ? `${name} is already a label, in ${at.path} line ${at.line}.` : null
}

/** "3 places in 2 files", "1 place in 1 file". */
export function placesText(places: number, files: number): string {
  return `${places} place${places === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`
}
