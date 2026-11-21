# LaTeX autocomplete

Suggestions while typing in the editor, from two sources: **built-in lists** of common commands, environments
and packages, and an **index of the project** (labels, bibliography keys, the project's own commands, file
paths). Everything runs in the browser; the server only serves file texts as before. Shared types:
`apps/web/src/lib/latex/completionTypes.ts`.

## What is suggested, where

| You type | Suggestions | On accept |
|---|---|---|
| `\` + letters (also in math) | Built-in commands (`COMMANDS`) + the project's own commands (`\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareMathOperator`, `\def\x`, `\NewDocumentCommand`), ranked: exact prefix first, math commands first inside math, then by a frequency hint | The command with placeholders for its **required** arguments: `\frac{numerator}{denominator}`; Tab / Shift+Tab move between them (CodeMirror snippets). Commands without arguments insert just `\name` |
| `\begin{` + letters | Built-in environments + the project's `\newenvironment` / `\NewDocumentEnvironment` | `\begin{name}` + required args, a new indented line (with `body`, e.g. `\item `), and the matching `\end{name}`; the cursor goes to the first placeholder (or the body). Only for a new `\begin` with nothing after it on the line: when text follows, the cursor is inside an existing name, or the `\begin` already has its `\end` below (renaming an environment), just the name |
| `\end{` | The innermost environment still open above the cursor first | `\end{name}` |
| `\ref{`, `\eqref{`, `\pageref{`, `\autoref{`, `\nameref{`, `\cref{`, `\Cref{`, `\vref{` (and after a comma inside `\cref{a,`) | Labels of the whole project, each with what it labels (heading title or environment) and `file:line` | The label |
| `\cite{` and its variants (`\citep`, `\citet`, `\parencite`, `\textcite`, `\autocite`, `\footcite`, `\nocite`, `\citeauthor`, `\citeyear`, ...; also after a comma, and after `[…]` optional arguments) | Keys from every `.bib` file of the project, with author, year and title | The key |
| `\input{`, `\include{`, `\subfile{` | `.tex` files of the project, as paths relative to the main file's folder, without `.tex` | The path |
| `\includegraphics[…]{` | Images and PDFs of the project (`.png .jpg .jpeg .pdf .eps .svg`) relative to the main file's folder | The path |
| `\usepackage{`, `\RequirePackage{` (also after a comma) | Built-in list of common packages | The name |
| `\documentclass{` | Common classes (article, report, book, memoir, beamer, letter, scrartcl, scrreprt, scrbook, amsart) | The name |

Not inside comments (`%` to the end of the line, unless escaped `\%`). The popup opens by itself after `\`
plus one letter and inside the braces above; Ctrl+Space opens it anywhere (in plain text as a one-off: typing
anything but `\` closes it, and accepting a command there leaves the rest of the word alone). Read-only users get suggestions too
(they cannot type, but the popup does no harm; it simply never applies).

## Built-in lists (`apps/web/src/lib/latex/completionData.ts`)

- `COMMANDS: CommandInfo[]` — about 400 common commands, written for Ligature (MIT; do not copy lists from
  GPL/AGPL projects): LaTeX core (sectioning, text styles, references, floats, lists, spacing, verbatim-free
  basics), amsmath/amssymb (math structures, operators, arrows, relations, Greek letters, accents, delimiters),
  graphicx, hyperref, xcolor, siunitx, booktabs, cleveref, biblatex/natbib citation commands, tikz basics.
  Each with its arguments (`ArgSpec`, with a readable placeholder name), its package and a short `detail`.
- `ENVIRONMENTS: EnvironmentInfo[]` — about 60: document structure, lists, floats (figure, table, with
  `[htbp]` as an optional arg), tabular/tabularx/longtable (column spec), math (equation, align, gather,
  multline, cases, matrices, split), theorem-like, minipage, center, quote, verbatim, lstlisting, tikzpicture,
  frame (beamer), abstract, thebibliography...
- `PACKAGES: string[]` — about 120 common package names; `CLASSES: string[]`.
- The ref/cite/file command names above, as exported constants, so the completion source reads them from one
  place.

## Project index (`apps/web/src/lib/latex/projectIndex.ts`)

- `indexTex(text, fileId)` → labels (with context: the nearest preceding heading title, or the enclosing
  environment name for figure/table/equation/align/...), user commands and environments. Comment-aware, using
  the same comment stripping and brace matching as the Contents outline (`apps/web/src/lib/outline.ts`;
  share the helpers rather than copying them). Linear in the file size whatever the text, since any member can
  save a file every member's tab indexes: braces and brackets are matched in one pass (`groups` in outline.ts),
  names longer than 200 characters are ignored, environment nesting is capped. Labels containing `#` (macro
  parameters inside a definition, `\label{fig:#1}`) are skipped.
- `indexBib(text, fileId)` → entries: `@type{key,` / `@type(key,`; `title`, `author`, `year` (or `date`) from
  `field = {…}` / `"…"` / bare numbers; skips `@comment`, `@string`, `@preamble`. Tolerates broken entries.
- `ProjectIndex` keeps the per-file results and answers `labels()`, `bibEntries()`, `definitions()`.
- Texts: one shared loader for the whole project page (`apps/web/src/lib/projectTexts.ts`), used by both the
  index and the Contents outline (which currently fetches its own copies): it loads the `.tex`, `.bib`, `.sty`
  and `.cls` text files once when the project opens (8 at a time), again after a tree change or a finished
  compile, and uses the **live text** for the file open in the editor (re-indexed as you type, debounced).
- Cheap reloads: `GET /api/projects/:id/files/:fileId/raw` for text files sends an `ETag` (a hash of the
  text) and answers `304 Not Modified` to `If-None-Match`; with its existing `Cache-Control: private, no-cache`
  the browser revalidates by itself, so unchanged files are not downloaded again.

## Editor

`apps/web/src/lib/latex/latexCompletion.ts` exports a CodeMirror `CompletionSource` factory taking a getter for
the current `ProjectIndex` and the main file's folder; `Editor.svelte` passes it to `autocompletion({ override:
[...] })` (keeping the existing keymap). Pure helpers (context detection: which command/argument the cursor is
in, math or not, comment or not; ranking; building the snippet text) are unit-tested without CodeMirror.

## Limits

Context detection is local (the current line and a few lines above for `\begin…\end`), not a full parser:
unusual code (catcode changes, verbatim containing `\begin`) can give wrong suggestions, never wrong edits
without the user accepting them. Packages' own commands beyond the built-in list are not discovered.
