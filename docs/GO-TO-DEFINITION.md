# Go to definition

Ctrl+click (Cmd+click on macOS) on a name in the editor jumps to where it is defined in the project, like
"Go to Definition" in Visual Studio. Uses the project index of autocomplete (docs/AUTOCOMPLETE.md); all in the
browser.

## Targets

| Under the mouse / cursor | Goes to |
|---|---|
| A label inside `\ref{…}`, `\eqref`, `\pageref`, `\autoref`, `\nameref`, `\cref`, `\Cref`, `\vref` (each key of `\cref{a,b}` separately) | The line of `\label{that-label}` (file opened if needed) |
| A key inside `\cite{…}` and its variants (each key of `\cite{a,b}` separately, also after `[…]` arguments) | The line of `@type{that-key,` in the `.bib` file |
| The path in `\input{…}`, `\include{…}`, `\subfile{…}` | That file, at its first line (resolved like the Contents outline: relative to the main file's folder, with or without `.tex`) |
| The path in `\includegraphics[…]{…}` | The image preview of that file (also without extension: `.pdf .png .jpg .jpeg .eps .svg`, in that order). Only browser images (PNG, JPEG, GIF, WebP) have a preview in the app; a PDF, EPS or SVG figure shows a toast instead, since opening it from the tree downloads it and a click should not start a download |
| A command the project defines (`\vect`, from `\newcommand`, `\DeclareMathOperator`, `\def`, xparse, ...) | The line of its definition |
| An environment name in `\begin{…}` / `\end{…}` that the project defines (`\newenvironment`, `\newtheorem`, xparse) | The line of its definition |

Anything else (built-in commands like `\section`, the `*` of `\nocite{*}`, text) is not a target. Ctrl+click
there keeps CodeMirror's own meaning (add a cursor). A target whose definition cannot be found shows a short toast
and does not jump: "No \label{fig:x} in this project.", "No entry knuth1984 in the project's .bib files.",
"chapters/x.tex is not in this project.", "\section is defined by LaTeX or a package, not in this project.",
"figs/plot.pdf has no preview here (only PNG, JPEG, GIF and WebP images do)."

## Finding the exact line

The index stores the file and line of each label, definition and `.bib` entry (`BibEntry` gains `line`). When
jumping, the line is re-checked against the file's **current** text (the live editor text for the open file, the
shared `projectTexts` copy for the others): the first `\label{name}` / `@type{key,` / definition of that name
outside comments wins; the indexed line is only the fallback. So a jump is exact even right after an edit that
the index has not caught up with. Duplicate labels or keys: the first one (in file order, main file first), and
the toast says "2 definitions; showing the first."

## Interaction

- **Ctrl+click / Cmd+click** on a target: the caret moves to the target (as in Visual Studio, so Back returns
  there), then the jump (the click does not add a cursor). On anything else: unchanged (CodeMirror adds a cursor,
  as before). With Alt or Shift also held, the click stays CodeMirror's.
- **Hint while the modifier is held:** the target under the mouse is underlined and the mouse shows a pointer
  (like a link). Released, window blurred or mouse moved off: back to normal. Decorations only (nothing is
  written to the document, synced or added to undo). The hint uses the same keys as the click: not with Alt or
  Shift, and not for AltGr (Windows reports it as Ctrl+Alt; many layouts type `\ { } [ ]` with it).
- **Back:** after a jump, the editor's header bar shows a small button "← Back to <file>:<line>". Clicking it
  returns to the place before the last jump (file and position); it stays while there is history (up to 20
  places; a new jump after going back drops the "forward" part). No keyboard shortcut on purpose: F12 opens the
  browser's developer tools and Alt+← is the browser's Back, and neither can be taken over reliably by a page.
- The jump uses the same path as clicking a problem: the file opens if needed, the line scrolls into view and
  flashes.
- Works for viewers (read-only) too: navigation does not edit.

## Code

- `apps/web/src/lib/latex/definitions.ts` (pure, unit-tested): `targetAt(doc text, position)` → the target
  kind, name and its range in the document (or null); `findDefinition(target, sources)` → `{ fileId, line }`,
  `{ fileId, preview: true }` (image) or a reason it was not found; `jumpModifier(event, mac)`, the keys of
  both the click and the hint; `caretAt(target)`, the caret move before a jump.
- `Editor.svelte`: props `definitionAt?(state, pos)` and `onGoToDefinition?(target)`; a mousedown handler
  (before CodeMirror's) and the modifier-hover underline (a decoration).
- `Project.svelte`: resolves with the index and texts, opens files / previews, keeps the back history and
  shows the "Back to" button in the editor header.
