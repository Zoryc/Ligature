<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type * as Y from 'yjs'
  import type { Awareness } from 'y-protocols/awareness'
  import { EditorState, Prec, StateEffect, StateField } from '@codemirror/state'
  import {
    Decoration, EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
    highlightSpecialChars, keymap, lineNumbers, rectangularSelection, type DecorationSet,
  } from '@codemirror/view'
  import { defaultKeymap, indentWithTab } from '@codemirror/commands'
  import {
    StreamLanguage, bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting,
  } from '@codemirror/language'
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
  import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
  import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic as LintDiagnostic } from '@codemirror/lint'
  import { stex } from '@codemirror/legacy-modes/mode/stex'
  import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
  import type { EditorDiagnostic } from './diagnostics.ts'

  interface Props {
    ytext: Y.Text
    awareness: Awareness
    undoManager: Y.UndoManager
    readOnly: boolean
    /** Diagnostics of the last build for this file (gutter markers + underlines; hover shows the message). */
    diagnostics?: EditorDiagnostic[]
  }

  let { ytext, awareness, undoManager, readOnly, diagnostics = [] }: Props = $props()

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

  /** Move the cursor to a 1-based line and scroll it into view; `flash` highlights the line for a moment. */
  export function gotoLine(line: number, flash = false): void {
    if (!view) return
    const n = Math.min(Math.max(1, line), view.state.doc.lines)
    const pos = view.state.doc.line(n).from
    const effects: StateEffect<unknown>[] = [EditorView.scrollIntoView(pos, { y: 'center' })]
    if (flash) effects.push(flashEffect.of(null), flashEffect.of(pos))
    view.dispatch({ selection: { anchor: pos }, effects })
    view.focus()
    if (flash) {
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => {
        flashTimer = null
        view?.dispatch({ effects: flashEffect.of(null) })
      }, 1600)
    }
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

  onMount(() => {
    // Same as codemirror's basicSetup, minus history(): undo/redo goes through the Y.UndoManager
    // so that only local edits are undone, never a collaborator's.
    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      StreamLanguage.define(stex),
      // In LaTeX, ' and " are not paired quotes: only auto-close brackets.
      EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{'] } }]),
      EditorView.lineWrapping,
      // Ctrl/Cmd+S (compile) and Ctrl+Alt+J (show in PDF) are handled by the project page for the whole window.
      Prec.high(keymap.of(yUndoManagerKeymap)),
      lintGutter(),
      flashField,
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
  })

  onDestroy(() => {
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
  }
  .editor :global(.cm-editor) {
    height: 100%;
  }
  .editor :global(.cm-scroller) {
    font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
    font-size: 14px;
  }
  .editor :global(.cm-flash-line) {
    animation: ligature-flash-line 1.6s ease-out;
  }
  @keyframes -global-ligature-flash-line {
    from { background-color: rgba(255, 200, 0, 0.6); }
    to { background-color: transparent; }
  }
</style>
