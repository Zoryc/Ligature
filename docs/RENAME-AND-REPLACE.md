# Rename and replace in all files

Two features (docs/PLAN.md, "Rename and replace in all files"), the simple version:

1. **Rename a label with F2**: rename `eq:basquin` once and its `\label` and every reference to it, in every file,
   follow.
2. **Search in all files**, and **Replace all**.

Both work **in the browser**, through the collaboration connection the tab already has: the edits travel like
normal typing. **The server does not change.** Each rename or replace is **one entry of your Ctrl+Z**, undone in
every file at once.

Not in this version (later): regular expressions, replacing a single result, Ctrl+Y redo of a rename or replace, a
right-click menu, renaming the project's own commands and citation keys, and search in files other than the source
files.

## 1. Which files

The project's **source files**: `.tex`, `.ltx`, `.bib`, `.sty` and `.cls`, the ones `projectTexts` already loads
for the outline and autocomplete (up to 300). Their texts are already in the tab, so finding matches and counting
them needs no download. The open file uses its live text.

## 2. Applying an operation (rename or replace all)

`apps/web/src/lib/projectOps.ts` (pure parts testable without a browser) does it in these steps:

1. From the texts the tab has, pick the files with at least one match.
2. **Open the live document of each of them** on the page's shared socket (`ProjectCollab`). Rules for this:
   - The file open in the editor uses **its existing doc**. A second provider for the same doc name on the same
     socket is not allowed (Hocuspocus keys providers by name).
   - A file opened for an operation **does not show you as present** in it: no awareness `user` field. If you
     later open it in the editor, the editor reuses that doc and presence works as usual. If the operation still
     holds it after you close it in the editor, it stays open without presence.
   - So `ProjectCollab` keeps **one handle per doc name**, with a reference count: the editor and any operation
     share it, and it closes when the last holder releases it. `openFile` keeps its current contract for
     Project.svelte; recovery tracking and the editor's own UndoManager stay with the editor session.
3. **Wait until each one is synced** with the server, at most 10 s. If one does not sync (offline, denied), nothing
   is changed. Toast: "Couldn't reach the server; nothing was changed."
4. In each doc, **find the matches again on its current text** and apply all the edits of that file in **one
   transaction**, with an origin unique to this operation. The edits are minimal: only the replaced spans change.
   A file without matches anymore is skipped.
5. Create the operation's undo, one `Y.UndoManager` per changed doc:
   - it tracks **only this operation's origin**, with a large `captureTimeout` so the operation is one item;
   - the editor's own UndoManager does not track that origin, so the edits are never undone twice.
6. Refresh the changed files' texts in `projectTexts` (`remember`) from the live docs. The outline, autocomplete,
   go-to-definition and search then see the result at once.
7. The toast gives the real totals: "Renamed eq:basquin to eq:basquin-law: 3 places in 2 files." or "Replaced 12
   in 3 files."

Viewers never get here: the UI does not offer it to them, and the server ignores their edits anyway (read-only
connection).

If the server closes one of these docs (file deleted, document rebuilt, role changed), that file leaves the
operation and its undo skips it.

## 3. Ctrl+Z

The tab keeps a list of **project operations**, `{ id, kind, label, time, files: [{ fileId, undoManager }] }`, at
most **10** (the oldest is closed and dropped), each for at most **1 hour**. They are all closed when you leave the
project page.

**Ctrl+Z** (Cmd+Z) in the editor:
- **Undoes the newest operation** if it is newer than the newest item on the open file's own undo stack, or that
  stack is empty. It calls `undo()` on each of the operation's UndoManagers. Yjs reverts only this operation's
  edits and keeps everything others typed since. The operation is then closed and dropped (no redo).
- **Otherwise, normal undo.** So anything you typed after a rename is undone first, then the rename.
- The time of the open file's undo items is set in that UndoManager's `stack-item-added` event, through
  `stackItem.meta`.
- The choice between the two is a pure function, so it can be tested.

**Rename only:** before undoing, check the project's current texts. If a `\label{old-name}` exists now (someone
created one since), the undo is refused: "Can't undo the rename: eq:basquin is now used by another label." The
operation is dropped.

After an undo:
- the toast says "Rename undone in 2 files" or "Replace undone in 3 files";
- `projectTexts` is refreshed as above.

Ctrl+Y / Ctrl+Shift+Z keep their normal meaning, for the file's own edits only.

## 4. Rename a label (F2)

### Matching

`apps/web/src/lib/latex/labelRefs.ts`, pure: `labelOccurrences(text, name)` returns the `{ from, to }` of the
**name itself** in:
- `\label{name}`;
- every reference command of `REF_COMMANDS` (`completionData.ts`): each key of a comma list (`\cref{a, name}`,
  spaces around keys allowed and kept), after up to 3 `[…]` optional arguments, and both arguments of the range
  commands (`\crefrange`, `\Crefrange`, `\cpagerefrange` and the like, whatever the list holds).

It never matches:
- in a comment: from an unescaped `%` to the end of the line;
- after an escaped backslash: `\\label{x}` is a line break, then text;
- as part of a longer name: `eq:basquin2`;
- in prose or in any other command's argument;
- a name built by a macro (`#` or a backslash inside the braces).

Like go to definition, an argument must close on its own line: a reference list split over several lines
(`\cref{a,` then `b}` on the next line) is not renamed.

The range commands are kept in their own list (`REF_RANGE_COMMANDS`), so autocomplete and go to definition are
unchanged.

It reuses what `definitions.ts` and `projectIndex.ts` already do (control-word scanning, `commentStart`) rather than
writing a third version.

### The target under the cursor

`labelAt(text, pos)` returns the name when the cursor is in a label's name, in `\label{…}` or in a reference key.
The name's `from…to` counts as inside, end included.

### The box

**F2** in the editor, cursor on a label: a small box under the line, in the editor (like the explain widget's
place, not a modal). It contains:
- an input with the current name, selected;
- the count, from the tab's texts: "3 places in 2 files" ("1 place in 1 file");
- a warning, live, in these cases:
  - the name is empty;
  - it contains `{ } \ % #`, a comma or a line break;
  - it is longer than 200 characters;
  - it is already a label ("eq:x is already a label, in results.tex line 12.").

  Spaces at both ends are trimmed; spaces inside are allowed.
- **Enter** renames when there is no warning (otherwise it does nothing). **Escape**, or clicking outside, cancels.
  The same name means nothing to do: the box just closes.

F2 elsewhere shows a toast: "Put the cursor on a label (in \label or \ref) to rename it."

Viewers get the toast "Viewers can't rename."

F2 is free in browsers, so no browser shortcut is overridden.

## 5. Search and Replace all

### The panel

A **Search** tab in the left sidebar, next to Files and Contents. The remembered `sidebar` preference gains
`'search'`.

**Ctrl+Shift+F** (Cmd+Shift+F) opens it and focuses the query, prefilled with the editor's selection when it is on
one line. Ctrl+F stays CodeMirror's search in the open file.

The panel has:
- the query field;
- two toggles: **Aa** match case and **ab** whole word ("whole word" = not preceded or followed by a letter, digit
  or `_`);
- the results, **grouped by file** in the tree's order, main file first:
  - each result shows its line number and the line, with the match highlighted, cut around the match when long;
  - a click opens the file and selects the match;
- the summary: "12 results in 3 files", or "No results". At most 2 000 are shown ("2 000+ results; refine the
  search"), but the counts are exact;
- for editors only: a **"Replace with"** field and a **Replace all** button whose label says what it will do
  ("Replace 12 in 3 files"). The button only appears once there are results. An empty replacement deletes the
  matches.

Search runs as you type (debounced 150 ms), on the tab's texts. Plain text only: the query is matched literally,
characters like `\`, `$`, `{` included. The search function is pure (`apps/web/src/lib/search.ts`), shared by the
panel and Replace all. Matches never overlap, and the empty query finds nothing.

After a replace, the search runs again on the refreshed texts.

## 6. Tests (all in Docker, `npm run test:docker`)

**Pure, in `apps/web`:**
- `labelOccurrences`: every reference command, lists, optional arguments, range commands, comments, `\\label`,
  longer names, macro-built names, several on a line, CRLF.
- `labelAt` boundaries.
- Name validation.
- Search: plain, match case, whole word, special characters, no overlap, line and column of each result, the cap.
- The Ctrl+Z choice (operation vs file undo, by time).

**With real Yjs docs (no browser):** two `Y.Doc`s kept in sync, standing for you and a co-author.
- An operation is applied while the co-author types in the same file: their text is kept and every match is
  replaced exactly.
- The co-author edits more, then the operation is undone: only the operation's edits are reverted, the
  co-author's stay, and a span the co-author edited since stays as they left it.
- The editor's own UndoManager does not undo the operation.
- The rename undo is refused when the old name is taken.

**The doc-sharing rule of `ProjectCollab`** (one provider per doc name, reference count, no presence for operation
holders), tested at the level its existing tests use.
