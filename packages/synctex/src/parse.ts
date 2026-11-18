import { SynctexError } from './errors.ts'
import { normalizePath } from './paths.ts'
import { DEFAULT_MAX_CHARS, DEFAULT_MAX_RECORDS, Kind, type SynctexIndex, type SynctexLimits } from './types.ts'

/** Scaled points per PDF point (big point): 65536 * 72.27 / 72. */
const SP_PER_BP = 65781.76
const INT_MAX = 2147483647
const INT_MIN = -2147483648

const C_LF = 10
const C_CR = 13
const C_COMMA = 44
const C_COLON = 58
const C_MINUS = 45
const C_PLUS = 43
const C_0 = 48
const C_9 = 57

const RECORD_KIND: Record<string, Kind> = {
  '[': Kind.VBox,
  '(': Kind.HBox,
  'v': Kind.VoidVBox,
  'h': Kind.VoidHBox,
  'k': Kind.Kern,
  'g': Kind.Glue,
  '$': Kind.Math,
  'x': Kind.Boundary,
  'r': Kind.Rule,
}

/** Growable column store for the records. */
class Store {
  count = 0
  cap: number
  kind: Uint8Array
  tag: Int32Array
  line: Int32Array
  column: Int32Array
  page: Int32Array
  parent: Int32Array
  depth: Int32Array
  h: Int32Array
  v: Int32Array
  width: Int32Array
  height: Int32Array
  depthBelow: Int32Array

  constructor(cap: number) {
    this.cap = Math.max(16, cap)
    this.kind = new Uint8Array(this.cap)
    this.tag = new Int32Array(this.cap)
    this.line = new Int32Array(this.cap)
    this.column = new Int32Array(this.cap)
    this.page = new Int32Array(this.cap)
    this.parent = new Int32Array(this.cap)
    this.depth = new Int32Array(this.cap)
    this.h = new Int32Array(this.cap)
    this.v = new Int32Array(this.cap)
    this.width = new Int32Array(this.cap)
    this.height = new Int32Array(this.cap)
    this.depthBelow = new Int32Array(this.cap)
  }

  private static resize<T extends Int32Array | Uint8Array>(a: T, n: number, make: (n: number) => T): T {
    const b = make(n)
    b.set(a.subarray(0, Math.min(a.length, n)))
    return b
  }

  /** Resizes every column to `n` entries. */
  resizeTo(n: number): void {
    const i32 = (k: number) => new Int32Array(k)
    this.kind = Store.resize(this.kind, n, (k) => new Uint8Array(k))
    this.tag = Store.resize(this.tag, n, i32)
    this.line = Store.resize(this.line, n, i32)
    this.column = Store.resize(this.column, n, i32)
    this.page = Store.resize(this.page, n, i32)
    this.parent = Store.resize(this.parent, n, i32)
    this.depth = Store.resize(this.depth, n, i32)
    this.h = Store.resize(this.h, n, i32)
    this.v = Store.resize(this.v, n, i32)
    this.width = Store.resize(this.width, n, i32)
    this.height = Store.resize(this.height, n, i32)
    this.depthBelow = Store.resize(this.depthBelow, n, i32)
    this.cap = n
  }
}

/** Fields of the record being scanned (module-level scratch: parsing is synchronous). */
const rec = { tag: 0, line: 0, column: -1, h: 0, v: 0, w: 0, ht: 0, dp: 0 }

/**
 * Parses the text of a SyncTeX file (the caller gunzips `.synctex.gz`).
 *
 * Throws only `SynctexError`: `TooLarge` above `limits.maxChars`, `Invalid` without a `SyncTeX Version:`
 * header. Damaged lines are skipped; unbalanced boxes are tolerated. Stops after `limits.maxRecords`
 * records (`truncated: true`). Runs in time linear in the input.
 */
export function parseSynctex(text: string, limits: SynctexLimits = {}): SynctexIndex {
  const maxChars = limits.maxChars ?? DEFAULT_MAX_CHARS
  const maxRecords = Math.max(0, Math.floor(limits.maxRecords ?? DEFAULT_MAX_RECORDS))
  if (typeof text !== 'string') throw new SynctexError('Invalid', 'SyncTeX input must be a string')
  if (text.length > maxChars) {
    throw new SynctexError('TooLarge', `SyncTeX file is larger than ${maxChars} characters`)
  }
  if (!text.startsWith('SyncTeX Version:')) throw new SynctexError('Invalid', 'Not a SyncTeX file')

  const n = text.length
  const store = new Store(Math.min(maxRecords, Math.ceil(n / 24)))
  const inputs = new Map<number, string>()

  let preUnit = 0
  let preMag = 0
  let preX = 0
  let preY = 0
  let postMag = 0
  let postX: number | undefined
  let postY: number | undefined
  let inPostScriptum = false

  let page = 0
  let pageCount = 0
  let formDepth = 0
  let truncated = false
  /** Effective parent of each open box (an unparsable box line pushes its own parent). */
  const stack: number[] = []

  // ---- number scanning on `text` with a cursor
  let p = 0
  let end = 0
  /** Scans an optionally signed integer at `p`; NaN if there is none or it does not fit 32 bits. */
  const int = (): number => {
    let neg = false
    let c = text.charCodeAt(p)
    if (c === C_MINUS || c === C_PLUS) {
      neg = c === C_MINUS
      c = text.charCodeAt(++p)
    }
    if (!(c >= C_0 && c <= C_9) || p >= end) return NaN
    let val = 0
    while (p < end) {
      c = text.charCodeAt(p)
      if (c < C_0 || c > C_9) break
      val = val * 10 + (c - C_0)
      if (val > INT_MAX + 1) return NaN
      p++
    }
    val = neg ? -val : val
    return val < INT_MIN || val > INT_MAX ? NaN : val
  }
  const eat = (ch: number): boolean => {
    if (p < end && text.charCodeAt(p) === ch) {
      p++
      return true
    }
    return false
  }

  /** Scans `tag,line[,column]:h,v[:W[,H[,D]]]` from `p` into `rec`; false if malformed. */
  const scanRecord = (): boolean => {
    rec.tag = int()
    if (!(rec.tag >= 0) || !eat(C_COMMA)) return false
    rec.line = int()
    if (Number.isNaN(rec.line)) return false
    rec.column = -1
    if (eat(C_COMMA)) {
      rec.column = int()
      if (Number.isNaN(rec.column)) return false
    }
    if (!eat(C_COLON)) return false
    rec.h = int()
    if (Number.isNaN(rec.h) || !eat(C_COMMA)) return false
    rec.v = int()
    if (Number.isNaN(rec.v)) return false
    rec.w = rec.ht = rec.dp = 0
    if (eat(C_COLON)) {
      rec.w = int()
      if (Number.isNaN(rec.w)) return false
      if (eat(C_COMMA)) {
        rec.ht = int()
        if (Number.isNaN(rec.ht) || !eat(C_COMMA)) return false
        rec.dp = int()
        if (Number.isNaN(rec.dp)) return false
      }
    }
    return true
  }

  const add = (kind: Kind): number => {
    if (store.count >= store.cap) store.resizeTo(Math.min(maxRecords, store.cap * 2))
    const i = store.count++
    const parent = stack.length > 0 ? stack[stack.length - 1]! : -1
    store.kind[i] = kind
    store.tag[i] = rec.tag
    store.line[i] = rec.line
    store.column[i] = rec.column
    store.page[i] = formDepth > 0 ? 0 : page
    store.parent[i] = parent
    store.depth[i] = parent >= 0 ? store.depth[parent]! + 1 : 0
    store.h[i] = rec.h
    store.v[i] = rec.v
    store.width[i] = rec.w
    store.height[i] = rec.ht
    store.depthBelow[i] = rec.dp
    return i
  }

  const startsWith = (s: string): boolean => text.startsWith(s, p)
  const valueAfter = (key: string): string => text.slice(p + key.length, end).trim()

  let pos = 0
  while (pos < n) {
    let nl = text.indexOf('\n', pos)
    if (nl < 0) nl = n
    end = nl > pos && text.charCodeAt(nl - 1) === C_CR ? nl - 1 : nl
    p = pos
    pos = nl + 1
    if (p >= end) continue
    const first = text[p]!

    const kind = RECORD_KIND[first]
    if (kind !== undefined) {
      if (store.count >= maxRecords) {
        truncated = true
        break
      }
      p++
      const ok = scanRecord()
      if (kind === Kind.VBox || kind === Kind.HBox) {
        const parent = stack.length > 0 ? stack[stack.length - 1]! : -1
        stack.push(ok ? add(kind) : parent)
      } else if (ok) {
        add(kind)
      }
      continue
    }

    switch (first) {
      case ']':
      case ')':
        stack.pop()
        break
      case '<': {
        // form (XObject) definition: content not on any page
        formDepth++
        stack.push(stack.length > 0 ? stack[stack.length - 1]! : -1)
        break
      }
      case '>':
        if (formDepth > 0) formDepth--
        stack.pop()
        break
      case '{': {
        p++
        const pg = int()
        page = pg > 0 && pg <= 1_000_000 ? pg : 0
        if (page > pageCount) pageCount = page
        stack.length = 0
        formDepth = 0
        break
      }
      case '}':
        page = 0
        stack.length = 0
        formDepth = 0
        break
      case 'I':
        if (startsWith('Input:')) {
          p += 6
          const tag = int()
          if (tag >= 0 && eat(C_COLON)) inputs.set(tag, normalizePath(text.slice(p, end)))
        }
        break
      case 'P':
        if (startsWith('Post scriptum:')) inPostScriptum = true
        break
      case 'M':
        if (startsWith('Magnification:')) {
          const val = Number.parseFloat(valueAfter('Magnification:'))
          if (inPostScriptum) postMag = val > 0 && Number.isFinite(val) ? val : postMag
          else preMag = val > 0 && Number.isFinite(val) ? val : preMag
        }
        break
      case 'U':
        if (startsWith('Unit:')) {
          const val = Number.parseFloat(valueAfter('Unit:'))
          if (val > 0 && Number.isFinite(val)) preUnit = val
        }
        break
      case 'X':
      case 'Y': {
        const key = first + ' Offset:'
        if (!startsWith(key)) break
        const raw = valueAfter(key)
        if (inPostScriptum) {
          const sp = dimensionToSp(raw)
          if (sp !== undefined) {
            if (first === 'X') postX = sp
            else postY = sp
          }
        } else {
          const val = Number.parseFloat(raw)
          if (Number.isFinite(val)) {
            if (first === 'X') preX = val
            else preY = val
          }
        }
        break
      }
      default:
        break
    }
  }

  if (store.count < store.cap) store.resizeTo(store.count)
  fixLineEnds(store)
  if (preUnit <= 0) preUnit = 8192
  fixVboxOrigins(store, 65536 / preUnit)
  if (preMag <= 0) preMag = 1000
  const scale = (postMag > 0 ? postMag : 1) * (preUnit / SP_PER_BP) * (preMag / 1000)
  const xOffset = postX !== undefined ? postX / SP_PER_BP : preX * (preUnit / SP_PER_BP)
  const yOffset = postY !== undefined ? postY / SP_PER_BP : preY * (preUnit / SP_PER_BP)

  return {
    inputs,
    count: store.count,
    pageCount,
    truncated,
    scale,
    xOffset: Number.isFinite(xOffset) ? xOffset : 0,
    yOffset: Number.isFinite(yOffset) ? yOffset : 0,
    kind: store.kind,
    tag: store.tag,
    line: store.line,
    column: store.column,
    page: store.page,
    parent: store.parent,
    depth: store.depth,
    h: store.h,
    v: store.v,
    width: store.width,
    height: store.height,
    depthBelow: store.depthBelow,
  }
}

/**
 * TeX writes some records of a line of text with the wrong source line; correct them like SyncTeX's own
 * parser does (one linear pass, children always follow their parent):
 *  - the leading `x` (boundary) records of an hbox are written when the line is broken, with the line
 *    where the paragraph ended: they take the tag/line/column of the next non-boundary sibling;
 *  - an hbox ending in a kern and a glue (`\parfillskip`, `\rightskip`) gets them the same way: they take
 *    the tag/line/column of the child before them.
 */
function fixLineEnds(s: Store): void {
  const n = s.count
  // per hbox: its leading boundaries still waiting for a line, its last three children
  const pending = new Map<number, number[]>()
  const last = new Map<number, [number, number, number]>()
  const copy = (to: number, from: number) => {
    s.tag[to] = s.tag[from]!
    s.line[to] = s.line[from]!
    s.column[to] = s.column[from]!
  }
  for (let i = 0; i < n; i++) {
    const p = s.parent[i]!
    if (p < 0 || s.kind[p] !== Kind.HBox) continue
    const l = last.get(p)
    if (l === undefined) {
      last.set(p, [-1, -1, i])
      if (s.kind[i] === Kind.Boundary) pending.set(p, [i])
      continue
    }
    l[0] = l[1]
    l[1] = l[2]
    l[2] = i
    const xs = pending.get(p)
    if (xs === undefined) continue
    if (s.kind[i] === Kind.Boundary) {
      xs.push(i)
    } else {
      for (const x of xs) copy(x, i)
      pending.delete(p)
    }
  }
  for (const [, [before, a, b]] of last) {
    if (before < 0) continue
    const ka = s.kind[a]
    const kb = s.kind[b]
    if ((ka === Kind.Kern && kb === Kind.Glue) || (ka === Kind.Glue && kb === Kind.Kern)) {
      copy(a, before)
      copy(b, before)
    }
  }
}

/**
 * pdfTeX and XeTeX write a vbox at its baseline (bottom-left), LuaTeX at its top-left. Detect the latter
 * from the box's children (all below `v` instead of above it) and move `v` to the baseline.
 */
/** `slack`: 1pt in raw units. */
function fixVboxOrigins(s: Store, slack: number): void {
  const n = s.count
  const minTop = new Map<number, number>()
  const maxBottom = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const p = s.parent[i]!
    if (p < 0 || s.kind[p] !== Kind.VBox) continue
    const k = s.kind[i]!
    if (k !== Kind.HBox && k !== Kind.VBox && k !== Kind.VoidHBox && k !== Kind.VoidVBox) continue
    const top = s.v[i]! - s.height[i]!
    const bottom = s.v[i]! + s.depthBelow[i]!
    minTop.set(p, Math.min(minTop.get(p) ?? Infinity, top))
    maxBottom.set(p, Math.max(maxBottom.get(p) ?? -Infinity, bottom))
  }
  for (const [box, top] of minTop) {
    const bottom = maxBottom.get(box)!
    const v = s.v[box]!
    const h = Math.abs(s.height[box]!)
    const d = Math.abs(s.depthBelow[box]!)
    const fitsBaseline = top >= v - h - slack && bottom <= v + d + slack
    const fitsTop = top >= v - slack && bottom <= v + h + d + slack
    if (!fitsBaseline && fitsTop && h > 0) {
      const moved = v + h
      if (moved <= INT_MAX) s.v[box] = moved
    }
  }
}

const SP_PER_UNIT: Record<string, number> = {
  sp: 1,
  pt: 65536,
  bp: SP_PER_BP,
  in: 72.27 * 65536,
  cm: (72.27 / 2.54) * 65536,
  mm: (72.27 / 25.4) * 65536,
  pc: 12 * 65536,
  dd: (1238 / 1157) * 65536,
  cc: 12 * (1238 / 1157) * 65536,
}

/** `"12.5pt"`, `"1in"`, `"3"` (points) -> scaled points; undefined if unreadable. */
function dimensionToSp(s: string): number | undefined {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z]{2})?/.exec(s)
  if (!m) return undefined
  const val = Number.parseFloat(m[1]!)
  const factor = m[2] === undefined ? 65536 : SP_PER_UNIT[m[2]]
  if (factor === undefined || !Number.isFinite(val)) return undefined
  return val * factor
}
