<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type * as Y from 'yjs'
  import type { Awareness } from 'y-protocols/awareness'
  import { EditorState, Prec } from '@codemirror/state'
  import {
    EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
    highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
  } from '@codemirror/view'
  import { defaultKeymap, indentWithTab } from '@codemirror/commands'
  import {
    StreamLanguage, bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting,
  } from '@codemirror/language'
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
  import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
  import { lintKeymap } from '@codemirror/lint'
  import { stex } from '@codemirror/legacy-modes/mode/stex'
  import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'

  interface Props {
    ytext: Y.Text
    awareness: Awareness
    undoManager: Y.UndoManager
    readOnly: boolean
    /** Ctrl/Cmd+S */
    onSave?: () => void
  }

  let { ytext, awareness, undoManager, readOnly, onSave }: Props = $props()

  let host: HTMLDivElement
  let view: EditorView | undefined

  /** Move the cursor to a 1-based line and scroll it into view. */
  export function gotoLine(line: number): void {
    if (!view) return
    const n = Math.min(Math.max(1, line), view.state.doc.lines)
    const pos = view.state.doc.line(n).from
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    view.focus()
  }

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
      Prec.high(keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true } },
        ...yUndoManagerKeymap,
      ])),
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
</style>
