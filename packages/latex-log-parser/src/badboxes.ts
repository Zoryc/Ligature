/** Overfull/Underfull (and Tight/Loose) \hbox and \vbox messages, with the box contents TeX shows after them. */
import { diag, raw, type Recogniser } from './context.ts'

/** Box displays are short with LaTeX's \showboxdepth; never consume more than this. */
const MAX_BOX_LINES = 30

const BADBOX_RE = /^((?:Overfull|Underfull|Tight|Loose) \\[hv]box \([^)]*\))(.*)$/

export const tryBadBox: Recogniser = (ctx, i) => {
  const line = ctx.lines[i]!
  const m = BADBOX_RE.exec(line)
  if (!m) return 0
  const head = m[1]!
  const tail = m[2]!
  let message = head
  let line1: number | undefined
  let line2: number | undefined
  let r = / in (paragraph|alignment) at lines (\d+)--(\d+)/.exec(tail)
  if (r) {
    message = `${head} in ${r[1]!}`
    line1 = Number(r[2])
    line2 = Number(r[3])
  } else if ((r = / detected at line (\d+)/.exec(tail))) {
    line1 = Number(r[1])
  } else if (/ has occurred while \\output is active/.test(tail)) {
    message = `${head} has occurred while \\output is active`
  }
  if (line1 !== undefined && !(Number.isSafeInteger(line1) && line1 > 0)) line1 = undefined
  if (line2 !== undefined && !Number.isSafeInteger(line2)) line2 = undefined
  // The box contents follow, up to an empty line. They are typeset text: "(" and ")" there are not files.
  // TeX's short box display starts with a font switch (\OT1/cmr/m/n/10), [] for boxes, $ for math, | for rules
  // or a space for glue.
  let j = i + 1
  const limit = Math.min(ctx.lines.length, i + 1 + MAX_BOX_LINES)
  while (j < limit && /^[\\[ $|.]/.test(ctx.lines[j]!) && !/^\s*\(/.test(ctx.lines[j]!)) j++
  ctx.emit(diag('info', 'badbox', message, ctx.stack.current(line1), raw(ctx.lines, i, j), line2))
  return j - i
}
