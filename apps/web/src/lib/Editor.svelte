<script lang="ts" module>
/** What the rename box shows and does; `value` keeps what is typed if CodeMirror draws the box again. */
export interface RenameBox {
  /** The label's name where F2 was pressed: the box goes under its line. */
  to: number
  name: string
  /** "3 places in 2 files". */
  count: string
  /** The warning for a name (null: it can be used). */
  check: (name: string) => string | null
  /** Enter with a usable name (trimmed). */
  onRename: (name: string) => void
  value?: string
}
</script>

<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type * as Y from 'yjs'
  import type { Awareness } from 'y-protocols/awareness'
  import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
  import {
    Decoration, EditorView, WidgetType, crosshairCursor, drawSelection, dropCursor, highlightActiveLine,
    highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection, type DecorationSet,
  } from '@codemirror/view'
  import { defaultKeymap, indentWithTab } from '@codemirror/commands'
  import {
    HighlightStyle, StreamLanguage, bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting,
  } from '@codemirror/language'
  import { tags } from '@lezer/highlight'
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
  import {
    autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionSource,
  } from '@codemirror/autocomplete'
  import {
    forEachDiagnostic, lintGutter, lintKeymap, setDiagnostics, setDiagnosticsEffect, type Diagnostic as LintDiagnostic,
  } from '@codemirror/lint'
  import { stex } from '@codemirror/legacy-modes/mode/stex'
  import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
  import type { EditorDiagnostic } from './diagnostics.ts'
  import { isSearchAllShortcut } from './shortcuts.ts'
  import type { Explanation, QuickFix } from './explain.ts'
  import { caretAt, jumpModifier, type Target } from './latex/definitions.ts'

  interface Props {
    ytext: Y.Text
    awareness: Awareness
    undoManager: Y.UndoManager
    readOnly: boolean
    /** Diagnostics of the last build for this file (gutter markers + underlines; hover shows the message). */
    diagnostics?: EditorDiagnostic[]
    /** Font size of the source in px (personal setting). */
    fontSize?: number
    /** Wrap long lines at the editor's edge (personal setting). */
    wrap?: boolean
    /** Plain-language explanation of a problem, shown under its line while the cursor is on it. */
    explain?: (d: { message: string; severity: string; source?: string }) => Explanation | null
    /** The quick-fix button of an explanation was pressed. */
    onFix?: (fix: QuickFix) => void
    /** The main cursor moved (1-based line, 1-based column). */
    onCursor?: (line: number, column: number) => void
    /** LaTeX suggestions (latex/latexCompletion.ts); read once when the editor is created. */
    completion?: CompletionSource
    /** Go to definition (docs/GO-TO-DEFINITION.md): the target at a document position, or null. */
    definitionAt?: (state: EditorState, pos: number) => Target | null
    /** A target was Ctrl/Cmd+clicked. */
    onGoToDefinition?: (target: Target) => void
    /**
     * Ctrl/Cmd+Z, before the file's own undo: true when the page undid something else (a project operation,
     * docs/RENAME-AND-REPLACE.md §3), false to let the file's own undo run.
     */
    onUndo?: () => boolean
    /** F2 (docs/RENAME-AND-REPLACE.md §4): the cursor's line, the cursor's offset in it, and where the line starts. */
    onRename?: (line: string, col: number, from: number) => void
  }

  let {
    ytext, awareness, undoManager, readOnly, diagnostics = [], fontSize = 14, wrap = true, explain, onFix, onCursor,
    completion, definitionAt, onGoToDefinition, onUndo, onRename,
  }: Props = $props()

  let host: HTMLDivElement
  let view: EditorView | undefined = $state.raw(undefined)

  // A line highlighted for a moment (after a jump from the PDF or the problems list).
  const flashEffect = StateEffect.define<number | null>()
  const flashDecoration = Decoration.line({ class: 'cm-flash-line' })
  const flashField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      let d = deco.map(tr.changes)
      for (const e of tr.effects) {
        if (e.is(flashEffect)) d = e.value === null ? Decoration.none : Decoration.set([flashDecoration.range(e.value)])
      }
      return d
    },
    provide: f => EditorView.decorations.from(f),
  })
  let flashTimer: ReturnType<typeof setTimeout> | null = null

  // ---------- inline explanation of the problem under the cursor (Folio) ----------

  class ExplainWidget extends WidgetType {
    readonly severity: string
    readonly message: string
    readonly ex: Explanation
    constructor(severity: string, message: string, ex: Explanation) {
      super()
      this.severity = severity
      this.message = message
      this.ex = ex
    }
    override eq(o: ExplainWidget) { return o.message === this.message && o.ex.text === this.ex.text && o.severity === this.severity }
    toDOM() {
      const box = document.createElement('div')
      box.className = `cm-explain cm-explain-${this.severity}`
      const text = document.createElement('div')
      text.className = 'cm-explain-text'
      const title = document.createElement('strong')
      title.textContent = this.message
      const body = document.createElement('span')
      body.textContent = this.ex.text
      text.append(title, body)
      box.append(text)
      const fix = this.ex.fix
      if (fix && !readOnly) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'cm-explain-fix'
        b.textContent = fix.label
        b.addEventListener('mousedown', e => e.preventDefault())
        b.addEventListener('click', () => onFix?.(fix))
        box.append(b)
      }
      return box
    }
    override ignoreEvent() { return true }
  }

  function explainDecorations(state: EditorState): DecorationSet {
    if (!explain) return Decoration.none
    const line = state.doc.lineAt(state.selection.main.head)
    let found: { d: LintDiagnostic; from: number; to: number } | null = null
    forEachDiagnostic(state, (d, from, to) => {
      if (found && (found.d.severity === 'error' || d.severity !== 'error')) return
      const a = state.doc.lineAt(from).number
      const b = state.doc.lineAt(Math.max(from, to - (to > from ? 1 : 0))).number
      if (line.number >= a && line.number <= b) found = { d, from, to }
    })
    const f = found as { d: LintDiagnostic; from: number; to: number } | null
    if (!f) return Decoration.none
    const ex = explain({ message: f.d.message, severity: f.d.severity, ...(f.d.source ? { source: f.d.source } : {}) })
    const sev = f.d.severity === 'error' ? 'error' : 'warning'
    const first = state.doc.lineAt(f.from)
    const last = state.doc.lineAt(Math.max(f.from, f.to - (f.to > f.from ? 1 : 0)))
    const ranges = [Decoration.line({ class: `cm-problem-line cm-problem-${sev}` }).range(first.from)]
    if (ex) ranges.push(Decoration.widget({ widget: new ExplainWidget(sev, f.d.message, ex), block: true, side: 1 }).range(last.to))
    return Decoration.set(ranges, true)
  }

  // Block widgets must come from a state field (not a view plugin).
  const explainField = StateField.define<DecorationSet>({
    create: explainDecorations,
    update(deco, tr) {
      const diagsChanged = tr.effects.some(e => e.is(setDiagnosticsEffect))
      if (tr.docChanged || tr.selection || diagsChanged) return explainDecorations(tr.state)
      return deco
    },
    provide: f => EditorView.decorations.from(f),
  })

  // ---------- rename a label: the box under the line (docs/RENAME-AND-REPLACE.md §4) ----------

  const renameEffect = StateEffect.define<RenameBox | null>()

  class RenameWidget extends WidgetType {
    readonly box: RenameBox
    constructor(box: RenameBox) {
      super()
      this.box = box
    }
    override eq(o: RenameWidget) { return o.box === this.box }
    toDOM(v: EditorView) {
      const box = this.box
      const el = document.createElement('div')
      el.className = 'cm-rename'
      const label = document.createElement('label')
      label.className = 'cm-rename-field'
      const title = document.createElement('span')
      title.textContent = 'Rename label'
      const input = document.createElement('input')
      input.type = 'text'
      input.spellcheck = false
      input.value = box.value ?? box.name
      input.setAttribute('aria-describedby', 'cm-rename-warning')
      label.append(title, input)
      const count = document.createElement('span')
      count.className = 'cm-rename-count'
      count.textContent = box.count
      const warning = document.createElement('span')
      warning.className = 'cm-rename-warning'
      warning.id = 'cm-rename-warning'
      warning.setAttribute('role', 'status')
      const hint = document.createElement('span')
      hint.className = 'cm-rename-hint'
      hint.textContent = 'Enter renames · Esc cancels'
      el.append(label, count, warning, hint)

      const problem = () => {
        const name = input.value.trim()
        return name === box.name ? null : box.check(input.value)
      }
      const show = () => {
        const p = problem()
        warning.textContent = p ?? ''
        warning.hidden = !p
        el.classList.toggle('cm-rename-bad', !!p)
      }
      const close = (focusEditor: boolean) => {
        if (v.state.field(renameField).box !== box) return
        v.dispatch({ effects: renameEffect.of(null) })
        if (focusEditor) v.focus()
      }
      input.addEventListener('input', () => {
        box.value = input.value
        show()
      })
      input.addEventListener('keydown', e => {
        // The box's keys are its own: not the editor's keymap, nor the page's shortcuts.
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          close(true)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          if (problem()) return
          const name = input.value.trim()
          close(true)
          if (name !== box.name) box.onRename(name)
        }
      })
      // A click inside the box (its title, count, warning, hint) is not outside: keep the focus in the input.
      // Otherwise the browser would move it to the editor around the box, and the blur below would cancel.
      el.addEventListener('mousedown', e => {
        if (e.target === input) return
        e.preventDefault()
        input.focus()
      })
      // Clicking outside cancels; later, since the blur may come from CodeMirror redrawing the box.
      input.addEventListener('blur', () => {
        setTimeout(() => { if (input.isConnected && document.activeElement !== input) close(false) }, 0)
      })
      show()
      requestAnimationFrame(() => {
        input.focus()
        if (box.value === undefined) input.select()
      })
      return el
    }
    override ignoreEvent() { return true }
  }

  const renameField = StateField.define<{ box: RenameBox | null; deco: DecorationSet }>({
    create: () => ({ box: null, deco: Decoration.none }),
    update(value, tr) {
      let v = tr.docChanged ? { box: value.box, deco: value.deco.map(tr.changes) } : value
      for (const e of tr.effects) {
        if (!e.is(renameEffect)) continue
        const box = e.value
        v = box
          ? {
              box,
              deco: Decoration.set([
                Decoration.widget({ widget: new RenameWidget(box), block: true, side: 1 })
                  .range(tr.state.doc.lineAt(Math.min(box.to, tr.state.doc.length)).to),
              ]),
            }
          : { box: null, deco: Decoration.none }
      }
      return v
    },
    provide: f => EditorView.decorations.from(f, v => v.deco),
  })

  /** Show the rename box under the label's line. */
  export function showRename(box: RenameBox): void {
    if (!view) return
    const pos = Math.min(box.to, view.state.doc.length)
    view.dispatch({ effects: [renameEffect.of(box), EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 80 })] })
    // The widget is in the DOM once dispatch returns: focus it now, so the very next key goes to the box (the
    // widget's own requestAnimationFrame focus stays as a fallback; frames do not run in a background tab).
    const input = view.dom.querySelector<HTMLInputElement>('.cm-rename input')
    if (input && document.activeElement !== input) {
      input.focus()
      if (box.value === undefined) input.select()
    }
  }

  // ---------- go to definition: Ctrl/Cmd+click, and the link underline while the modifier is held ----------

  /**
   * The modifier of go to definition, and of CodeMirror's own add-a-cursor click: Cmd on macOS, else Ctrl,
   * without Alt or Shift. The click and the hint share this test, so the underline never promises a jump.
   */
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const modifierHeld = (e: MouseEvent | KeyboardEvent) => jumpModifier(e, mac)

  // A decoration only: nothing is written to the document, synced or added to undo.
  const linkEffect = StateEffect.define<{ from: number; to: number } | null>()
  const linkMark = Decoration.mark({ class: 'cm-definition-link' })
  const linkField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      let d = deco.map(tr.changes)
      for (const e of tr.effects) {
        if (e.is(linkEffect)) d = e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none
      }
      return d
    },
    provide: f => EditorView.decorations.from(f),
  })
  /** The mouse over the text (null: elsewhere), so pressing the modifier without moving shows the link too. */
  let pointer: { x: number; y: number } | null = null

  /** The target under a screen point, only when the point is over it (not past the end of its line). */
  function targetUnder(v: EditorView, x: number, y: number): Target | null {
    if (!definitionAt) return null
    const pos = v.posAtCoords({ x, y })
    if (pos === null) return null
    const t = definitionAt(v.state, pos)
    if (!t || t.from >= t.to) return null
    const a = v.coordsAtPos(t.from, 1)
    const b = v.coordsAtPos(t.to, -1)
    if (!a || !b || y < Math.min(a.top, b.top) || y > Math.max(a.bottom, b.bottom)) return null
    // posAtCoords snaps to the nearest character: beyond the line's end it gives the end, which a target may touch.
    if (a.top === b.top && (x < a.left || x > b.right)) return null
    return t
  }

  function setLink(v: EditorView, t: { from: number; to: number } | null) {
    const shown = v.state.field(linkField).iter()
    const same = shown.value ? !!t && shown.from === t.from && shown.to === t.to : !t
    if (!same) v.dispatch({ effects: linkEffect.of(t ? { from: t.from, to: t.to } : null) })
  }

  function refreshLink(v: EditorView, held: boolean) {
    setLink(v, held && pointer ? targetUnder(v, pointer.x, pointer.y) : null)
  }

  // Before CodeMirror's own mouse handling: a Ctrl/Cmd+click on a target jumps instead of adding a cursor.
  const goToDefinition = Prec.highest(EditorView.domEventHandlers({
    mousedown(e, v) {
      if (e.button !== 0 || !modifierHeld(e) || !onGoToDefinition) return false
      const t = targetUnder(v, e.clientX, e.clientY)
      if (!t) return false // anything else: CodeMirror adds a cursor, as before
      e.preventDefault()
      // Returning true skips CodeMirror's click handling, so the caret is moved here: Back returns to the click.
      v.dispatch(caretAt(t), { effects: linkEffect.of(null) })
      onGoToDefinition(t)
      return true
    },
    mousemove(e, v) {
      pointer = { x: e.clientX, y: e.clientY }
      refreshLink(v, modifierHeld(e))
      return false
    },
    mouseleave(_e, v) {
      pointer = null
      setLink(v, null)
      return false
    },
  }))

  // The modifier may go down or up while the mouse rests, and the editor need not have the focus: listen on
  // the window. A blurred window never sees the key go up, so blur clears the link too.
  function onModifierKey(e: KeyboardEvent) {
    if (view) refreshLink(view, modifierHeld(e))
  }
  function onWindowBlur() {
    if (view) setLink(view, null)
  }

  // ---------- Folio look ----------

  const folioHighlight = HighlightStyle.define([
    { tag: tags.tagName, color: 'var(--syn-command)' },
    { tag: tags.atom, color: 'var(--syn-env)' },
    { tag: tags.keyword, color: 'var(--syn-math)' },
    { tag: tags.number, color: 'var(--ink)' },
    { tag: tags.string, color: 'var(--syn-key)' },
    { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
    { tag: tags.bracket, color: 'var(--ink-3)' },
    { tag: tags.invalid, color: 'var(--red)' },
  ])

  const look = new Compartment()
  const wrapping = new Compartment()

  function lookFor(size: number): Extension {
    return EditorView.theme({
      '.cm-scroller': { fontSize: `${size}px` },
    })
  }

  $effect(() => {
    const v = view
    const size = fontSize
    if (v) v.dispatch({ effects: look.reconfigure(lookFor(size)) })
  })
  $effect(() => {
    const v = view
    const w = wrap
    if (v) v.dispatch({ effects: wrapping.reconfigure(w ? EditorView.lineWrapping : []) })
  })

  /**
   * Move the cursor to a 1-based line (and 0-based column, kept within the line) and scroll it into view;
   * `flash` highlights the line for a moment; `length` selects that many characters from there (a search result).
   */
  export function gotoLine(line: number, flash = false, column = 0, length = 0): void {
    if (!view) return
    const n = Math.min(Math.max(1, line), view.state.doc.lines)
    const l = view.state.doc.line(n)
    const pos = l.from + Math.min(Math.max(0, column), l.length)
    const head = Math.min(pos + Math.max(0, length), view.state.doc.length)
    const effects: StateEffect<unknown>[] = [EditorView.scrollIntoView(pos, { y: 'center' })]
    if (flash) effects.push(flashEffect.of(null), flashEffect.of(l.from))
    view.dispatch({ selection: { anchor: pos, head }, effects })
    view.focus()
    if (flash) {
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => {
        flashTimer = null
        view?.dispatch({ effects: flashEffect.of(null) })
      }, 1600)
    }
  }

  /** The text in the editor now. */
  export function text(): string | null {
    return view ? view.state.doc.toString() : null
  }

  /** The selected text when the selection is on one line ('' otherwise). */
  export function selectedLine(): string {
    if (!view) return ''
    const { from, to } = view.state.selection.main
    const s = view.state.sliceDoc(from, to)
    return s.includes('\n') ? '' : s
  }

  /** Insert text as a local edit (undoable, synced) and flash its line. False when read-only or not ready. */
  export function insertText(at: number, insert: string): boolean {
    if (!view || readOnly) return false
    const pos = Math.min(Math.max(0, at), view.state.doc.length)
    view.dispatch({ changes: { from: pos, insert }, userEvent: 'input.quickfix' })
    gotoLine(view.state.doc.lineAt(pos).number, true)
    return true
  }

  /** The main cursor: 1-based line, 0-based column. */
  export function cursor(): { line: number; column: number } | null {
    if (!view) return null
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    return { line: line.number, column: head - line.from }
  }

  function toLint(list: EditorDiagnostic[], length: number): LintDiagnostic[] {
    return list.map(d => {
      const from = Math.min(Math.max(0, d.from), length)
      return {
        from, to: Math.min(Math.max(from, d.to), length), severity: d.severity, message: d.message,
        ...(d.source ? { source: d.source } : {}),
      }
    })
  }

  $effect(() => {
    const list = diagnostics
    const v = view
    if (v) v.dispatch(setDiagnostics(v.state, toLint(list, v.state.doc.length)))
  })

  function reportCursor(state: EditorState) {
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    onCursor?.(line.number, head - line.from + 1)
  }

  onMount(() => {
    // Same as codemirror's basicSetup, minus history(): undo/redo goes through the Y.UndoManager
    // so that only local edits are undone, never a collaborator's.
    const extensions = [
      goToDefinition,
      linkField,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      foldGutter({
        markerDOM: open => {
          const el = document.createElement('span')
          el.className = `cm-fold-marker${open ? ' open' : ''}`
          el.textContent = open ? '▾' : '▸'
          return el
        },
      }),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(folioHighlight),
      bracketMatching(),
      closeBrackets(),
      // Our LaTeX source replaces the language's (stex has none); the keymap below stays as it was.
      autocompletion(completion ? { override: [completion], icons: false } : {}),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      StreamLanguage.define(stex),
      // In LaTeX, ' and " are not paired quotes: only auto-close brackets.
      EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{'] } }]),
      wrapping.of(wrap ? EditorView.lineWrapping : []),
      look.of(lookFor(fontSize)),
      // Ctrl/Cmd+S (compile) and Ctrl+Alt+J (show in PDF) are handled by the project page for the whole window.
      // Before the file's own undo: Ctrl+Z may undo a project operation instead (docs/RENAME-AND-REPLACE.md §3).
      Prec.highest(keymap.of([
        { key: 'Mod-z', run: () => onUndo?.() ?? false },
        {
          key: 'F2',
          run: v => {
            if (!onRename) return false
            const head = v.state.selection.main.head
            const line = v.state.doc.lineAt(head)
            onRename(line.text, head - line.from, line.from)
            return true
          },
        },
      ])),
      // Ctrl+Shift+F is "search in all files": the project page opens the Search tab (the event still bubbles
      // to its window listener). Claimed before any keymap, else CodeMirror falls back to its unshifted Mod-f
      // and opens its own find bar as well; a keymap entry does not match the shifted "F".
      Prec.highest(EditorView.domEventHandlers({ keydown: e => isSearchAllShortcut(e) })),
      Prec.high(keymap.of(yUndoManagerKeymap)),
      lintGutter(),
      flashField,
      explainField,
      renameField,
      EditorView.updateListener.of(u => { if (u.selectionSet || u.docChanged) reportCursor(u.state) }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
      yCollab(ytext, awareness, { undoManager }),
      // Read-only, but still focusable (EditorView.editable stays true), so viewers can use
      // Ctrl+F search, keyboard navigation and selection. CodeMirror ignores DOM edits when
      // readOnly is set, and the server drops updates from read-only connections anyway.
      EditorState.readOnly.of(readOnly),
    ]
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: ytext.toString(), extensions }),
    })
    reportCursor(view.state)
    window.addEventListener('keydown', onModifierKey)
    window.addEventListener('keyup', onModifierKey)
    window.addEventListener('blur', onWindowBlur)
  })

  onDestroy(() => {
    window.removeEventListener('keydown', onModifierKey)
    window.removeEventListener('keyup', onModifierKey)
    window.removeEventListener('blur', onWindowBlur)
    if (flashTimer) clearTimeout(flashTimer)
    view?.destroy()
    view = undefined
  })
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    height: 100%;
    overflow: hidden;
    background: var(--sheet);
  }
  .editor :global(.cm-editor) {
    height: 100%;
    color: var(--ink);
    background: var(--sheet);
  }
  .editor :global(.cm-editor.cm-focused) { outline: none; }
  .editor :global(.cm-scroller) {
    font-family: var(--font-mono);
    line-height: 1.6;
  }
  .editor :global(.cm-content) { padding: 10px 0 40vh; caret-color: var(--ink); }
  .editor :global(.cm-line) { padding: 0 16px 0 12px; }
  .editor :global(.cm-gutters) {
    background: var(--sheet);
    border-right: 1px solid var(--rule-soft);
    color: var(--ink-4);
  }
  .editor :global(.cm-lineNumbers .cm-gutterElement) { padding: 0 10px 0 14px; min-width: 44px; font-variant-numeric: tabular-nums; }
  .editor :global(.cm-activeLineGutter) { background: var(--paper-2); color: var(--ink); }
  .editor :global(.cm-activeLine) { background: rgba(236, 231, 221, 0.55); }
  .editor :global(.cm-selectionBackground) { background: #D9E6E3 !important; }
  .editor :global(.cm-focused .cm-selectionBackground) { background: #C7DCD8 !important; }
  .editor :global(.cm-cursor) { border-left: 2px solid var(--ink); }
  .editor :global(.cm-matchingBracket) { background: var(--teal-tint); outline: 1px solid var(--teal-edge); color: inherit; }
  .editor :global(.cm-selectionMatch) { background: #EFE7C9; }
  .editor :global(.cm-fold-marker) { color: var(--ink-4); cursor: pointer; padding: 0 3px; font-size: 11px; }
  .editor :global(.cm-foldPlaceholder) { background: var(--paper-2); border: 1px solid var(--rule-strong); border-radius: 0; color: var(--ink-3); }

  /* Problems: square marks in the gutter, wavy underline in the text */
  .editor :global(.cm-gutter-lint) { width: 18px; }
  .editor :global(.cm-gutter-lint .cm-gutterElement) { padding: 0; display: flex; align-items: center; justify-content: center; }
  .editor :global(.cm-lint-marker) { width: 12px; height: 12px; content: none; }
  .editor :global(.cm-lint-marker-error) {
    background: var(--red) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3.5 3.5l5 5M8.5 3.5l-5 5' stroke='white' stroke-width='1.6'/%3E%3C/svg%3E") center / 12px no-repeat;
  }
  .editor :global(.cm-lint-marker-warning) {
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M6 1L11.5 11H0.5Z' fill='%23A86E00'/%3E%3Cpath d='M6 4.5v3.2M6 8.6v1' stroke='white' stroke-width='1.3'/%3E%3C/svg%3E") center / 12px no-repeat;
  }
  .editor :global(.cm-lint-marker-info) { background: var(--ink-4); width: 8px; height: 8px; }
  .editor :global(.cm-lintRange-error) {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='M0 3 L1.5 0 L3 3 L4.5 0 L6 3' fill='none' stroke='%23B3261E' stroke-width='1'/%3E%3C/svg%3E");
  }
  .editor :global(.cm-lintRange-warning) {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='M0 3 L1.5 0 L3 3 L4.5 0 L6 3' fill='none' stroke='%23A86E00' stroke-width='1'/%3E%3C/svg%3E");
  }
  .editor :global(.cm-tooltip) { border: 1px solid var(--rule-strong); background: var(--sheet); border-radius: 0; box-shadow: var(--shadow); }
  .editor :global(.cm-tooltip-lint) { font-family: var(--font-ui); font-size: 12.5px; }
  .editor :global(.cm-diagnostic) { padding: 5px 10px; border-left-width: 3px; }
  .editor :global(.cm-diagnostic-error) { border-left-color: var(--red); }
  .editor :global(.cm-diagnostic-warning) { border-left-color: var(--amber-mark); }
  .editor :global(.cm-tooltip-autocomplete > ul) { font-family: var(--font-mono); font-size: 12.5px; max-height: 16em; }
  .editor :global(.cm-tooltip-autocomplete > ul > li) { padding: 2px 10px 2px 8px; }
  .editor :global(.cm-completionMatchedText) { text-decoration: none; font-weight: 600; }
  .editor :global(.cm-completionDetail) { font-family: var(--font-ui); font-style: normal; font-size: 11.5px; color: var(--ink-3); margin-left: 1.2em; }
  .editor :global(.cm-completionInfo) { font-family: var(--font-ui); font-size: 12px; padding: 5px 9px; max-width: 360px; }
  .editor :global(.cm-tooltip-autocomplete > ul > li[aria-selected]) { background: var(--teal); color: #FFFFFF; }
  .editor :global(.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail) { color: rgba(255, 255, 255, 0.8); }
  .editor :global(.cm-snippetField) { background: var(--teal-tint); outline: 1px dotted var(--teal-edge); }
  .editor :global(.cm-panels) { background: var(--paper); border-color: var(--rule); color: var(--ink); }
  .editor :global(.cm-panels input), .editor :global(.cm-panels button) { min-height: 24px; font-size: 12px; }
  .editor :global(.cm-searchMatch) { background: #F3E3A6; outline: 1px solid #D9B94F; }
  .editor :global(.cm-searchMatch-selected) { background: #EBC75A; }

  .editor :global(.cm-problem-error) { background: var(--red-tint); }
  .editor :global(.cm-problem-warning) { background: var(--amber-tint); }
  .editor :global(.cm-explain) {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 0;
    padding: 8px 16px 9px 12px;
    font-family: var(--font-ui);
    font-size: 12.5px;
    line-height: 1.4;
    border-top: 1px solid var(--red-rule);
    border-bottom: 1px solid var(--red-rule);
    background: var(--red-tint);
  }
  .editor :global(.cm-explain-warning) { background: var(--amber-tint); border-color: var(--amber-rule); }
  .editor :global(.cm-explain-text) { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .editor :global(.cm-explain-text strong) { color: var(--red); font-weight: 600; font-family: var(--font-ui); }
  .editor :global(.cm-explain-warning .cm-explain-text strong) { color: var(--amber); }
  .editor :global(.cm-explain-text span) { color: var(--ink-2); }
  .editor :global(.cm-explain-fix) {
    flex: none;
    font: 500 12px/1 var(--font-mono);
    min-height: 26px;
    padding: 0 10px;
    border: 1px solid var(--rule-strong);
    background: var(--sheet);
    color: var(--ink);
    cursor: pointer;
  }
  .editor :global(.cm-explain-fix:hover) { background: var(--paper-2); }

  /* Rename a label (F2): a box under the label's line */
  .editor :global(.cm-rename) {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 14px;
    padding: 8px 16px 9px 12px;
    font-family: var(--font-ui);
    font-size: 12.5px;
    line-height: 1.4;
    border-top: 1px solid var(--teal-edge);
    border-bottom: 1px solid var(--teal-edge);
    background: var(--teal-tint);
  }
  .editor :global(.cm-rename-field) { display: flex; align-items: center; gap: 8px; color: var(--ink-2); font-weight: 500; }
  .editor :global(.cm-rename-field input) { width: 260px; min-height: 26px; font: 400 12.5px/1 var(--font-mono); }
  .editor :global(.cm-rename-count) { color: var(--ink-3); }
  .editor :global(.cm-rename-warning) { color: var(--red); font-weight: 500; }
  .editor :global(.cm-rename-bad .cm-rename-field input) { border-color: var(--red); box-shadow: inset 0 0 0 1px var(--red); }
  .editor :global(.cm-rename-hint) { margin-left: auto; color: var(--ink-4); font-size: 12px; }

  /* Collaborators' cursors (y-codemirror): square name flags */
  .editor :global(.cm-ySelectionInfo) {
    font: 600 10.5px/1 var(--font-ui);
    padding: 3px 5px;
    border-radius: 0;
    opacity: 1;
    top: -1.35em;
  }
  .editor :global(.cm-ySelectionCaret) { border-left-width: 2px; }

  /* Go to definition: the target under the mouse while Ctrl/Cmd is held, like a link */
  .editor :global(.cm-definition-link) {
    color: var(--teal);
    text-decoration: underline;
    text-decoration-color: var(--teal);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .editor :global(.cm-definition-link *) { color: inherit; cursor: pointer; }

  .editor :global(.cm-flash-line) {
    animation: ligature-flash-line 1.6s ease-out;
  }
  @keyframes -global-ligature-flash-line {
    from { background-color: rgba(240, 200, 60, 0.55); }
    to { background-color: transparent; }
  }
</style>
