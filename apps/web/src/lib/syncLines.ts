/**
 * SyncTeX line numbers vs. edits made since the build (docs/M2.md §3).
 *
 * SyncTeX answers in the line numbers of the text the shown PDF was built from. Once the file is edited
 * those drift from the editor's. A LineMap anchors the start of every build line to a character offset
 * and maps the offsets through every change of the Y.Text (as FileDiagnostics does for problems), so a
 * build line can be found in the current text and back.
 *
 * While a file is closed only a line table is kept (build line -> current line at close time); it is
 * anchored again when the file is reopened. Changes made by others while the file is closed are not
 * seen (the same approximation as the diagnostics).
 */
import { lineAt, lineStarts, mapPos, type ChangeLog, type DeltaOp } from './diagnostics.ts'

export class LineMap {
  /** Current offset of the start of each build line (index = build line - 1); never decreasing. */
  private starts: number[]

  private constructor(starts: number[]) {
    this.starts = starts
  }

  /** The build's text is `text` (no edits since). */
  static fromText(text: string): LineMap {
    return new LineMap(lineStarts(text))
  }

  /** The build read the text a compile started from (`log.text`); bring it up to date with the changes since. */
  static fromChangeLog(log: ChangeLog): LineMap {
    const m = LineMap.fromText(log.text)
    log.replay(d => m.applyDelta(d))
    return m
  }

  /**
   * Re-anchor a line table (build line -> current line, from toTable) against `text`.
   * No table: the file has not changed since the build as far as we know.
   */
  static fromTable(table: readonly number[] | null | undefined, text: string): LineMap {
    if (!table || table.length === 0) return LineMap.fromText(text)
    const cur = lineStarts(text)
    const last = cur.length
    return new LineMap(table.map(l => cur[Math.min(Math.max(1, l), last) - 1] ?? text.length))
  }

  get lineCount(): number {
    return this.starts.length
  }

  /** Follow one change of the text (YTextEvent.delta). */
  applyDelta(delta: readonly DeltaOp[]): void {
    // Line starts before the first change do not move: skip them.
    const first = delta[0]
    const unchanged = first && first.retain !== undefined ? first.retain : 0
    // assoc 1: a line starting exactly at an insertion point stays after the inserted text (typing Enter
    // at the start of a line pushes that line down).
    for (let i = firstAtOrAfter(this.starts, unchanged); i < this.starts.length; i++) {
      this.starts[i] = mapPos(this.starts[i] ?? 0, delta, 1)
    }
  }

  /** Build line -> line of the current text (`text`). Lines past the end clamp to the last one. */
  toCurrent(buildLine: number, text: string): number {
    const n = this.starts.length
    const idx = Math.min(Math.max(1, Math.floor(buildLine)), n) - 1
    const pos = Math.min(this.starts[idx] ?? 0, text.length)
    return lineAt(lineStarts(text), pos)
  }

  /**
   * Current line -> build line. The first (surviving) build line that starts within the current line; for a line
   * added since the build, the build line before it (where the new text will appear); else line 1.
   */
  toBuild(line: number, text: string): number {
    const cur = lineStarts(text)
    const l = Math.min(Math.max(1, Math.floor(line)), cur.length)
    const from = cur[l - 1] ?? 0
    const next = cur[l]
    const to = next === undefined ? text.length : next - 1
    let i = firstAtOrAfter(this.starts, from)
    const at = this.starts[i]
    if (at === undefined || at > to) return Math.max(1, i)
    // Build lines sharing one start were deleted down to nothing, except the last: that one is here.
    while (this.starts[i + 1] === at) i++
    return i + 1
  }

  /** Build line -> current line for every build line (kept while the file is closed). */
  toTable(text: string): number[] {
    const cur = lineStarts(text)
    return this.starts.map(p => lineAt(cur, Math.min(p, text.length)))
  }
}

/** Index of the first element >= value in a non-decreasing array (length if none). */
function firstAtOrAfter(arr: readonly number[], value: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((arr[mid] ?? 0) < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The line maps of the build whose PDF is shown: one live LineMap for the open file, line tables for
 * files closed since. Replace it (reset) whenever a build with a PDF is shown; a build without a PDF
 * leaves it alone (the older PDF stays on screen, and so must its line numbers).
 */
export class SyncLines {
  private tables = new Map<string, number[]>()
  private open: { fileId: string; map: LineMap } | null = null

  /** A new PDF is shown. `openFile`: the open file's build text and changes since (or null: anchor to its current text). */
  reset(openFile: { fileId: string; map: LineMap } | null): void {
    this.tables = new Map()
    this.open = openFile
  }

  /** The file was opened (synced) with this text. */
  opened(fileId: string, text: string): void {
    if (this.open?.fileId === fileId) return
    this.open = { fileId, map: LineMap.fromTable(this.tables.get(fileId), text) }
  }

  /** The open file is about to close; its current text is `text`. */
  closed(fileId: string, text: string): void {
    if (this.open?.fileId !== fileId) return
    this.tables.set(fileId, this.open.map.toTable(text))
    this.open = null
  }

  applyDelta(fileId: string, delta: readonly DeltaOp[]): void {
    if (this.open?.fileId === fileId) this.open.map.applyDelta(delta)
  }

  /** Build line of `fileId` -> current line. `text`: the file's current text if it is the open file. */
  toCurrent(fileId: string, buildLine: number, text: string | null): number {
    if (this.open?.fileId === fileId && text !== null) return this.open.map.toCurrent(buildLine, text)
    const t = this.tables.get(fileId)
    return t?.[Math.min(Math.max(1, buildLine), t.length) - 1] ?? buildLine
  }

  /** Current line of the open file -> build line. */
  toBuild(fileId: string, line: number, text: string): number {
    if (this.open?.fileId === fileId) return this.open.map.toBuild(line, text)
    return line
  }
}
