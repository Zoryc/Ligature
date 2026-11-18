import diff from 'fast-diff'
import type * as Y from 'yjs'

/**
 * Turn `ytext` (whose current content is `from`) into `to` with a minimal set of inserts/deletes,
 * so unchanged regions keep their Yjs item identities (remote cursors, relative positions and
 * undo stacks anchored there survive). Must run inside a transaction for a single update.
 * Returns the number of edit operations applied.
 */
export function applyTextDiff(ytext: Y.Text, from: string, to: string): number {
  if (from === to) return 0
  let pos = 0
  let ops = 0
  for (const [op, chunk] of diff(from, to)) {
    if (op === diff.EQUAL) pos += chunk.length
    else if (op === diff.DELETE) { ytext.delete(pos, chunk.length); ops++ }
    else { ytext.insert(pos, chunk); pos += chunk.length; ops++ }
  }
  return ops
}
