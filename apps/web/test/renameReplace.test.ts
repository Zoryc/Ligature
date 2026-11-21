import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { REF_COMMANDS, REF_RANGE_COMMANDS } from '../src/lib/latex/completionData.ts'
import { labelAt, labelNameProblem, labelOccurrences, labelsDefined, placesText } from '../src/lib/latex/labelRefs.ts'
import { findAll, MAX_RESULTS, replaceLabel, sameSearch, searchFiles, summaryText } from '../src/lib/search.ts'
import {
  applyOperation, closeOperation, MAX_OPERATIONS, newestUndoTime, OPERATION_TTL, OperationList, renamedText,
  renameUndoBlocked, renameUndoRefusedText, replacedText, stampUndoItems, undoChoice, undoneText, undoOperation,
  type HeldDoc, type ProjectOperation,
} from '../src/lib/projectOps.ts'
import { SharedDocs } from '../src/lib/sharedDocs.ts'
import { parsePrefs } from '../src/lib/prefs.svelte.ts'
import { isSearchAllShortcut } from '../src/lib/shortcuts.ts'

/** The texts at each occurrence of `name` in `text`. */
function spans(text: string, name: string): string[] {
  return labelOccurrences(text, name).map(o => text.slice(o.from, o.to))
}

describe('labelOccurrences', () => {
  it('finds the name in \\label and in every reference command', () => {
    for (const cmd of REF_COMMANDS) {
      const text = `See \\${cmd}{eq:a}.`
      const [o] = labelOccurrences(text, 'eq:a')
      expect(o, cmd).toMatchObject({ kind: 'ref', from: text.indexOf('eq:a'), to: text.indexOf('eq:a') + 4 })
    }
    expect(labelOccurrences('\\label{eq:a}', 'eq:a')).toEqual([{ name: 'eq:a', from: 7, to: 11, kind: 'label' }])
    expect(spans('\\label{ eq:a }', 'eq:a')).toEqual(['eq:a'])
  })

  it('takes each key of a list, spaces around keys allowed and kept', () => {
    const text = '\\cref{eq:b, eq:a ,eq:c} \\Cref{eq:a,eq:a}'
    const occ = labelOccurrences(text, 'eq:a')
    expect(occ).toHaveLength(3)
    expect(occ.map(o => text.slice(o.from - 1, o.to + 1))).toEqual([' eq:a ', '{eq:a,', ',eq:a}'])
  })

  it('reads past a star and up to 3 optional arguments', () => {
    expect(spans('\\cref*{eq:a}', 'eq:a')).toHaveLength(1)
    expect(spans('\\ref[x]{eq:a}', 'eq:a')).toHaveLength(1)
    expect(spans('\\ref [a][b][c] {eq:a}', 'eq:a')).toHaveLength(1)
    expect(spans('\\ref[a][b][c][d]{eq:a}', 'eq:a')).toHaveLength(0)
  })

  it('takes both arguments of the range commands', () => {
    for (const cmd of REF_RANGE_COMMANDS) {
      expect(spans(`\\${cmd}{eq:a}{eq:z}`, 'eq:a'), cmd).toHaveLength(1)
      expect(spans(`\\${cmd}{eq:z}{ eq:a }`, 'eq:a'), cmd).toHaveLength(1)
    }
    expect(spans('\\crefrange{eq:a}{eq:a}', 'eq:a')).toHaveLength(2)
  })

  it('never matches in comments, after \\\\, in longer names, prose or other commands', () => {
    expect(spans('% \\label{eq:a}', 'eq:a')).toEqual([])
    expect(spans('x \\ref{eq:b} % \\ref{eq:a}', 'eq:a')).toEqual([])
    expect(spans('50\\% \\ref{eq:a}', 'eq:a')).toHaveLength(1) // an escaped % is not a comment
    expect(spans('a\\\\label{eq:a}', 'eq:a')).toEqual([])
    expect(spans('a\\\\\\label{eq:a}', 'eq:a')).toHaveLength(1)
    expect(spans('\\label{eq:a2} \\ref{eq:a:b} \\ref{xeq:a}', 'eq:a')).toEqual([])
    expect(spans('eq:a in prose, \\cite{eq:a}, \\textbf{eq:a}, \\labelx{eq:a}', 'eq:a')).toEqual([])
  })

  it('never matches a name built by a macro', () => {
    expect(spans('\\newcommand\\fig[1]{\\label{eq:a#1}}', 'eq:a#1')).toEqual([])
    expect(spans('\\label{\\prefix eq:a}', 'eq:a')).toEqual([])
    expect(spans('\\cref{eq:a,\\x}', 'eq:a')).toEqual([])
    expect(spans('\\ref{{eq:a}}', 'eq:a')).toEqual([])
  })

  it('finds several on a line, on every line, with CRLF line ends', () => {
    const text = '\\label{eq:a}\\eqref{eq:a}\r\nx \\ref{eq:a}.\r\n\\pageref{eq:a}'
    const occ = labelOccurrences(text, 'eq:a')
    expect(occ.map(o => o.kind)).toEqual(['label', 'ref', 'ref', 'ref'])
    for (const o of occ) expect(text.slice(o.from, o.to)).toBe('eq:a')
    expect(labelsDefined(text)).toEqual([{ name: 'eq:a', line: 1 }])
  })

  it('needs the argument to close on its line', () => {
    expect(spans('\\ref{eq:a\n}', 'eq:a')).toEqual([])
  })
})

describe('labelAt', () => {
  const text = 'x \\cref{ eq:a, eq:bb } \\label{sec:x}'
  const a = text.indexOf('eq:a')
  const bb = text.indexOf('eq:bb')

  it('is the name under the cursor, its end included', () => {
    expect(labelAt(text, a)?.name).toBe('eq:a')
    expect(labelAt(text, a + 4)?.name).toBe('eq:a')
    expect(labelAt(text, bb + 5)).toMatchObject({ name: 'eq:bb', from: bb, to: bb + 5, kind: 'ref' })
    expect(labelAt(text, text.indexOf('sec:x') + 2)).toMatchObject({ name: 'sec:x', kind: 'label' })
  })

  it('is nothing outside the names', () => {
    expect(labelAt(text, a - 1)).toBeNull() // the space before
    expect(labelAt(text, bb + 6)).toBeNull()
    expect(labelAt(text, 3)).toBeNull() // in \cref
    expect(labelAt(text, 0)).toBeNull()
    expect(labelAt(text, -1)).toBeNull()
    expect(labelAt(text, text.length + 1)).toBeNull()
  })

  it('reads the right line of a longer text', () => {
    const t = 'one\n\\ref{eq:z}\nthree'
    expect(labelAt(t, t.indexOf('eq:z') + 1)).toMatchObject({ name: 'eq:z', from: t.indexOf('eq:z') })
  })
})

describe('label name validation', () => {
  const none = () => null
  it('warns about empty, forbidden characters and long names', () => {
    expect(labelNameProblem('', none)).toBeTruthy()
    expect(labelNameProblem('   ', none)).toBeTruthy()
    for (const c of ['{', '}', '\\', '%', '#', ',', '\n']) expect(labelNameProblem(`eq${c}x`, none), c).toBeTruthy()
    expect(labelNameProblem('a'.repeat(201), none)).toBeTruthy()
    expect(labelNameProblem('a'.repeat(200), none)).toBeNull()
  })

  it('trims the ends and allows spaces inside', () => {
    expect(labelNameProblem('  eq:my label  ', none)).toBeNull()
  })

  it('says where an existing label is', () => {
    const at = (n: string) => (n === 'eq:x' ? { path: 'results.tex', line: 12 } : null)
    expect(labelNameProblem(' eq:x ', at)).toBe('eq:x is already a label, in results.tex line 12.')
    expect(labelNameProblem('eq:y', at)).toBeNull()
  })

  it('counts places', () => {
    expect(placesText(3, 2)).toBe('3 places in 2 files')
    expect(placesText(1, 1)).toBe('1 place in 1 file')
  })
})

describe('search', () => {
  const plain = { matchCase: false, wholeWord: false }

  it('finds plain text, ignoring case unless asked', () => {
    expect(findAll('Foo foo FOO', 'foo', plain)).toHaveLength(3)
    expect(findAll('Foo foo FOO', 'foo', { matchCase: true, wholeWord: false })).toEqual([{ from: 4, to: 7 }])
  })

  it('whole word: not preceded or followed by a letter, digit or _', () => {
    const w = { matchCase: false, wholeWord: true }
    expect(findAll('cat cats bobcat cat_ 2cat cat.', 'cat', w)).toEqual([{ from: 0, to: 3 }, { from: 26, to: 29 }])
    expect(findAll('éte été', 'été', w)).toEqual([{ from: 4, to: 7 }])
  })

  it('matches special characters literally', () => {
    const text = 'a \\ref{x} $y$ (z) [w] a.b a+b ^ | / *'
    for (const q of ['\\ref{x}', '$y$', '(z)', '[w]', 'a.b', 'a+b', '^', '|', '/', '*']) {
      expect(findAll(text, q, plain), q).toHaveLength(1)
    }
    expect(findAll('axb', 'a.b', plain)).toEqual([])
  })

  it('never overlaps, and the empty query finds nothing', () => {
    expect(findAll('aaaa', 'aa', plain)).toEqual([{ from: 0, to: 2 }, { from: 2, to: 4 }])
    expect(findAll('aaa', 'aa', plain)).toHaveLength(1)
    expect(findAll('abc', '', plain)).toEqual([])
  })

  it('gives each result its line and column, and the line cut around the match', () => {
    const text = 'first\r\nsecond foo\nfoo third foo'
    const s = searchFiles([{ id: 'f', text }], 'foo', plain)
    expect(s.files[0]?.results.map(r => [r.line, r.column])).toEqual([[2, 7], [3, 0], [3, 10]])
    expect(s.files[0]?.results[0]).toMatchObject({ before: 'second ', match: 'foo', after: '' })
    const long = `${'x'.repeat(100)}foo${'y'.repeat(300)}`
    const r = searchFiles([{ id: 'f', text: long }], 'foo', plain).files[0]?.results[0]
    expect(r?.before.startsWith('…')).toBe(true)
    expect(r?.before.length).toBeLessThan(40)
    expect(r?.after.length).toBeLessThanOrEqual(120)
  })

  it('groups by file in the order given, with exact counts past the cap', () => {
    const files = [{ id: 'a', text: 'x'.repeat(1500) }, { id: 'none', text: 'y' }, { id: 'b', text: 'x'.repeat(1000) }]
    const s = searchFiles(files, 'x', plain)
    expect(s.files.map(f => [f.fileId, f.count])).toEqual([['a', 1500], ['b', 1000]])
    expect(s.total).toBe(2500)
    expect(s.files.reduce((n, f) => n + f.results.length, 0)).toBe(MAX_RESULTS)
    expect(s.capped).toBe(true)
    expect(summaryText(s)).toBe('2 000+ results; refine the search')
    expect(replaceLabel(s)).toBe('Replace 2500 in 2 files')
  })

  it('summarizes', () => {
    const s = searchFiles([{ id: 'a', text: 'ab ab' }, { id: 'b', text: 'ab' }], 'ab', plain)
    expect(summaryText(s)).toBe('3 results in 2 files')
    expect(replaceLabel(s)).toBe('Replace 3 in 2 files')
    expect(summaryText(searchFiles([{ id: 'a', text: 'ab' }], 'ab', plain))).toBe('1 result in 1 file')
    expect(summaryText(searchFiles([{ id: 'a', text: 'ab' }], 'zz', plain))).toBe('No results')
  })
})

describe('Ctrl+Z: the operation or the file\'s own undo', () => {
  it('undoes the operation when it is newer than the file\'s last undo item, or the file has none', () => {
    expect(undoChoice(null, null)).toBe('file')
    expect(undoChoice(null, 5)).toBe('file')
    expect(undoChoice(10, null)).toBe('operation')
    expect(undoChoice(10, 5)).toBe('operation')
    expect(undoChoice(10, 20)).toBe('file')
    expect(undoChoice(10, 10)).toBe('file')
  })

  it('stamps the file\'s undo items with their time', () => {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    const um = new Y.UndoManager(text, { captureTimeout: 0 })
    let t = 100
    const stop = stampUndoItems(um, () => t)
    expect(newestUndoTime(um)).toBeNull()
    text.insert(0, 'a')
    expect(newestUndoTime(um)).toBe(100)
    t = 200
    text.insert(1, 'b')
    expect(newestUndoTime(um)).toBe(200)
    um.undo()
    expect(newestUndoTime(um)).toBe(100)
    stop()
  })
})

// ---------- real Yjs docs: you and a co-author ----------

/** Two docs kept in sync, like two tabs through the server; `hold()` queues updates (typing at the same time). */
function pair(initial: string) {
  const you = new Y.Doc()
  const them = new Y.Doc()
  const remote = { name: 'provider' }
  let held = false
  const queue: [Y.Doc, Uint8Array][] = []
  const send = (to: Y.Doc) => (u: Uint8Array, origin: unknown) => {
    if (origin === remote) return
    if (held) queue.push([to, u])
    else Y.applyUpdate(to, u, remote)
  }
  you.on('update', send(them))
  them.on('update', send(you))
  them.getText('content').insert(0, initial)
  return {
    you, them, remote,
    mine: you.getText('content'),
    theirs: them.getText('content'),
    hold: () => { held = true },
    flush: () => {
      held = false
      for (const [to, u] of queue.splice(0)) Y.applyUpdate(to, u, remote)
    },
  }
}

function heldDoc(fileId: string, ytext: Y.Text, left = () => false): HeldDoc & { released: boolean } {
  const h = { fileId, ytext, left, released: false, release: () => { h.released = true } }
  return h
}

function rename(docs: HeldDoc[], from: string, to: string, id = 1): ProjectOperation {
  const r = applyOperation(docs, {
    id, kind: 'rename', label: `${from} → ${to}`, time: Date.now(), replacement: to, rename: { from, to },
    find: text => labelOccurrences(text, from),
  })
  if (!r) throw new Error('nothing renamed')
  return r.op
}

describe('an operation on live docs', () => {
  it('keeps what the co-author types meanwhile and replaces every match exactly', () => {
    const p = pair('\\label{eq:a} see \\ref{eq:a} and \\eqref{eq:a}.\n')
    p.hold()
    // The co-author types while the operation is applied: neither has the other's edit yet.
    p.theirs.insert(0, 'Intro. ')
    p.theirs.insert(p.theirs.length, 'More about eq:a in prose.\n')
    const op = rename([heldDoc('f', p.mine)], 'eq:a', 'eq:law')
    p.flush()
    const want = 'Intro. \\label{eq:law} see \\ref{eq:law} and \\eqref{eq:law}.\nMore about eq:a in prose.\n'
    expect(p.mine.toString()).toBe(want)
    expect(p.theirs.toString()).toBe(want)
    closeOperation(op)
  })

  it('edits only the matches, in one transaction', () => {
    const p = pair('a \\ref{x} b \\ref{x} c')
    const seen: unknown[] = []
    p.you.on('afterTransaction', tr => { if (tr.local) seen.push(tr.origin) })
    const r = applyOperation([heldDoc('f', p.mine)], {
      id: 1, kind: 'replace', label: '', time: 0, replacement: 'yy', find: t => findAll(t, '{x}', { matchCase: true, wholeWord: false }),
    })
    expect(seen).toHaveLength(1)
    expect(p.theirs.toString()).toBe('a \\refyy b \\refyy c')
    expect(r?.places).toBe(2)
  })

  it('skips and releases docs without a match; nothing at all is null', () => {
    const a = pair('\\ref{eq:a}')
    const b = pair('no match here')
    const hb = heldDoc('b', b.mine)
    const op = rename([heldDoc('a', a.mine), hb], 'eq:a', 'eq:b')
    expect(op.files.map(f => f.fileId)).toEqual(['a'])
    expect(hb.released).toBe(true)
    const hc = heldDoc('c', b.mine)
    expect(applyOperation([hc], { id: 2, kind: 'replace', label: '', time: 0, replacement: 'x', find: () => [] })).toBeNull()
    expect(hc.released).toBe(true)
  })

  it('undo reverts only its edits: the co-author\'s stay, and a span they edited since stays as they left it', () => {
    const p = pair('\\label{eq:a}\n\\ref{eq:a}\n\\cref{eq:a}\n\\ref{eq:a}\n')
    const op = rename([heldDoc('f', p.mine)], 'eq:a', 'eq:law')
    // The co-author edits more: elsewhere, inside one renamed name, and replaces another one entirely.
    p.theirs.insert(0, '% top\n')
    const s = p.theirs.toString()
    const second = s.indexOf('eq:law', s.indexOf('\\ref'))
    p.theirs.insert(second + 6, 's') // \ref{eq:laws}
    const third = p.theirs.toString().indexOf('eq:law', p.theirs.toString().indexOf('\\cref'))
    p.theirs.delete(third, 6)
    p.theirs.insert(third, 'fig:z') // \cref{fig:z}
    expect(p.mine.toString()).toBe('% top\n\\label{eq:law}\n\\ref{eq:laws}\n\\cref{fig:z}\n\\ref{eq:law}\n')

    expect(undoOperation(op)).toEqual(['f'])
    closeOperation(op)
    const want = '% top\n\\label{eq:a}\n\\ref{eq:laws}\n\\cref{fig:z}\n\\ref{eq:a}\n'
    expect(p.mine.toString()).toBe(want)
    expect(p.theirs.toString()).toBe(want)
  })

  it('undo restores deletions (an empty replacement) and works across files', () => {
    const a = pair('x foo y foo')
    const b = pair('foo!')
    const r = applyOperation([heldDoc('a', a.mine), heldDoc('b', b.mine)], {
      id: 1, kind: 'replace', label: '', time: 0, replacement: '', find: t => findAll(t, 'foo', { matchCase: false, wholeWord: false }),
    })
    expect(a.theirs.toString()).toBe('x  y ')
    expect(b.theirs.toString()).toBe('!')
    b.theirs.insert(b.theirs.length, '?')
    expect(r && undoOperation(r.op)).toEqual(['a', 'b'])
    expect(a.theirs.toString()).toBe('x foo y foo')
    expect(b.theirs.toString()).toBe('foo!?')
  })

  it('a file that left the operation is skipped by the undo', () => {
    const a = pair('\\ref{eq:a}')
    const b = pair('\\ref{eq:a}')
    let gone = false
    const op = rename([heldDoc('a', a.mine), heldDoc('b', b.mine, () => gone)], 'eq:a', 'eq:b')
    gone = true
    expect(undoOperation(op)).toEqual(['a'])
    expect(a.mine.toString()).toBe('\\ref{eq:a}')
    expect(b.mine.toString()).toBe('\\ref{eq:b}')
  })

  it('the editor\'s own UndoManager never undoes the operation', () => {
    const p = pair('\\label{eq:a} ')
    // Like collab.ts: the editor's undo tracks local typing (origin null) only.
    const own = new Y.UndoManager(p.mine)
    p.mine.insert(p.mine.length, 'typed')
    own.stopCapturing()
    const op = rename([heldDoc('f', p.mine)], 'eq:a', 'eq:b')
    expect(own.undoStack).toHaveLength(1)
    own.undo()
    expect(p.mine.toString()).toBe('\\label{eq:b} ')
    expect(own.canUndo()).toBe(false)
    // And the operation's undo does not undo the typing either.
    own.redo()
    undoOperation(op)
    expect(p.mine.toString()).toBe('\\label{eq:a} typed')
    expect(own.undoStack).toHaveLength(1)
  })

  function replace(docs: HeldDoc[], query: string, replacement: string, id = 1): ProjectOperation {
    const r = applyOperation(docs, {
      id, kind: 'replace', label: '', time: Date.now(), replacement,
      find: t => findAll(t, query, { matchCase: true, wholeWord: false }),
    })
    if (!r) throw new Error('nothing replaced')
    return r.op
  }

  it('undoes each of two operations in a row, the second one first', () => {
    // The second's undo puts the first's text back as new Yjs items: still the first's, for its undo.
    const p = pair('x foo y foo z')
    const op1 = replace([heldDoc('f', p.mine)], 'foo', 'bar', 1)
    const op2 = replace([heldDoc('f', p.mine)], 'bar', 'baz', 2)
    expect(p.theirs.toString()).toBe('x baz y baz z')
    expect(undoOperation(op2)).toEqual(['f'])
    closeOperation(op2)
    expect(p.theirs.toString()).toBe('x bar y bar z')
    expect(undoOperation(op1)).toEqual(['f'])
    closeOperation(op1)
    expect(p.mine.toString()).toBe('x foo y foo z')
    expect(p.theirs.toString()).toBe('x foo y foo z')
  })

  it('text deleted and put back by the file\'s own undo is not an edit: the operation\'s undo reverts it', () => {
    const p = pair('a \\ref{eq:a}\nb \\ref{eq:a}\n')
    const own = new Y.UndoManager(p.mine)
    const op = rename([heldDoc('f', p.mine)], 'eq:a', 'eq:b')
    expect(p.mine.toString()).toBe('a \\ref{eq:b}\nb \\ref{eq:b}\n')
    // You delete the first line, then undo that in the file: the line is back, with new Yjs ids.
    p.mine.delete(0, 'a \\ref{eq:b}\n'.length)
    own.stopCapturing()
    own.undo()
    expect(p.mine.toString()).toBe('a \\ref{eq:b}\nb \\ref{eq:b}\n')
    expect(undoOperation(op)).toEqual(['f'])
    closeOperation(op)
    expect(p.mine.toString()).toBe('a \\ref{eq:a}\nb \\ref{eq:a}\n')
    expect(p.theirs.toString()).toBe('a \\ref{eq:a}\nb \\ref{eq:a}\n')
  })

  it('a span deleted and typed again by hand is still an edit, kept by the undo', () => {
    const p = pair('\\ref{eq:a} \\ref{eq:a}')
    const op = rename([heldDoc('f', p.mine)], 'eq:a', 'eq:b')
    const at = p.theirs.toString().indexOf('eq:b')
    p.theirs.delete(at, 4)
    p.theirs.insert(at, 'eq:b') // the same text, typed: their edit
    undoOperation(op)
    expect(p.mine.toString()).toBe('\\ref{eq:b} \\ref{eq:a}')
  })

  it('refuses the rename undo when the old name is a label again', () => {
    const p = pair('\\label{eq:a}\n\\ref{eq:a}\n')
    const op = rename([heldDoc('f', p.mine)], 'eq:a', 'eq:b')
    expect(renameUndoBlocked(op, [p.mine.toString()])).toBe(false)
    p.theirs.insert(p.theirs.length, '\\ref{eq:a}\n') // a reference is not a label
    expect(renameUndoBlocked(op, [p.mine.toString()])).toBe(false)
    p.theirs.insert(p.theirs.length, '\\label{eq:a}\n')
    expect(renameUndoBlocked(op, ['other file', p.mine.toString()])).toBe(true)
    expect(renameUndoRefusedText('eq:a')).toBe('Can\'t undo the rename: eq:a is now used by another label.')
  })
})

describe('the list of operations', () => {
  afterEach(() => { vi.useRealTimers() })

  function op(id: number, time = Date.now()): ProjectOperation & { closed: () => boolean } {
    const p = pair('\\ref{x}')
    const h = heldDoc('f', p.mine)
    const o = rename([h], 'x', 'y', id)
    return Object.assign(o, { time, closed: () => h.released })
  }

  it('keeps the newest 10, closing the oldest', () => {
    const list = new OperationList()
    const all = Array.from({ length: MAX_OPERATIONS + 1 }, (_, i) => op(i))
    for (const o of all) list.add(o)
    expect(list.size).toBe(MAX_OPERATIONS)
    expect(all[0]?.closed()).toBe(true)
    expect(all[1]?.closed()).toBe(false)
    expect(list.newest()).toBe(all.at(-1))
    list.closeAll()
    expect(all.every(o => o.closed())).toBe(true)
    expect(list.newest()).toBeNull()
  })

  it('drops an operation after an hour', () => {
    vi.useFakeTimers()
    const list = new OperationList()
    const o = op(1)
    list.add(o)
    vi.advanceTimersByTime(OPERATION_TTL - 1)
    expect(list.newest()).toBe(o)
    vi.advanceTimersByTime(1)
    expect(list.newest()).toBeNull()
    expect(o.closed()).toBe(true)
  })

  it('an operation every file of which has left is not offered, and is closed', () => {
    const list = new OperationList()
    const older = op(1)
    const p = pair('\\ref{x}')
    let gone = false
    const h = heldDoc('f', p.mine, () => gone)
    const newer = rename([h], 'x', 'y', 2)
    list.add(older)
    list.add(newer)
    expect(list.newest()).toBe(newer)
    gone = true
    expect(list.newest()).toBe(older)
    expect(h.released).toBe(true)
    expect(list.size).toBe(1)
  })

  it('an expired operation is not offered even before its timer runs', () => {
    let now = 1000
    const list = new OperationList(() => now)
    const o = op(1, 1000)
    list.add(o)
    now += OPERATION_TTL
    expect(list.newest()).toBeNull()
    expect(o.closed()).toBe(true)
  })
})

describe('the toasts', () => {
  it('say the real totals', () => {
    expect(renamedText('eq:basquin', 'eq:basquin-law', 3, 2)).toBe('Renamed eq:basquin to eq:basquin-law: 3 places in 2 files.')
    expect(replacedText(12, 3)).toBe('Replaced 12 in 3 files.')
    expect(undoneText('rename', 2)).toBe('Rename undone in 2 files')
    expect(undoneText('replace', 1)).toBe('Replace undone in 1 file')
  })
})

describe('the doc-sharing rule of ProjectCollab', () => {
  function shared() {
    const log: string[] = []
    let n = 0
    const docs = new SharedDocs<{ name: string; n: number; presence: boolean }>({
      open: name => {
        log.push(`open ${name}`)
        return { name, n: ++n, presence: false }
      },
      close: v => { log.push(`close ${v.name}`) },
      presence: (v, on) => {
        v.presence = on
        log.push(`presence ${v.name} ${on}`)
      },
    })
    return { docs, log }
  }

  it('one doc per name, shared by the editor and operations, closed with the last holder', () => {
    const { docs, log } = shared()
    const editor = docs.acquire('a', true)
    const op = docs.acquire('a', false)
    expect(op.value).toBe(editor.value)
    expect(log).toEqual(['open a', 'presence a true'])
    editor.release()
    expect(log.at(-1)).toBe('presence a false') // still held by the operation: open without presence
    expect(docs.names()).toEqual(['a'])
    op.release()
    op.release() // twice: nothing more
    expect(log.slice(2)).toEqual(['presence a false', 'close a'])
    expect(docs.names()).toEqual([])
  })

  it('operation holders have no presence; the editor turns it on for a doc an operation holds', () => {
    const { docs, log } = shared()
    const op = docs.acquire('a', false)
    expect(op.value.presence).toBe(false)
    const editor = docs.acquire('a', true)
    expect(editor.value.presence).toBe(true)
    op.release()
    expect(editor.value.presence).toBe(true)
    expect(log).toEqual(['open a', 'presence a true'])
    editor.release()
    expect(log.at(-1)).toBe('close a')
  })

  it('a doc opened again after closing is a new one; closeAll closes every doc', () => {
    const { docs, log } = shared()
    const first = docs.acquire('a', false)
    first.release()
    const again = docs.acquire('a', false)
    expect(again.value.n).toBe(2)
    docs.acquire('b', true)
    docs.closeAll()
    expect(docs.names()).toEqual([])
    again.release() // after closeAll: nothing
    expect(log.filter(l => l.startsWith('close'))).toEqual(['close a', 'close a', 'close b'])
  })
})

describe('the Search tab', () => {
  it('Replace all only uses results made for the query and toggles shown now', () => {
    const opts = { matchCase: true, wholeWord: false }
    const searched = { query: 'foo', opts }
    expect(sameSearch(searched, { query: 'foo', opts: { ...opts } })).toBe(true)
    expect(sameSearch(searched, { query: 'fo', opts })).toBe(false)
    expect(sameSearch(searched, { query: 'foo', opts: { ...opts, matchCase: false } })).toBe(false)
    expect(sameSearch(searched, { query: 'foo', opts: { ...opts, wholeWord: true } })).toBe(false)
  })

  it('is a remembered sidebar tab', () => {
    expect(parsePrefs(JSON.stringify({ sidebar: 'search' })).sidebar).toBe('search')
    expect(parsePrefs(JSON.stringify({ sidebar: 'nope' })).sidebar).toBe('files')
  })

  it('opens with Ctrl+Shift+F (Cmd+Shift+F), not Ctrl+F', () => {
    const k = { key: 'F', code: 'KeyF', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }
    expect(isSearchAllShortcut(k)).toBe(true)
    expect(isSearchAllShortcut({ ...k, ctrlKey: false, metaKey: true })).toBe(true)
    expect(isSearchAllShortcut({ ...k, key: 'а', code: 'KeyF' })).toBe(true)
    expect(isSearchAllShortcut({ ...k, shiftKey: false, key: 'f' })).toBe(false)
    expect(isSearchAllShortcut({ ...k, altKey: true })).toBe(false)
  })
})
