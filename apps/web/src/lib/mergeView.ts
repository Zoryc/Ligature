/** Read-only CodeMirror setup shared by the side-by-side merge views (history comparison, recovery dialog). */
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { StreamLanguage, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { isLatexLike } from './history.ts'

export function readOnlyExtensions(path: string): Extension[] {
  const ext: Extension[] = [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    lineNumbers(),
    EditorView.lineWrapping,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  ]
  if (isLatexLike(path)) ext.push(StreamLanguage.define(stex))
  return ext
}

export interface MergeHandle { destroy(): void }

/** A read-only side-by-side merge view of `a` (left) and `b` (right); @codemirror/merge is loaded lazily. */
export async function mountMergeView(parent: HTMLElement, path: string, a: string, b: string): Promise<MergeHandle> {
  const mod = await import('@codemirror/merge')
  parent.replaceChildren()
  return new mod.MergeView({
    a: { doc: a, extensions: readOnlyExtensions(path) },
    b: { doc: b, extensions: readOnlyExtensions(path) },
    parent,
    gutter: true,
    highlightChanges: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  })
}
