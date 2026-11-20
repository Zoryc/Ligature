/**
 * LuaTeX Lua errors. LuaTeX prints them without TeX's "! " (and on the current log line, so "))" of files TeX
 * finished reading may come first), then a Lua traceback, then the usual `l.<n>` context and a help text:
 *
 *   ))[\directlua]:1: boom
 *   stack traceback:
 *   	[C]: in function 'error'
 *   	[\directlua]:1: in main chunk.
 *   l.6 \directlua{error("boom")}
 *
 *   The lua interpreter ran into a problem, so the
 *   remainder of this lua chunk will be ignored.
 */
import { diag, raw, type Recogniser } from './context.ts'
import { scanContext, skipHelp } from './errors.ts'
import type { Location } from './fileStack.ts'
import { looksLikeFileName } from './paths.ts'

export const TRACEBACK = 'stack traceback:'

/** Lua shortens deep tracebacks to about 22 lines; never consume more than this. */
const MAX_TRACEBACK = 40
/** As for TeX errors (errors.ts): how far after the traceback we look for the `l.<n>` context line. */
const CONTEXT_WINDOW = 60

/**
 * The chunk name and line Lua puts before its message: "[\directlua]:1: ", "[string "code"]:1: ", "helper.lua:3: "
 * or any name given to load(). Only whitespace, ")" or "]" may precede a bare name (it is the log line's text).
 * Lua shortens chunk names to 60 characters (LUA_IDSIZE): the bound keeps hostile lines linear.
 */
const LUA_HEAD_RE = /(\[\\[A-Za-z]+\]|\[string ".{0,80}?"\]|(?<![^\s)\]])[^\s()[\]]+):(\d+): ?(.*)$/

/** Code given to \directlua, \latelua, ...: the chunk line is meaningless (TeX joins the code into one line). */
const TEX_CHUNK_RE = /^\[\\[A-Za-z]+\]$/

interface Head { start: number; chunk: string | null; chunkLine: number; text: string }

function head(line: string): Head {
  const m = LUA_HEAD_RE.exec(line)
  if (!m) {
    // e.g. "(error object is a table value)": no chunk name; only the leading "))" belong to the log
    const start = /^[)\s]*/.exec(line)![0].length
    return { start, chunk: null, chunkLine: 0, text: line.slice(start).trim() }
  }
  return { start: m.index, chunk: m[1]!, chunkLine: Number(m[2]), text: m[3]!.trim() }
}

function tracebackEnd(lines: string[], from: number): number {
  let k = from
  const limit = Math.min(lines.length, from + MAX_TRACEBACK)
  while (k < limit && lines[k]!.startsWith('\t')) k++
  return k
}

/** The next Lua error's message line (the line before its traceback), or the end of the context window. */
function nextLuaError(lines: string[], from: number): number {
  const limit = Math.min(lines.length, from + CONTEXT_WINDOW)
  let k = from
  while (k < limit && lines[k + 1] !== TRACEBACK) k++
  return k
}

/** A Lua error line is recognised by the traceback that follows it (so it may start with any character). */
export const tryLuaError: Recogniser = (ctx, i) => {
  if (ctx.lines[i + 1] !== TRACEBACK) return 0
  const line = ctx.lines[i]!
  const h = head(line)
  // The text before the message is ordinary log output: "))" closing files, or a file being opened.
  ctx.stack.feed(line.slice(0, h.start))
  // The context (macro levels, then l.<n>) follows the traceback; it never reaches into the next Lua error.
  const tb = tracebackEnd(ctx.lines, i + 2)
  const context = scanContext(ctx.lines, tb, nextLuaError(ctx.lines, tb))
  const end = context ? skipHelp(ctx.lines, context.end, false) : tb

  let loc: Location
  let message: string
  const projectFile = h.chunk !== null && looksLikeFileName(h.chunk) && ctx.stack.project(h.chunk) !== null
  if (projectFile) {
    // A .lua file of the project (dofile/require): its own line is the useful one.
    loc = ctx.stack.at(h.chunk!, h.chunkLine)
    message = h.text
  } else {
    // \directlua code, load()ed strings, TeX Live's Lua files: point at the TeX line that ran the code.
    loc = ctx.stack.current(context?.line)
    message = h.chunk === null || TEX_CHUNK_RE.test(h.chunk) ? h.text : `${h.chunk}:${h.chunkLine}: ${h.text}`
  }
  if (message === '') message = 'Lua error'
  ctx.emit(diag('error', 'lua', message, loc, raw(ctx.lines, i, context ? context.end : end)))
  return Math.max(2, end - i)
}
