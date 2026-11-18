import * as Y from 'yjs'

/**
 * "PDF is behind": has a file's Yjs doc changed since the build was made?
 *
 * A Yjs state vector only counts insertions, so deletion-only edits do not move it. A full answer
 * needs the delete set too, i.e. a Y snapshot (state vector + delete set). Sources, best first:
 * 1. snapshot.docSnapshots[fileId]: base64 Y.encodeSnapshot of the server's doc at build time.
 * 2. snapshot.docs[fileId]: base64 state vector only. The delete set is then taken from our own doc
 *    the first time it is checked while its state vector equals the build's (in practice: right when
 *    our own compile result arrives), which catches every deletion made after that moment.
 * 3. Neither (the file was not open on the server when the build ran, so the build used its stored
 *    text): the doc's state at our first check after it synced is taken as the build's state.
 *    Edits made by others between the build and that first check are missed (cannot be seen
 *    without server help); everything after is caught.
 */

type DeleteSet = Y.Snapshot['ds']

interface Baseline {
  sv: Map<number, number>
  /** null until known (source 2 before its state vector matched ours) */
  ds: DeleteSet | null
}

export interface BuildDocState {
  /** file id -> base64 Yjs state vector */
  docs: Record<string, string>
  /** file id -> base64 Y.encodeSnapshot (state vector + delete set); optional, newer servers */
  docSnapshots?: Record<string, string> | undefined
}

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function svAhead(now: Map<number, number>, base: Map<number, number>): boolean {
  for (const [client, clock] of now) if (clock > (base.get(client) ?? 0)) return true
  return false
}

function svEqual(a: Map<number, number>, b: Map<number, number>): boolean {
  return !svAhead(a, b) && !svAhead(b, a)
}

/** Does `now` contain a deleted range that `base` does not cover? (Delete sets only ever grow.) */
function dsAhead(now: DeleteSet, base: DeleteSet): boolean {
  for (const [client, items] of now.clients) {
    const baseItems = base.clients.get(client) ?? []
    for (const it of items) {
      // Both lists are sorted and merged by Y.snapshot(): the range must sit inside one base range.
      const covered = baseItems.some(b => b.clock <= it.clock && it.clock + it.len <= b.clock + b.len)
      if (!covered) return true
    }
  }
  return false
}

function decode(b64: string, asSnapshot: boolean): Baseline | null {
  try {
    const bytes = decodeBase64(b64)
    if (asSnapshot) {
      const s = Y.decodeSnapshot(bytes)
      return { sv: s.sv, ds: s.ds }
    }
    return { sv: Y.decodeStateVector(bytes), ds: null }
  } catch {
    return null
  }
}

/** Tracks one build's baselines; make a new one for every build shown. */
export class BehindTracker {
  private readonly build: BuildDocState
  private readonly baselines = new Map<string, Baseline | null>()
  /** Files known to be ahead: state vectors and delete sets only grow, so this never flips back. */
  private readonly ahead = new Set<string>()

  constructor(build: BuildDocState) {
    this.build = build
  }

  /**
   * Is `doc` (the synced doc of file `fileId`) ahead of the build? Call only once the doc has synced
   * with the server. Returns null when it cannot tell.
   */
  check(fileId: string, doc: Y.Doc): boolean | null {
    if (this.ahead.has(fileId)) return true
    const r = this.compare(fileId, doc)
    if (r) this.ahead.add(fileId)
    return r
  }

  private compare(fileId: string, doc: Y.Doc): boolean | null {
    const now = Y.snapshot(doc)
    let base = this.baselines.get(fileId)
    if (base === undefined) {
      const snap = this.build.docSnapshots?.[fileId]
      const sv = this.build.docs[fileId]
      if (snap !== undefined) base = decode(snap, true)
      else if (sv !== undefined) base = decode(sv, false)
      else base = { sv: now.sv, ds: now.ds } // source 3: first look at a file the build read from storage
      this.baselines.set(fileId, base)
    }
    if (!base) return null
    if (svAhead(now.sv, base.sv)) return true
    if (!base.ds) {
      if (!svEqual(now.sv, base.sv)) return false // we have not received everything the build saw yet
      base.ds = now.ds
      return false
    }
    return dsAhead(now.ds, base.ds)
  }
}

/**
 * The tracker after a build is shown. "PDF is behind" is about the PDF on screen, and a build without a
 * PDF (a failed compile) leaves the older PDF there: keep its tracker. A build with a PDF but no
 * snapshot cannot be compared (null).
 */
export function trackerAfterBuild(current: BehindTracker | null, r: { hasPdf: boolean; snapshot?: BuildDocState | null | undefined }): BehindTracker | null {
  if (!r.hasPdf) return current
  return r.snapshot ? new BehindTracker(r.snapshot) : null
}
