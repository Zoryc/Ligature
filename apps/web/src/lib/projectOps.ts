/**
 * Project operations (docs/RENAME-AND-REPLACE.md §2, §3): a label rename or a Replace all, applied in the browser
 * to the live Yjs docs of the files it changes, so the edits travel like typing. Each is one entry of Ctrl+Z,
 * undone in every file at once. No browser here: the project page holds the docs (ProjectCollab.holdFile) and
 * passes them in; the tests use plain Y.Docs.
 */
import * as Y from 'yjs'
import { labelOccurrences } from './latex/labelRefs.ts'
import type { TextRange } from './search.ts'

/** A file's live doc, held for an operation. */
export interface HeldDoc {
  fileId: string
  ytext: Y.Text
  /** The server closed this doc or refused it since: the file has left the operation. */
  left(): boolean
  release(): void
}

/** Characters with consecutive ids (Yjs ids: the client that wrote them, and its clock). */
interface IdRange { client: number; clock: number; len: number }

/** One replaced span: the ids of the text the operation wrote there (null: deleted only) and of the text it deleted. */
interface Span { inserted: IdRange | null; deleted: IdRange[] }

export interface OperationFile {
  fileId: string
  held: HeldDoc
  /** Tracks only this operation's origin: its one item is the operation's edits in this file. */
  undoManager: Y.UndoManager
  spans: Span[]
  /** The doc's state vector right after the operation: characters with a later clock were typed since. */
  after: Map<number, number>
}

export type OperationKind = 'rename' | 'replace'

export interface ProjectOperation {
  id: number
  kind: OperationKind
  /** What it did, for people: "eq:a → eq:b", "foo → bar". */
  label: string
  /** When it was applied (ms since the epoch). */
  time: number
  files: OperationFile[]
  /** A rename's names (the undo checks that `from` is still free). */
  rename?: { from: string; to: string }
}

/** Long enough that the operation's one transaction is one undo item, whatever the clock does. */
const CAPTURE_ALL = 2 ** 31 - 1

/**
 * The ids of the characters of each range of `ytext`'s text (sorted, not overlapping), in one walk of its items.
 * Yjs exposes the item list (`_start`, `right`); the ids are what undo works with.
 */
function rangeIds(ytext: Y.Text, ranges: readonly TextRange[]): IdRange[][] {
  const out = ranges.map((): IdRange[] => [])
  let k = 0
  let index = 0
  for (let item = ytext._start; item && k < ranges.length; item = item.right) {
    if (item.deleted || !item.countable) continue
    const start = index
    const end = index + item.length
    index = end
    while (k < ranges.length && (ranges[k]?.to ?? 0) <= start) k++
    for (let j = k; j < ranges.length; j++) {
      const r = ranges[j]
      if (!r || r.from >= end) break
      const a = Math.max(r.from, start)
      const b = Math.min(r.to, end)
      if (a < b) out[j]?.push({ client: item.id.client, clock: item.id.clock + (a - start), len: b - a })
    }
  }
  return out
}

/**
 * Replace each range of `ytext` (sorted, not overlapping) by `replacement`, in one transaction with `origin`.
 * Minimal edits: only the ranges change. Returns what each span became, for the undo.
 */
export function applyEdits(ytext: Y.Text, ranges: readonly TextRange[], replacement: string, origin: object): Span[] {
  const doc = ytext.doc
  if (!doc) throw new Error('the text is not in a doc')
  const ids = rangeIds(ytext, ranges)
  const spans: Span[] = []
  doc.transact(() => {
    // From the end, so the earlier ranges keep their offsets.
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i]
      if (!r) continue
      if (r.to > r.from) ytext.delete(r.from, r.to - r.from)
      let inserted: IdRange | null = null
      if (replacement) {
        inserted = { client: doc.clientID, clock: Y.getState(doc.store, doc.clientID), len: replacement.length }
        ytext.insert(r.from, replacement)
      }
      spans[i] = { inserted, deleted: ids[i] ?? [] }
    }
  }, origin)
  return spans
}

/** Origins of operations: a class of its own, so no other UndoManager tracks them by constructor. */
class OperationOrigin {
  constructor(readonly id: number) {}
}

export interface OperationRequest {
  id: number
  kind: OperationKind
  label: string
  time: number
  rename?: { from: string; to: string }
  /** The matches in a file's current text. */
  find: (text: string) => TextRange[]
  replacement: string
}

/**
 * Apply an operation to synced docs: in each, the matches are found again on its current text and replaced in one
 * transaction. Docs without a match any more are released. Returns null when nothing changed.
 */
export function applyOperation(docs: readonly HeldDoc[], req: OperationRequest): { op: ProjectOperation; places: number } | null {
  const origin = new OperationOrigin(req.id)
  const files: OperationFile[] = []
  let places = 0
  for (const held of docs) {
    const ranges = req.find(held.ytext.toString())
    if (!ranges.length || held.left()) {
      held.release()
      continue
    }
    // Before the edits: an UndoManager captures the transactions after its creation.
    const undoManager = new Y.UndoManager(held.ytext, { trackedOrigins: new Set([origin]), captureTimeout: CAPTURE_ALL })
    const spans = applyEdits(held.ytext, ranges, req.replacement, origin)
    const doc = held.ytext.doc
    const after = doc ? Y.decodeStateVector(Y.encodeStateVector(doc)) : new Map<number, number>()
    files.push({ fileId: held.fileId, held, undoManager, spans, after })
    places += ranges.length
  }
  if (!files.length) return null
  const op: ProjectOperation = { id: req.id, kind: req.kind, label: req.label, time: req.time, files }
  if (req.rename) op.rename = req.rename
  return { op, places }
}

/** Text an undo put back, mapped to the ids of the text it stands for: `[clock, len, original client, original clock]`. */
type RedoMap = Map<number, [number, number, number, number][]>

/**
 * When an undo restores deleted text, Yjs inserts it again with new ids and links the old item to the new one
 * (`item.redone`). Collect those links backwards, from every item of the text, the deleted ones included.
 */
function redoMap(ytext: Y.Text): RedoMap {
  const map: RedoMap = new Map()
  for (let item = ytext._start; item; item = item.right) {
    const r = item.redone
    if (!r) continue
    const list = map.get(r.client) ?? []
    list.push([r.clock, item.length, item.id.client, item.id.clock])
    map.set(r.client, list)
  }
  return map
}

/** The id a character stands for: its own, or, for text an undo put back, the id of the text it restored. */
function originalId(map: RedoMap, client: number, clock: number): [number, number] {
  // Each link goes from an older item to a newer one, so the walk ends; the bound is only a guard.
  for (let guard = 0; guard < 1000; guard++) {
    const hit = map.get(client)?.find(([c, len]) => clock >= c && clock < c + len)
    if (!hit) break
    const [c, , oc, ok] = hit
    clock = ok + (clock - c)
    client = oc
  }
  return [client, clock]
}

/** The live text as runs of consecutive original ids, with their index in the text. */
function liveRuns(ytext: Y.Text): { client: number; clock: number; len: number; index: number }[] {
  const map = redoMap(ytext)
  const runs: { client: number; clock: number; len: number; index: number }[] = []
  let index = 0
  for (let item = ytext._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue
    const { client, clock } = item.id
    const len = item.length
    const touched = map.get(client)?.some(([c, n]) => c < clock + len && c + n > clock)
    if (!touched) runs.push({ client, clock, len, index })
    else {
      // Rare (text an undo put back): one character at a time.
      for (let k = 0; k < len; k++) {
        const [oc, ok] = originalId(map, client, clock + k)
        runs.push({ client: oc, clock: ok, len: 1, index: index + k })
      }
    }
    index += len
  }
  return runs
}

/**
 * Spans whose written text someone changed since (a character of it deleted, text typed inside it or right next
 * to it): their current text is kept by the undo. Untouched spans, and spans that only deleted, are reverted.
 * `after` is the doc's state vector right after the operation. Text that was deleted and then put back by an undo
 * (this tab's Ctrl+Z, or another operation's undo) counts as the text it restored, not as an edit.
 */
function editedSpans(ytext: Y.Text, spans: readonly Span[], after: ReadonlyMap<number, number>): Set<number> {
  const byClock = spans
    .map((s, i) => ({ i, r: s.inserted }))
    .filter((x): x is { i: number; r: IdRange } => x.r !== null)
    .toSorted((a, b) => a.r.client - b.r.client || a.r.clock - b.r.clock)
  const runs = liveRuns(ytext)
  const seen = new Map<number, { count: number; first: number; last: number }>()
  for (const { client, clock, len, index } of runs) {
    // Binary search: the first span whose range ends after this run starts.
    let lo = 0
    let hi = byClock.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const m = byClock[mid]
      if (m && (m.r.client < client || (m.r.client === client && m.r.clock + m.r.len <= clock))) lo = mid + 1
      else hi = mid
    }
    for (let j = lo; j < byClock.length; j++) {
      const m = byClock[j]
      if (!m || m.r.client !== client || m.r.clock >= clock + len) break
      const a = Math.max(m.r.clock, clock)
      const b = Math.min(m.r.clock + m.r.len, clock + len)
      if (a >= b) continue
      const first = index + (a - clock)
      const s = seen.get(m.i)
      if (s) {
        s.count += b - a
        s.first = Math.min(s.first, first)
        s.last = Math.max(s.last, first + (b - a) - 1)
      } else seen.set(m.i, { count: b - a, first, last: first + (b - a) - 1 })
    }
  }
  const edited = new Set<number>()
  /** Positions next to intact spans: a character typed there since makes the span edited too. */
  const next = new Map<number, number[]>()
  for (const { i, r } of byClock) {
    const s = seen.get(i)
    if (!s || s.count !== r.len || s.last - s.first + 1 !== r.len) edited.add(i)
    else for (const p of [s.first - 1, s.last + 1]) next.set(p, [...(next.get(p) ?? []), i])
  }
  if (next.size) {
    for (const { client, clock, len, index } of runs) {
      for (let k = 0; k < len; k++) {
        const owners = next.get(index + k)
        if (owners && clock + k >= (after.get(client) ?? 0)) for (const i of owners) edited.add(i)
      }
    }
  }
  return edited
}

type DeleteSet = Y.UndoManager['undoStack'][number]['insertions']

/** Remove the id ranges `cut` from a delete set (its per-client lists stay sorted and disjoint). */
function subtract(ds: DeleteSet, cut: readonly IdRange[]): void {
  const byClient = new Map<number, [number, number][]>()
  for (const c of cut) {
    const list = byClient.get(c.client) ?? []
    list.push([c.clock, c.clock + c.len])
    byClient.set(c.client, list)
  }
  for (const [client, cuts] of byClient) {
    const items = ds.clients.get(client)
    if (!items) continue
    const out: typeof items = []
    for (const it of items) {
      let pieces: [number, number][] = [[it.clock, it.clock + it.len]]
      for (const [c0, c1] of cuts) {
        pieces = pieces.flatMap(([p0, p1]): [number, number][] => (c1 <= p0 || c0 >= p1
          ? [[p0, p1]]
          : [[p0, c0], [c1, p1]].filter(([a, b]) => (a ?? 0) < (b ?? 0)) as [number, number][]))
      }
      for (const [a, b] of pieces) out.push({ clock: a, len: b - a })
    }
    ds.clients.set(client, out)
  }
}

/**
 * Undo an operation in every file still in it: only its own edits are reverted, everything typed since stays,
 * and a span edited since stays as it was left. Returns the files undone. Close the operation afterwards.
 */
export function undoOperation(op: ProjectOperation): string[] {
  const done: string[] = []
  for (const f of op.files) {
    if (f.held.left()) continue
    const item = f.undoManager.undoStack.at(-1)
    if (!item) continue
    const edited = editedSpans(f.held.ytext, f.spans, f.after)
    for (const i of edited) {
      const s = f.spans[i]
      if (!s) continue
      if (s.inserted) subtract(item.insertions, [s.inserted])
      subtract(item.deletions, s.deleted)
    }
    f.undoManager.undo()
    done.push(f.fileId)
  }
  return done
}

/** Stop tracking and let go of the docs. */
export function closeOperation(op: ProjectOperation): void {
  for (const f of op.files) {
    f.undoManager.destroy()
    f.held.release()
  }
}

/** Undoing a rename gives the old name back: not when a `\label` uses it now (someone created one since). */
export function renameUndoBlocked(op: ProjectOperation, texts: Iterable<string>): boolean {
  const name = op.rename?.from
  if (!name) return false
  for (const t of texts) if (labelOccurrences(t, name).some(o => o.kind === 'label')) return true
  return false
}

// ---------- Ctrl+Z: the operation or the open file's own undo ----------

/** Key of an undo item's time in `stackItem.meta`. */
const TIME = 'ligature-time'

/** Record on each item of the open file's undo stack when it was made (or last extended). Returns the stop function. */
export function stampUndoItems(undoManager: Y.UndoManager, now: () => number = Date.now): () => void {
  const stamp = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => { stackItem.meta.set(TIME, now()) }
  undoManager.on('stack-item-added', stamp)
  undoManager.on('stack-item-updated', stamp)
  return () => {
    undoManager.off('stack-item-added', stamp)
    undoManager.off('stack-item-updated', stamp)
  }
}

/** The time of the newest item of an undo stack: null when it is empty (0 for an item without one). */
export function newestUndoTime(undoManager: Y.UndoManager): number | null {
  const item = undoManager.undoStack.at(-1)
  if (!item) return null
  const t = item.meta.get(TIME)
  return typeof t === 'number' ? t : 0
}

/**
 * Ctrl+Z: the newest operation is undone when it is newer than the newest item of the open file's own undo stack,
 * or that stack is empty; otherwise the file's own undo runs.
 */
export function undoChoice(operation: number | null, fileUndo: number | null): 'operation' | 'file' {
  if (operation === null) return 'file'
  if (fileUndo === null) return 'operation'
  return operation > fileUndo ? 'operation' : 'file'
}

// ---------- the tab's list of operations ----------

/** Operations kept at most, and for how long. */
export const MAX_OPERATIONS = 10
export const OPERATION_TTL = 60 * 60 * 1000

/** The operations that Ctrl+Z can still undo: the newest 10, each for an hour. Closed when dropped. */
export class OperationList {
  private list: { op: ProjectOperation; timer: ReturnType<typeof setTimeout> }[] = []

  constructor(private readonly now: () => number = Date.now) {}

  add(op: ProjectOperation): void {
    const timer = setTimeout(() => this.drop(op), OPERATION_TTL)
    this.list.push({ op, timer })
    while (this.list.length > MAX_OPERATIONS) {
      const first = this.list[0]
      if (first) this.drop(first.op)
    }
  }

  /**
   * The newest operation that can still be undone. Expired ones are dropped, and so are those every file of
   * which has left (the server closed them all): their undo would change nothing.
   */
  newest(): ProjectOperation | null {
    for (const e of [...this.list]) {
      if (this.now() - e.op.time >= OPERATION_TTL || e.op.files.every(f => f.held.left())) this.drop(e.op)
    }
    return this.list.at(-1)?.op ?? null
  }

  /** Remove an operation and close it (its docs are released). */
  drop(op: ProjectOperation): void {
    const i = this.list.findIndex(e => e.op === op)
    if (i === -1) return
    const [e] = this.list.splice(i, 1)
    if (e) clearTimeout(e.timer)
    closeOperation(op)
  }

  get size(): number {
    return this.list.length
  }

  closeAll(): void {
    for (const e of [...this.list]) this.drop(e.op)
  }
}

// ---------- what the toasts say ----------

function files(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`
}

/** "Renamed eq:basquin to eq:basquin-law: 3 places in 2 files." */
export function renamedText(from: string, to: string, places: number, fileCount: number): string {
  return `Renamed ${from} to ${to}: ${places} place${places === 1 ? '' : 's'} in ${files(fileCount)}.`
}

/** "Replaced 12 in 3 files." */
export function replacedText(places: number, fileCount: number): string {
  return `Replaced ${places} in ${files(fileCount)}.`
}

/** "Rename undone in 2 files", "Replace undone in 3 files". */
export function undoneText(kind: OperationKind, fileCount: number): string {
  return `${kind === 'rename' ? 'Rename' : 'Replace'} undone in ${files(fileCount)}`
}

export function renameUndoRefusedText(name: string): string {
  return `Can't undo the rename: ${name} is now used by another label.`
}

export const UNREACHABLE_TEXT = 'Couldn\'t reach the server; nothing was changed.'
