<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import type * as Y from 'yjs'
  import {
    can, type BuildResult, type Diagnostic, type ImportReport, type Me, type MetaEvent, type ProjectDetail, type TrashEntry,
    type TreeEntry, type VersionSummary,
  } from '@ligature/shared'
  import { api, ApiError, buildFileUrl, buildHasOutput, exportZipUrl, fetchBuildLog, fetchText, rawFileUrl } from '../lib/api.ts'
  import { ProjectCollab, type ConnectionStatus, type FileSession, type PresenceUser } from '../lib/collab.ts'
  import { userColor } from '../lib/colors.ts'
  import { treeRows, textFilesByPath } from '../lib/tree.ts'
  import { entryPath, isInlineImage, openFileOutcome } from '../lib/treeOps.ts'
  import { authFailedActions, closeActions, metaEventActions, resyncActions, type ProjectAction } from '../lib/projectEvents.ts'
  import { trackerAfterBuild, type BehindTracker } from '../lib/behind.ts'
  import { BuildEvents } from '../lib/buildEvents.ts'
  import type { LogInfo } from '../lib/logParse.ts'
  import {
    ChangeLog, editorDiagnostics, FileDiagnostics, linesForFile, type DeltaOp, type EditorDiagnostic, type LineDiagnostic,
  } from '../lib/diagnostics.ts'
  import {
    AutoCompiler, backoffFor, loadAutoCompile, saveAutoCompile, type AutoCompileState, type CompileOutcome, type CompileTrigger,
  } from '../lib/autoCompile.ts'
  import { reportView, takeImportReport } from '../lib/zipImport.ts'
  import { LineMap, SyncLines } from '../lib/syncLines.ts'
  import { dismissMenu, isSaveShortcut, isShowInPdfShortcut } from '../lib/shortcuts.ts'
  import { errorCode, errorMessage } from '../lib/errors.ts'
  import { toast } from '../lib/toasts.svelte.ts'
  import { go } from '../lib/router.svelte.ts'
  import { loadMe, logout } from '../lib/session.svelte.ts'
  import FileTree from '../lib/FileTree.svelte'
  import Editor from '../lib/Editor.svelte'
  import PdfView from '../lib/PdfView.svelte'
  import LogPanel from '../lib/LogPanel.svelte'
  import SettingsPanel from '../lib/SettingsPanel.svelte'
  import MembersPanel from '../lib/MembersPanel.svelte'
  import TrashPanel from '../lib/TrashPanel.svelte'
  import HistoryPanel from '../lib/HistoryPanel.svelte'
  import FileDiff from '../lib/FileDiff.svelte'
  import { restoreResultText, sameAsCurrent, undoConfirmText, undoPaths, versionRef, type DiffRequest } from '../lib/history.ts'
  import { confirmDialog } from '../lib/dialogs.svelte.ts'
  import { RestoreNotices, showRestoredToast, type RestoredEvent } from '../lib/restoreToast.ts'
  import RecoveryDialog from '../lib/RecoveryDialog.svelte'
  import { copyText, execCommandCopy, hasLocalChanges, recoveryOutcome } from '../lib/recovery.ts'
  import Logo from '../lib/Logo.svelte'
  import Avatar from '../lib/Avatar.svelte'
  import { engineLabel } from '../lib/SettingsPanel.svelte'
  import { prefs, setPref } from '../lib/prefs.svelte.ts'
  import { explain, usepackageInsertion, type QuickFix } from '../lib/explain.ts'
  import { buildOutline, entryMarks, resolveInput, type OutlineEntry } from '../lib/outline.ts'
  import { ProjectTexts } from '../lib/projectTexts.ts'
  import { ProjectIndex } from '../lib/latex/projectIndex.ts'
  import { latexCompletion } from '../lib/latex/latexCompletion.ts'
  import { findDefinition, targetAt, type DefinitionSources, type Target } from '../lib/latex/definitions.ts'
  import type { EditorState } from '@codemirror/state'
  import { agoText } from '../lib/trash.ts'

  interface Props { id: string; me: Me }
  let { id, me }: Props = $props()

  // Project + presence
  let detail = $state.raw<ProjectDetail | null>(null)
  let loadError = $state<string | null>(null)
  let status = $state<ConnectionStatus>('connecting')
  let peers = $state.raw<PresenceUser[]>([])
  let panel = $state<'none' | 'settings' | 'members' | 'trash' | 'history'>('none')
  let membersPanel = $state<ReturnType<typeof MembersPanel> | undefined>(undefined)
  let menuOpen = $state(false)
  let menuEl = $state<HTMLElement | undefined>(undefined)
  /** Report of the zip import that created this project (shown once, dismissible). */
  let importReport = $state.raw<ImportReport | null>(null)

  // Trash
  let trash = $state.raw<TrashEntry[] | null>(null)
  let trashError = $state<string | null>(null)
  /** Tree item highlighted for a moment (just restored). */
  let highlightId = $state<string | null>(null)
  let highlightTimer: ReturnType<typeof setTimeout> | null = null

  // History
  let historyPanel = $state<ReturnType<typeof HistoryPanel> | undefined>(undefined)
  /** File comparison shown next to the History panel. */
  let diffReq = $state.raw<DiffRequest | null>(null)
  const restoreNotices = new RestoreNotices()

  // Open file (text, in the editor) or preview (image)
  let file = $state.raw<FileSession | null>(null)
  let fileReady = $state(false)
  let fileError = $state<string | null>(null)
  /** Informational message in the editor pane (e.g. "the file was deleted"). */
  let fileNotice = $state<string | null>(null)
  let preview = $state.raw<TreeEntry | null>(null)
  let editor = $state.raw<ReturnType<typeof Editor> | undefined>(undefined)
  let pendingJump: { line: number; flash: boolean; column: number } | null = null

  // Recovery after a doc rebuild (docs/M3.md §4): our unacknowledged text vs. the server's current text.
  let recovery = $state.raw<{ fileId: string; path: string; localText: string; serverText: string | null; error: string | null } | null>(null)
  /** Set while we fetch the server's text to decide whether the dialog is needed. */
  let recovering = $state(false)

  // Builds
  let compiling = $state(false)
  let logInfo = $state.raw<LogInfo | null>(null)
  let pdfUrl = $state<string | null>(null)
  /** The build whose PDF is shown, and whether it has SyncTeX data. */
  let shown = $state.raw<{ buildId: string; synctex: boolean | null } | null>(null)
  let pdfView = $state.raw<ReturnType<typeof PdfView> | undefined>(undefined)
  /** Baselines of the shown build (null when we have no snapshot for it) */
  let tracker: BehindTracker | null = null
  let behind = $state<boolean | null>(null)
  let behindTimer: ReturnType<typeof setTimeout> | null = null
  const buildEvents = new BuildEvents()
  /** Increments for every build we start showing, so stale async loads are dropped. */
  let buildSeq = 0

  // Diagnostics of the shown build: per file as line numbers, anchored to the text for the open file.
  let fileLines = new Map<string, LineDiagnostic[]>()
  let anchors: FileDiagnostics | null = null
  let editorDiags = $state.raw<EditorDiagnostic[]>([])
  /** The open file's text when our compile started, and its changes since (see diagnostics.ts). */
  let changeLog: ChangeLog | null = null
  /** SyncTeX: line numbers of the shown PDF's build vs. the text as edited since. */
  const syncLines = new SyncLines()

  // Auto-compile
  let autoOn = $state(false)
  let autoState = $state.raw<AutoCompileState | null>(null)
  const auto = new AutoCompiler({ enabled: false, compile: t => doCompile(t), onState: s => { autoState = s } })

  // Folio: account menu, cursor position, quick fixes, Contents outline
  let accountOpen = $state(false)
  let compileMenuOpen = $state(false)
  let compileMenuEl = $state<HTMLElement | undefined>(undefined)
  let logTab = $state<'problems' | 'log'>('problems')
  let accountEl = $state<HTMLElement | undefined>(undefined)
  let cursorPos = $state<{ line: number; column: number } | null>(null)
  /** A package to add to the main file once it is open in the editor (quick fix). */
  let pendingFix: QuickFix | null = null
  /** Bumped when outline inputs change (texts loaded, open file edited, diagnostics replaced). */
  let outlineTick = $state(0)
  let outlineLoading = $state(false)

  // Source texts (.tex, .bib, .sty, .cls), shared by the Contents outline and the autocomplete index.
  const texts = new ProjectTexts({
    fetch: fid => fetchText(rawFileUrl(id, fid)),
    live: () => (file && fileReady ? { fileId: file.fileId, text: () => file?.ytext.toString() ?? '' } : null),
    onLoading: l => { outlineLoading = l },
    onLoaded: (changed, removed) => {
      for (const fid of removed) index.remove(fid)
      for (const fid of changed) reindex(fid)
      outlineTick++
    },
  })
  /** Labels, bibliography keys and the project's own commands, for autocomplete (docs/AUTOCOMPLETE.md). */
  const index = new ProjectIndex()
  const completion = latexCompletion({ index: () => index, mainDir: () => mainDir, mainPath: () => mainPath })
  /** Re-indexing the open file waits for a pause in typing. */
  let indexTimer: ReturnType<typeof setTimeout> | null = null

  let rows = $derived(detail ? treeRows(detail.tree, detail.rootId) : [])
  let byPath = $derived(textFilesByPath(rows))
  let canEdit = $derived(detail ? can.edit(detail.role) : false)
  let canCompile = $derived(detail ? can.compile(detail.role) : false)
  let openPath = $derived.by(() => {
    const shownId = file?.fileId ?? preview?.id
    return detail && shownId ? entryPath(detail.tree, shownId) ?? '' : ''
  })
  let syncProblem = $derived(
    !pdfUrl || !shown ? 'No PDF yet: compile first.'
      : shown.synctex === null ? 'Checking for SyncTeX data…'
        : !shown.synctex ? 'This build has no SyncTeX data.'
          : null)
  let showInPdfProblem = $derived(syncProblem ?? (!file || !fileReady ? 'Open a source file first.' : null))
  let panelTitle = $derived(
    panel === 'settings' ? 'Project settings' : panel === 'members' ? 'Members' : panel === 'history' ? 'History' : 'Trash')
  let reportShown = $derived(importReport && detail ? reportView(detail.name, importReport) : null)
  let mainPath = $derived(detail?.mainFileId ? entryPath(detail.tree, detail.mainFileId) ?? '' : '')
  let mainName = $derived(mainPath.split('/').pop() || 'the main file')
  /** The main file's folder: \input and \includegraphics paths are relative to it. */
  let mainDir = $derived(mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/')) : '')
  /** Breadcrumb of the open file: folders, then its name. */
  let crumbs = $derived.by(() => {
    const parts = openPath.split('/')
    return { dirs: parts.slice(0, -1), name: parts.at(-1) ?? '' }
  })
  let others = $derived(peers.filter(p => p.id !== me.id))

  let outline = $derived.by((): OutlineEntry[] => {
    void outlineTick
    const d = detail
    if (!d?.mainFileId) return []
    const dir = mainDir
    void file
    void fileReady // texts.text() uses the open file's live text
    return buildOutline({
      mainFileId: d.mainFileId,
      text: fid => texts.text(fid),
      resolve: p => resolveInput(p, dir, byPath),
    })
  })
  let outlineMarks = $derived.by(() => {
    void outlineTick
    const live = file && fileReady && anchors ? { id: file.fileId, lines: anchors.toLines(file.ytext.toString()) } : null
    return entryMarks(outline, fid => ((live && live.id === fid ? live.lines : fileLines.get(fid)) ?? [])
      .map(l => ({ line: l.line, severity: l.diag.severity })))
  })
  /** The outline entry the cursor is in (open file only). */
  let currentEntry = $derived.by(() => {
    const fid = file?.fileId
    const line = cursorPos?.line
    if (!fid || !line) return -1
    let best = -1
    outline.forEach((e, i) => { if (e.fileId === fid && e.line <= line) best = i })
    return best
  })

  // Auto-compile only for owners/editors, and only while the toggle is on.
  $effect(() => { auto.setEnabled(canCompile && autoOn) })

  // The project and account menus close on a click outside them and on Escape.
  $effect(() => {
    if (!menuOpen) return
    return dismissMenu(window, t => !!menuEl && t instanceof Node && menuEl.contains(t), () => { menuOpen = false })
  })
  $effect(() => {
    if (!compileMenuOpen) return
    return dismissMenu(window, t => !!compileMenuEl && t instanceof Node && compileMenuEl.contains(t), () => { compileMenuOpen = false })
  })
  $effect(() => {
    if (!accountOpen) return
    return dismissMenu(window, t => !!accountEl && t instanceof Node && accountEl.contains(t), () => { accountOpen = false })
  })

  // Autocomplete: the project's paths (for \input / \includegraphics and for "file:line" hints).
  $effect(() => {
    index.setFiles(rows.map(r => ({ id: r.entry.id, path: r.path, kind: r.entry.kind })))
  })

  /** (Re)load the source texts: when the project opens, after a tree change and after a finished compile. */
  function loadTexts() {
    const d = detail
    if (d && !destroyed) void texts.load(d.tree.filter(e => e.kind === 'text'))
  }

  /** Index one file's current text (live for the open file). */
  function reindex(fileId: string) {
    const entry = detail?.tree.find(e => e.id === fileId)
    const text = texts.text(fileId)
    if (entry && text !== null) index.update(fileId, entry.name, text)
  }

  /** The open file was edited (by anyone): re-index it once typing pauses. */
  function scheduleReindex() {
    if (indexTimer) clearTimeout(indexTimer)
    indexTimer = setTimeout(() => {
      indexTimer = null
      if (file && fileReady) reindex(file.fileId)
    }, 300)
  }

  function openOutlineEntry(e: OutlineEntry) {
    const entry = detail?.tree.find(t => t.id === e.fileId)
    if (entry) openFile(entry, e.line, true)
  }

  // ---------- quick fixes ----------

  function applyFix(fix: QuickFix) {
    if (fix.kind !== 'usepackage' || !detail) return
    const main = detail.tree.find(e => e.id === detail?.mainFileId && e.kind === 'text')
    if (!main) {
      toast('This project has no main file: choose one in Settings first.', 'error')
      return
    }
    pendingFix = fix
    if (file && fileReady && file.fileId === main.id) applyPendingFix()
    else openFile(main)
  }

  function applyPendingFix() {
    const fix = pendingFix
    if (!fix || !editor || !file || file.fileId !== detail?.mainFileId) return
    pendingFix = null
    const text = editor.text() ?? ''
    const at = usepackageInsertion(text, fix.pkg)
    if (!at) {
      toast(/\\begin\s*\{document\}/.test(text)
        ? `${fix.pkg} is already loaded in ${mainName}.`
        : `${mainName} has no \\begin{document}: add \\usepackage{${fix.pkg}} to the preamble yourself.`, 'error')
      return
    }
    if (editor.insertText(at.at, at.insert)) {
      toast(`Added \\usepackage{${fix.pkg}} to ${mainName}. Recompile to check (Ctrl+S).`)
    }
  }

  let collab: ProjectCollab | null = null
  let destroyed = false
  /** Set once we are on our way out (project deleted / access lost): no more notices. */
  let leaving = false

  onMount(() => {
    importReport = takeImportReport(id)
    window.addEventListener('keydown', onKeydown)
    void (async () => {
      let d: ProjectDetail
      try {
        d = await api.project(id)
      } catch (e) {
        loadError = e instanceof ApiError && e.status === 404 ? 'Project not found, or you are not a member.' : `Could not load the project: ${errorMessage(e)}`
        return
      }
      if (destroyed) return
      detail = d
      loadTexts()
      autoOn = loadAutoCompile(localStorageOrNull(), id, can.compile(d.role))
      const user: PresenceUser = { id: me.id, name: me.displayName, ...userColor(me.id) }
      collab = new ProjectCollab(id, user, {
        onStatus: s => { status = s },
        onPeers: p => { peers = p },
        onEvent: handleEvent,
        // Also after a socket outage: MetaEvents sent meanwhile are lost, so refetch the project (and members).
        onSynced: () => { if (!leaving) runActions(resyncActions({ membersOpen: panel === 'members' })) },
        onAuthFailed: reason => runActions(authFailedActions(reason, 'meta')),
        onClosed: reason => runActions(closeActions(reason, 'meta')),
      })
      const main = d.tree.find(e => e.id === d.mainFileId && e.kind === 'text')
      const first = main ?? treeRows(d.tree, d.rootId).find(r => r.entry.kind === 'text')?.entry
      if (first) openFile(first)
      void loadTrash()
      void showLatestBuild()
    })()
  })

  onDestroy(() => {
    destroyed = true
    window.removeEventListener('keydown', onKeydown)
    auto.dispose()
    if (behindTimer) clearTimeout(behindTimer)
    if (highlightTimer) clearTimeout(highlightTimer)
    if (indexTimer) clearTimeout(indexTimer)
    texts.dispose()
    closeFile()
    collab?.destroy()
    collab = null
  })

  function localStorageOrNull(): Storage | null {
    try {
      return window.localStorage
    } catch {
      return null
    }
  }

  function onKeydown(e: KeyboardEvent) {
    // Ctrl/Cmd+S: compile, and never the browser's "save page" dialog.
    if (isSaveShortcut(e)) {
      e.preventDefault()
      if (canCompile) auto.compileNow()
      return
    }
    // Ctrl+Alt+J (Cmd+Alt+J): show the cursor's place in the PDF.
    if (isShowInPdfShortcut(e)) {
      e.preventDefault()
      void showInPdf()
    }
  }

  function statusLabel(s: string): string {
    return s === 'success' ? 'Compiled' : s === 'timeout' ? 'Compile timed out' : s === 'cancelled' ? 'Compile cancelled' : 'Compile failed'
  }

  function setAuto(on: boolean) {
    autoOn = on
    saveAutoCompile(localStorageOrNull(), id, on)
  }

  // ---------- files ----------

  function onDocUpdate(_update: Uint8Array, origin: unknown) {
    if (file?.isLocal(origin)) auto.localEdit()
    scheduleReindex()
    // Not needed per keystroke: coalesce (a Y snapshot walks the whole doc).
    if (behindTimer) return
    behindTimer = setTimeout(() => {
      behindTimer = null
      updateBehind()
      outlineTick++
      // Bring the editor's markers in line with our anchors (CodeMirror maps them too; this keeps them equal,
      // including after the editor is re-created, e.g. on a role change).
      if (anchors && anchors.size && file) editorDiags = editorDiagnostics(anchors, file.ytext.length)
    }, 250)
  }

  function onTextChange(ev: Y.YTextEvent) {
    const delta = ev.delta as DeltaOp[]
    anchors?.applyDelta(delta)
    changeLog?.record(delta)
    if (file) syncLines.applyDelta(file.fileId, delta)
  }

  function closeFile() {
    if (!file) return
    if (anchors && fileReady) fileLines.set(file.fileId, anchors.toLines(file.ytext.toString()))
    if (fileReady) syncLines.closed(file.fileId, file.ytext.toString())
    if (fileReady) {
      // Its last text stays for the outline and the index until the next load (no longer live once closed).
      if (indexTimer) clearTimeout(indexTimer)
      indexTimer = null
      texts.remember(file.fileId, file.ytext.toString())
      reindex(file.fileId)
    }
    anchors = null
    changeLog = null
    editorDiags = []
    file.doc.off('update', onDocUpdate)
    file.ytext.unobserve(onTextChange)
    file.close()
    file = null
    fileReady = false
    editor = undefined
  }

  /** Click in the tree: text opens in the editor, inline images preview, anything else downloads. */
  function openEntry(entry: TreeEntry) {
    if (entry.kind === 'text') openFile(entry)
    else if (entry.kind === 'binary') {
      if (isInlineImage(entry.name)) {
        closeFile()
        fileError = null
        fileNotice = null
        preview = entry
      } else {
        const a = document.createElement('a')
        a.href = rawFileUrl(id, entry.id)
        a.download = entry.name
        document.body.append(a)
        a.click()
        a.remove()
      }
    }
  }

  /** Open a text file; with `jumpTo`, put the cursor on that 1-based line (and 0-based `column`). */
  function openFile(entry: TreeEntry, jumpTo: number | null = null, flash = false, column = 0) {
    if (!collab || entry.kind !== 'text' || entry.epoch === undefined) return
    preview = null
    fileNotice = null
    const jump = jumpTo === null ? null : { line: jumpTo, flash, column }
    if (file && file.fileId === entry.id && file.epoch === entry.epoch) {
      if (jump) {
        pendingJump = jump
        applyPendingJump() // or later, once the file has synced
      }
      return
    }
    closeFile()
    pendingJump = jump
    fileError = null
    const s: FileSession = collab.openFile(entry.id, entry.epoch, {
      onSynced: () => {
        if (file !== s) return
        if (!fileReady) {
          // Anchor the diagnostics of the shown build to the text as it is now.
          anchors = new FileDiagnostics(fileLines.get(s.fileId) ?? [], s.ytext.toString())
          editorDiags = editorDiagnostics(anchors, s.ytext.length)
          syncLines.opened(s.fileId, s.ytext.toString())
          fileReady = true
          reindex(s.fileId)
          void tick().then(applyPendingJump)
        }
        updateBehind()
      },
      onAuthFailed: reason => { if (file === s) runActions(authFailedActions(reason, 'file')) },
      onClosed: reason => { if (file === s) runActions(closeActions(reason, 'file')) },
    })
    s.doc.on('update', onDocUpdate)
    s.ytext.observe(onTextChange)
    file = s
    updateBehind()
  }

  /** Open the current entry of the open file again in a fresh session (its epoch changed). */
  function reopenFile() {
    if (!file || !detail) return
    const entry = detail.tree.find(e => e.id === file?.fileId)
    closeFile()
    if (entry) openFile(entry)
  }

  /**
   * The open file got a new epoch (its doc was rebuilt on the server). Without edits the server lacks,
   * re-open it silently; otherwise compare our text with the server's and show the recovery dialog.
   */
  async function reopenAfterRebuild() {
    const s = file
    if (!s || recovering) return
    const local = s.localState()
    if (!hasLocalChanges(local)) {
      reopenFile()
      return
    }
    const path = openPath
    recovering = true
    closeFile()
    let serverText: string | null = null
    let error: string | null = null
    try {
      serverText = await fetchText(rawFileUrl(id, s.fileId))
    } catch (e) {
      error = `Could not load the current version: ${errorMessage(e)}`
    } finally {
      recovering = false
    }
    if (destroyed || leaving) return
    if (recoveryOutcome(local, serverText) === 'reopen') {
      // The server has our text after all. Re-open, unless the user has opened something else meanwhile.
      if (!file && !preview) openCurrentVersion(s.fileId, path)
      return
    }
    recovery = { fileId: s.fileId, path, localText: local.text, serverText, error }
  }

  /** Open a file at its current epoch (after a rebuild), or say that it is gone. */
  function openCurrentVersion(fileId: string, path: string) {
    const entry = detail?.tree.find(e => e.id === fileId && e.kind === 'text')
    if (entry) openFile(entry)
    else fileNotice = `"${path || 'The file'}" no longer exists.`
  }

  async function copyRecoveryText() {
    if (!recovery) return
    const ok = await copyText(recovery.localText, { clipboard: navigator.clipboard, execCopy: execCommandCopy })
    if (ok) toast('Your text was copied to the clipboard.')
    else toast('Could not copy automatically. Select your text on the left and copy it with Ctrl+C.', 'error', 6000)
  }

  function closeRecovery() {
    const r = recovery
    if (!r) return
    recovery = null
    openCurrentVersion(r.fileId, r.path)
  }

  function applyPendingJump() {
    if (pendingJump !== null && editor) {
      editor.gotoLine(pendingJump.line, pendingJump.flash, pendingJump.column)
      pendingJump = null
    }
    if (pendingFix) applyPendingFix()
  }

  function findByLogPath(path: string): TreeEntry | undefined {
    const exact = byPath.get(path) ?? byPath.get(`${path}.tex`)
    if (exact) return exact
    for (const [p, e] of byPath) if (p.endsWith(`/${path}`) || path.endsWith(`/${p}`)) return e
    return undefined
  }

  function jumpTo(path: string, line: number) {
    const entry = findByLogPath(path)
    if (!entry) {
      toast(`"${path}" is not a file in this project.`, 'error')
      return
    }
    openFile(entry, line, true)
  }

  /** A problem in the log panel was clicked: open its file at its line (as moved by edits since the build). */
  function openProblem(d: Diagnostic) {
    if (!d.fileId) {
      if (d.path) jumpTo(d.path, d.line ?? 1)
      return
    }
    const entry = detail?.tree.find(e => e.id === d.fileId)
    if (!entry || entry.kind !== 'text') {
      toast(`"${d.path ?? 'This file'}" is no longer in the project.`, 'error')
      return
    }
    let line = d.line ?? 1
    if (file && file.fileId === d.fileId && anchors && fileReady) line = anchors.lineOf(d, file.ytext.toString()) ?? line
    else line = fileLines.get(d.fileId)?.find(x => x.diag === d)?.line ?? line
    openFile(entry, line, true)
  }

  // ---------- go to definition (docs/GO-TO-DEFINITION.md) ----------

  interface Place { fileId: string; line: number; column: number }
  /** Places before each jump, newest last; the Back button returns to the last one. */
  let backStack = $state.raw<Place[]>([])
  const BACK_MAX = 20
  let backTo = $derived.by(() => {
    const p = backStack.at(-1)
    if (!p || !detail) return null
    const path = entryPath(detail.tree, p.fileId)
    return { path: path ?? 'a deleted file', name: path?.split('/').pop() ?? 'a deleted file', line: p.line }
  })

  /** The project's own command and environment names, rebuilt when the index changes (asked per mouse move). */
  let defined: { version: number; names: Set<string> } = { version: -1, names: new Set() }
  function isDefined(kind: 'command' | 'environment', name: string): boolean {
    if (defined.version !== index.version) {
      defined = { version: index.version, names: new Set(index.definitions().map(d => `${d.kind}:${d.name}`)) }
    }
    return defined.names.has(`${kind}:${name}`)
  }

  /** The target at a position of the open file: its line is all targetAt reads. */
  function definitionAt(state: EditorState, pos: number): Target | null {
    const line = state.doc.lineAt(pos)
    const t = targetAt(line.text, pos - line.from, isDefined)
    return t && { ...t, from: t.from + line.from, to: t.to + line.from }
  }

  function definitionSources(): DefinitionSources {
    const main = detail?.mainFileId
    const list = rows.filter(r => r.entry.kind !== 'folder')
      .map(r => ({ id: r.entry.id, path: r.path, text: r.entry.kind === 'text' }))
    return {
      files: [...list.filter(f => f.id === main), ...list.filter(f => f.id !== main)],
      text: fid => texts.text(fid),
      index,
      mainDir,
    }
  }

  /** Remember where the cursor is, for Back: the Editor has put it on the clicked target (caretAt). */
  function rememberPlace() {
    const c = editor?.cursor()
    if (!file || !fileReady || !c) return
    backStack = [...backStack, { fileId: file.fileId, line: c.line, column: c.column }].slice(-BACK_MAX)
  }

  function goToDefinition(target: Target) {
    if (!detail) return
    const found = findDefinition(target, definitionSources())
    if ('reason' in found) {
      toast(found.reason, 'error')
      return
    }
    const entry = detail.tree.find(e => e.id === found.fileId)
    if (!entry) return
    if ('preview' in found) {
      // Only browser images have a preview; anything else would download, which a click should not do.
      if (!isInlineImage(entry.name)) {
        toast(`${entryPath(detail.tree, entry.id) ?? entry.name} has no preview here (only PNG, JPEG, GIF and WebP images do).`, 'error')
        return
      }
      rememberPlace()
      openEntry(entry)
      return
    }
    rememberPlace()
    openFile(entry, found.line, true)
    if (found.count > 1) toast(`${found.count} definitions; showing the first.`)
  }

  /** Return to the place before the last jump. */
  function goBack() {
    const p = backStack.at(-1)
    if (!p) return
    backStack = backStack.slice(0, -1)
    const entry = detail?.tree.find(e => e.id === p.fileId && e.kind === 'text')
    if (!entry) {
      toast('That file is no longer in the project.', 'error')
      return
    }
    openFile(entry, p.line, false, p.column)
  }

  // ---------- project state ----------

  function leave(notice: string) {
    if (leaving || destroyed) return
    leaving = true
    toast(notice, 'error', 6000)
    go('/projects')
  }

  /** null on a transient error, 'gone' when the project is deleted or we are no longer a member. */
  async function fetchProject(): Promise<ProjectDetail | 'gone' | null> {
    try {
      return await api.project(id)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return 'gone'
      if (!(e instanceof ApiError && e.status === 401)) console.error('could not refresh the project', e)
      return null
    }
  }

  /** Show a new project state; deal with the open file/preview having been deleted, reset or re-roled. */
  function applyDetail(d: ProjectDetail) {
    const roleChanged = detail !== null && detail.role !== d.role
    const treeChanged = detail !== null && detail.treeVersion !== d.treeVersion
    announceSettingChanges(detail, d)
    detail = d
    if (treeChanged) {
      loadTexts()
      // A rename between .tex and .bib keeps the text, so the load reports no change: re-parse by the new name
      // (files whose text and kind are unchanged return at once).
      for (const fid of texts.ids()) reindex(fid)
    }
    if (roleChanged && !can.compile(d.role)) autoOn = false
    if (preview && !d.tree.some(e => e.id === preview?.id && e.kind === 'binary')) {
      fileNotice = `"${preview.name}" was deleted.`
      preview = null
    }
    if (!file) return
    const outcome = openFileOutcome(d.tree, file.fileId, file.epoch)
    if (outcome === 'deleted') {
      const name = openPath || 'The open file'
      closeFile()
      fileNotice = `"${name}" was moved to the trash.`
      toast(fileNotice)
    } else if (outcome === 'reopen') {
      void reopenAfterRebuild()
    } else if (roleChanged) {
      // The server sets read-only per connection at authentication (and closed us): re-authenticate.
      file.reconnect()
    }
  }

  /** A collaborator changed the compiler or the main file: say so (our own changes have their own toast). */
  function announceSettingChanges(before: ProjectDetail | null, after: ProjectDetail) {
    if (!before) return
    const c = after.changes
    if (before.engine !== after.engine && c.engine && c.engine.byUserId !== me.id) {
      toast(`${c.engine.by || 'Someone'} changed the compiler to ${engineLabel(after.engine)}${c.engine.was ? ` (was ${engineLabel(c.engine.was)})` : ''}. It is used from the next build.`, 'info', 7000)
    }
    if (before.mainFileId !== after.mainFileId && after.mainFileId && c.mainFile && c.mainFile.byUserId !== me.id) {
      toast(`${c.mainFile.by || 'Someone'} made ${entryPath(after.tree, after.mainFileId) ?? 'another file'} the main file.`, 'info', 7000)
    }
  }

  let refreshRunning = false
  let refreshQueued = false

  /** Refetch the project (coalesced: at most one request in flight, one queued). */
  async function refreshProject(): Promise<void> {
    if (refreshRunning) {
      refreshQueued = true
      return
    }
    refreshRunning = true
    try {
      do {
        refreshQueued = false
        const r = await fetchProject()
        if (destroyed) return
        if (r === 'gone') return leave('You no longer have access to this project.')
        if (r) applyDetail(r)
      } while (refreshQueued)
    } finally {
      refreshRunning = false
    }
  }

  let trashRunning = false
  let trashQueued = false

  /** Refetch the trash listing (coalesced like refreshProject). */
  async function loadTrash(): Promise<void> {
    if (trashRunning) {
      trashQueued = true
      return
    }
    trashRunning = true
    try {
      do {
        trashQueued = false
        try {
          const list = await api.trash(id)
          if (destroyed) return
          trash = list
          trashError = null
        } catch (e) {
          if (destroyed) return
          if (!(e instanceof ApiError && (e.status === 401 || e.status === 404))) trashError = `Could not load the trash: ${errorMessage(e)}`
        }
      } while (trashQueued)
    } finally {
      trashRunning = false
    }
  }

  async function onRestored(entry: TreeEntry) {
    await refreshProject()
    if (destroyed) return
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightId = null
    await tick()
    highlightId = entry.id
    highlightTimer = setTimeout(() => { highlightId = null }, 3500)
  }

  let rechecking = false

  async function recheckAccess(notice: string, leaveMsg: string) {
    if (rechecking || leaving) return
    rechecking = true
    try {
      const r = await fetchProject()
      if (destroyed) return
      if (r === 'gone') return leave(leaveMsg)
      if (!r) return
      const before = detail?.role
      applyDetail(r)
      toast(before && before !== r.role ? `${notice} You are now ${r.role}.` : notice)
      collab?.reconnectMeta()
      file?.reconnect()
    } finally {
      rechecking = false
    }
  }

  async function sessionLost(notice: string) {
    if (leaving) return
    leaving = true
    toast(notice, 'error', 6000)
    await loadMe() // no session any more: the app shows the login page
    if (!destroyed) leaving = false
  }

  function runActions(actions: ProjectAction[]) {
    for (const a of actions) {
      switch (a.type) {
        case 'refresh-project':
          void refreshProject()
          break
        case 'refresh-trash':
          void loadTrash()
          break
        case 'drop-peer':
          collab?.dropPeer(a.userId)
          break
        case 'refresh-members':
          void membersPanel?.reload()
          break
        case 'compile-finished':
          if (buildEvents.onEvent({ buildId: a.buildId, status: a.status }) === 'show') {
            void showForeignBuild(a.buildId, a.status)
          }
          break
        case 'recheck-access':
          void recheckAccess(a.notice, a.leave)
          break
        case 'leave':
          leave(a.notice)
          break
        case 'session-lost':
          void sessionLost(a.notice)
          break
        case 'reconnect':
          toast(a.notice)
          collab?.reconnectMeta()
          file?.reconnect()
          void refreshProject()
          break
        case 'file-gone':
          if (file) {
            const name = openPath
            closeFile()
            fileNotice = name ? `"${name}" was moved to the trash.` : a.notice
            toast(a.notice)
            void refreshProject()
          }
          break
        case 'file-reconnect':
          file?.reconnect()
          break
        case 'file-reload':
          void refreshProject()
          break
        case 'refresh-versions':
          if (panel === 'history') void historyPanel?.reload()
          break
        case 'version-restored': {
          const ev = restoreNotices.event(a)
          if (ev) void announceRestoreEvent(ev)
          break
        }
      }
    }
  }

  function handleEvent(e: MetaEvent) {
    if (!detail || leaving) return
    runActions(metaEventActions(e, { meId: me.id, treeVersion: detail.treeVersion, membersOpen: panel === 'members' }))
  }

  /**
   * Log out from this page. Tear the collaboration socket down first: the server closes this session's
   * sockets with 'session-ended', which must not be reported as a lost session (or redirect back here).
   */
  async function logOutHere() {
    leaving = true
    closeFile()
    collab?.destroy()
    collab = null
    await logout()
  }

  async function setMainFile(fileId: string) {
    try {
      applyDetail(await api.updateProject(id, { mainFileId: fileId }))
      toast('Main file changed.')
    } catch (e) {
      toast(`Could not set the main file: ${errorMessage(e)}`, 'error')
    }
  }

  function togglePanel(p: 'settings' | 'members' | 'trash' | 'history') {
    panel = panel === p ? 'none' : p
    menuOpen = false
    accountOpen = false
    diffReq = null
    if (panel === 'trash') void loadTrash()
  }

  // ---------- history ----------

  /**
   * Restore a version (whole project, or only `paths`). `what` names it in the toast ('to "Draft 1"').
   * Resolves true when it was restored.
   */
  async function restoreVersion(versionId: string, what: string, paths?: string[], undo = false): Promise<boolean> {
    restoreNotices.begin()
    let pre: string | null = null
    let detailText = ''
    try {
      const r = await api.restoreVersion(id, versionId, paths ? { paths } : {})
      pre = r.preRestoreVersionId
      detailText = restoreResultText(r)
      return true
    } catch (e) {
      const msg = errorMessage(e, { 'not-found': 'That version no longer exists.' })
      toast(undo
        ? `Could not undo the restore: ${msg.endsWith('.') ? msg : `${msg}.`} The state before it stays in History as a "Before restore" version.`
        : `Could not restore: ${msg}`, 'error', 6000)
      return false
    } finally {
      const { own, others } = restoreNotices.finish(pre)
      if (!destroyed) {
        if (own && pre) {
          const target: UndoTarget = { versionId, preRestoreVersionId: pre, by: null, ...(paths ? { paths } : {}) }
          showRestoredToast({
            what, by: me.displayName, mine: true, detail: detailText, canUndo: canEdit,
            onUndo: () => undoRestore(target),
          })
        }
        for (const ev of others) void announceRestoreEvent(ev)
        if (pre) {
          // The broadcasts do this too; this one is immediate.
          void refreshProject()
          void loadTrash()
        }
      }
    }
  }

  /** From the History panel. */
  function restoreFromHistory(v: VersionSummary, paths?: string[]): Promise<boolean> {
    const ref = versionRef(v)
    const what = paths && paths.length === 1 ? `"${paths[0]}" to ${ref}` : paths ? `${paths.length} files to ${ref}` : `to ${ref}`
    return restoreVersion(v.id, what, paths)
  }

  /** A collaborator's restore (or ours from another tab): toast with Undo for owners/editors. */
  async function announceRestoreEvent(ev: RestoredEvent) {
    let ref = 'an earlier version'
    try {
      ref = versionRef((await api.version(id, ev.versionId)).version)
    } catch {
      // thinned or unreadable: keep the generic text
    }
    if (destroyed || leaving) return
    const target: UndoTarget = { versionId: ev.versionId, preRestoreVersionId: ev.preRestoreVersionId, by: ev.by }
    showRestoredToast({
      what: `to ${ref}`, by: ev.by, mine: false, canUndo: canEdit,
      onUndo: () => undoRestore(target),
    })
  }

  /**
   * A restore to undo: `versionId` was restored (only `paths` of it, when set: one of our partial restores),
   * `preRestoreVersionId` is the backup taken just before. `by`: who restored it (null: we did, in this tab).
   */
  interface UndoTarget { versionId: string; preRestoreVersionId: string; by: string | null; paths?: string[] }

  /**
   * Undo a restore; resolves false when nothing was undone (the toast then offers Undo again).
   * - Our partial restore: restore only the files it touched, at their paths in the backup (undoPaths()).
   * - Otherwise the whole project goes back to the backup. If the project changed since the restore (edits by
   *   anyone, or a collaborator's restore that was only partial: the event does not say), ask first.
   */
  async function undoRestore(u: UndoTarget): Promise<boolean> {
    const before = 'to the state before the restore'
    if (u.paths) {
      let paths: string[]
      try {
        const [restored, pre] = await Promise.all([api.version(id, u.versionId), api.version(id, u.preRestoreVersionId)])
        paths = undoPaths(restored.files, u.paths, pre.files)
      } catch (e) {
        toast(`Could not undo the restore: ${errorMessage(e, { 'not-found': 'That version no longer exists.' })}`, 'error', 6000)
        return false
      }
      if (paths.length === 0) {
        const one = u.paths.length === 1 ? `"${u.paths[0]}" was` : 'These files were'
        toast(`Nothing to undo: ${one} not in the project before the restore. Move ${u.paths.length === 1 ? 'it' : 'them'} to the trash if you do not want ${u.paths.length === 1 ? 'it' : 'them'}.`, 'info', 8000)
        return true
      }
      return restoreVersion(u.preRestoreVersionId, paths.length === 1 ? `"${paths[0]}" ${before}` : `${paths.length} files ${before}`, paths, true)
    }
    let unchanged = false
    try {
      unchanged = sameAsCurrent(await api.versionDiff(id, u.versionId, 'current'))
    } catch {
      // cannot tell: ask
    }
    if (destroyed || leaving) return true
    if (!unchanged) {
      const ok = await confirmDialog('Undo the restore', undoConfirmText(u.by), { confirmLabel: 'Undo restore', danger: true })
      if (!ok || destroyed || leaving) return false
    }
    return restoreVersion(u.preRestoreVersionId, before, undefined, true)
  }

  // ---------- builds ----------

  function updateBehind() {
    // Only compare synced docs: before the first sync the doc is empty or partial.
    behind = pdfUrl && file && fileReady && tracker ? tracker.check(file.fileId, file.doc) : null
  }

  /** Replace the diagnostics with those of a new build; `log` = the open file's changes since our compile started. */
  function applyDiagnostics(diags: Diagnostic[], log: ChangeLog | null) {
    const byFile = new Map<string, LineDiagnostic[]>()
    for (const fid of new Set(diags.flatMap(d => (d.fileId ? [d.fileId] : [])))) byFile.set(fid, linesForFile(diags, fid))
    fileLines = byFile
    if (file && fileReady) {
      const lines = byFile.get(file.fileId) ?? []
      anchors = log && log.fileId === file.fileId ? log.anchor(lines) : new FileDiagnostics(lines, file.ytext.toString())
      editorDiags = editorDiagnostics(anchors, file.ytext.length)
    }
    outlineTick++
  }

  /** Show a build result (ours or a collaborator's) with its PDF, log, diagnostics and snapshot. */
  function showBuild(r: BuildResult, source: string, log: ChangeLog | null = null) {
    const my = ++buildSeq
    logInfo = { status: r.status, durationMs: r.durationMs, log: r.log, diagnostics: r.diagnostics ?? [], source }
    applyDiagnostics(r.diagnostics ?? [], log)
    // A build without a PDF leaves the older PDF on screen, and with it that build's tracker and line maps.
    tracker = trackerAfterBuild(tracker, r)
    if (r.hasPdf) {
      resetSyncLines(log)
      pdfUrl = buildFileUrl(id, r.buildId, 'output.pdf')
      shown = { buildId: r.buildId, synctex: null }
      void buildHasOutput(id, r.buildId, 'output.synctex.gz').catch(() => false).then(ok => {
        if (my === buildSeq && !destroyed) shown = { buildId: r.buildId, synctex: ok }
      })
    }
    updateBehind()
    loadTexts()
  }

  /** A new PDF is shown: line numbers start from its build (the open file's text then: `log`, or now). */
  function resetSyncLines(log: ChangeLog | null) {
    if (!file || !fileReady) return syncLines.reset(null)
    const map = log && log.fileId === file.fileId ? LineMap.fromChangeLog(log) : LineMap.fromText(file.ytext.toString())
    syncLines.reset({ fileId: file.fileId, map })
  }

  /** On opening the project: the most recent build, whoever made it. */
  async function showLatestBuild() {
    const my = buildSeq
    try {
      const r = await api.latestBuild(id)
      if (my === buildSeq && !destroyed) showBuild(r, r.startedBy ? `compiled by ${r.startedBy}` : 'last build')
    } catch {
      // 404 no-build: nothing to show yet
    }
  }

  async function showForeignBuild(buildId: string, buildStatus: string) {
    const my = ++buildSeq
    try {
      const r = await api.latestBuild(id).catch(() => null)
      if (my !== buildSeq || destroyed) return
      if (r && r.buildId === buildId) {
        const who = r.startedBy || 'a collaborator'
        toast(`${who} compiled (${r.status}).`)
        showBuild(r, `compiled by ${who}`)
        return
      }
      // An older build than the latest (or the latest is not readable): show what we can.
      toast(`A collaborator compiled (${buildStatus}).`)
      logInfo = { status: buildStatus, durationMs: null, log: '', diagnostics: [], source: 'compiled by a collaborator' }
      const [text, hasPdf] = await Promise.all([fetchBuildLog(id, buildId).catch(() => '(log unavailable)'), buildHasOutput(id, buildId, 'output.pdf')])
      if (my !== buildSeq || destroyed) return
      logInfo = { status: buildStatus, durationMs: null, log: text, diagnostics: [], source: 'compiled by a collaborator' }
      applyDiagnostics([], null)
      if (hasPdf) {
        tracker = null
        resetSyncLines(null)
        pdfUrl = buildFileUrl(id, buildId, 'output.pdf')
        shown = { buildId, synctex: await buildHasOutput(id, buildId, 'output.synctex.gz').catch(() => false) }
      }
      updateBehind()
    } catch (e) {
      console.error('could not load build', e)
    }
  }

  /** One compile request (called by the auto-compiler: never two at once). */
  async function doCompile(trigger: CompileTrigger): Promise<CompileOutcome> {
    if (!canCompile || destroyed) return { kind: 'done' }
    compiling = true
    buildEvents.begin()
    const log = file && fileReady ? new ChangeLog(file.fileId, file.ytext.toString()) : null
    changeLog = log
    try {
      const r = await api.compile(id)
      // Builds that finished while ours was running were someone else's (ours is newer): just mention them.
      const older = buildEvents.succeeded(r.buildId)
      if (destroyed) return { kind: 'done' }
      showBuild(r, trigger === 'auto' ? 'auto-compile' : 'your compile', changeLog === log ? log : null)
      for (const ev of older) toast(`A collaborator compiled (${ev.status}).`)
      return { kind: 'done' }
    } catch (e) {
      const held = buildEvents.failed()
      if (destroyed) return { kind: 'done' }
      const back = backoffFor(errorCode(e))
      const msg = e instanceof ApiError && e.code === 'compiler-unavailable'
        ? `Compiler unavailable: ${e.message}`
        : `Compile failed: ${errorMessage(e)}`
      // Turned away (rate limit, busy compiler): nothing was built, so the last build's log and PDF stay.
      // A background compile only pauses auto-compile; a manual one also says why.
      const code = errorCode(e)
      const turnedAway = code === 'rate-limited' || code === 'compiler-busy'
      if (!(trigger === 'auto' && back)) toast(msg, 'error')
      if (!turnedAway && !(trigger === 'auto' && back)) logInfo = { status: 'error', durationMs: null, log: msg, diagnostics: [] }
      // A collaborator's build that finished meanwhile is now the newest: show it.
      const last = held.at(-1)
      if (last) void showForeignBuild(last.buildId, last.status)
      return back ? { kind: 'retry-later', ...back } : { kind: 'done' }
    } finally {
      if (changeLog === log) changeLog = null
      compiling = false
    }
  }

  function recompile() {
    if (canCompile) auto.compileNow()
  }

  // ---------- SyncTeX ----------

  /** Editor -> PDF: highlight the place of the cursor's line. */
  async function showInPdf() {
    if (showInPdfProblem || !shown || !file || !editor) {
      if (showInPdfProblem) toast(showInPdfProblem, 'error')
      return
    }
    const cur = editor.cursor()
    if (!cur) return
    try {
      // SyncTeX knows the build's line numbers: map the cursor's line back through the edits since.
      const line = syncLines.toBuild(file.fileId, cur.line, file.ytext.toString())
      const r = await api.synctexView(id, shown.buildId, file.fileId, line)
      if (r.boxes.length === 0) {
        toast('This line has no place in the PDF (it is not typeset, or the PDF is older than the line).', 'error')
        return
      }
      pdfView?.showBoxes(r.boxes)
    } catch (e) {
      toast(`Show in PDF failed: ${errorMessage(e, { 'not-found': 'No SyncTeX data for this build.' })}`, 'error')
    }
  }

  /** PDF -> editor: double-click on a page. */
  async function inverseSearch(page: number, x: number, y: number) {
    if (syncProblem || !shown) {
      if (syncProblem) toast(syncProblem, 'error')
      return
    }
    try {
      const r = await api.synctexEdit(id, shown.buildId, page, x, y)
      const entry = detail?.tree.find(e => e.id === r.fileId)
      if (!entry || entry.kind !== 'text') {
        toast(`"${r.path}" is no longer in the project.`, 'error')
        return
      }
      // The build's line, moved by the edits made since the build.
      const text = file && fileReady && file.fileId === r.fileId ? file.ytext.toString() : null
      openFile(entry, syncLines.toCurrent(r.fileId, r.line, text), true)
    } catch (e) {
      toast(errorMessage(e, { 'not-found': 'No source line found at that point of the PDF.' }), 'error')
    }
  }
</script>

{#snippet icon(name: string)}
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" aria-hidden="true">
    {#if name === 'history'}<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
    {:else if name === 'members'}<circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.4c1.8.8 3 2.8 3 5.6" />
    {:else if name === 'settings'}<path d="M12 2.5l2 2.6 3.2-.6.6 3.2 2.7 1.9-1.6 2.9 1 3.1-3.1 1-1 3.1-3.1-1L12 21.5l-1.7-2.8-3.1 1-1-3.1-3.1-1 1-3.1L2.5 9.6l2.7-1.9.6-3.2 3.2.6z" /><rect x="9" y="9" width="6" height="6" />
    {:else if name === 'trash'}<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    {:else if name === 'download'}<path d="M12 4v12M7 11l5 5 5-5M4 20h16" />
    {:else if name === 'chevron'}<path d="M6 9l6 6 6-6" />
    {:else if name === 'close'}<path d="M6 6l12 12M18 6L6 18" />
    {:else if name === 'target'}<circle cx="12" cy="12" r="6" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    {:else if name === 'recompile'}<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
    {:else if name === 'log'}<path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5" />
    {:else if name === 'filter'}<path d="M4 6h16M7 12h10M10 18h4" />
    {/if}
  </svg>
{/snippet}

{#if loadError}
  <main class="message">
    <p class="error">{loadError}</p>
    <a href="#/projects">Back to projects</a>
  </main>
{:else if !detail}
  <main class="message"><p class="muted">Loading project…</p></main>
{:else}
  <div class="layout">
    <header class="topbar">
      <div class="left">
        <a class="brand" href="#/projects" aria-label="Ligature, all projects"><Logo /></a>
        <a class="crumb" href="#/projects">All projects</a>
        <span class="slash" aria-hidden="true">/</span>
        <span class="menu" bind:this={menuEl}>
          <h1>
            <button type="button" class="project-name" aria-haspopup="menu" aria-expanded={menuOpen}
              title="Project menu: download, trash, settings" onclick={() => { menuOpen = !menuOpen; accountOpen = false }}>
              {detail.name}{@render icon('chevron')}
            </button>
          </h1>
          {#if menuOpen}
            <div class="menu-list" role="menu">
              <a role="menuitem" href={exportZipUrl(id)} download onclick={() => { menuOpen = false }}>{@render icon('download')} Download .zip</a>
              <button type="button" role="menuitem" onclick={() => togglePanel('trash')}>
                {@render icon('trash')} Trash{trash?.length ? ` (${trash.length})` : ''}
              </button>
              <button type="button" role="menuitem" onclick={() => togglePanel('settings')}>{@render icon('settings')} Settings</button>
            </div>
          {/if}
        </span>
        <span class="tag" title="Your role in this project"><span class="sr-only">Your role: </span>{detail.role}</span>
      </div>
      <span class="spacer"></span>
      {#if others.length}
        <ul class="peers" aria-label="Online now">
          {#each others.slice(0, 4) as p (p.id)}
            <li title="{p.name} is in this project now"><Avatar id={p.id} name={p.name} /><span class="peer-name">{p.name}</span></li>
          {/each}
          {#if others.length > 4}<li class="more" title={others.slice(4).map(p => p.name).join(', ')}>+{others.length - 4}</li>{/if}
        </ul>
      {/if}
      <div class="seg" role="group" aria-label="Project panels">
        <button type="button" class:on={panel === 'history'} aria-pressed={panel === 'history'} onclick={() => togglePanel('history')}>{@render icon('history')} History</button>
        <button type="button" class:on={panel === 'members'} aria-pressed={panel === 'members'} onclick={() => togglePanel('members')}>{@render icon('members')} Members</button>
        <button type="button" class:on={panel === 'settings'} aria-pressed={panel === 'settings'} title="Settings: compiler, main file, auto-compile, editor"
          onclick={() => togglePanel('settings')}>{@render icon('settings')} Settings</button>
      </div>
      <span class="menu" bind:this={accountEl}>
        <button type="button" class="account" aria-haspopup="menu" aria-expanded={accountOpen}
          aria-label="{me.displayName} (you): account menu with Log out" onclick={() => { accountOpen = !accountOpen; menuOpen = false }}>
          <Avatar id={me.id} name={me.displayName} size={26} />{@render icon('chevron')}
        </button>
        {#if accountOpen}
          <div class="menu-list right" role="menu">
            <div class="menu-head"><strong>{me.displayName}</strong><span class="muted">@{me.username}</span></div>
            <a role="menuitem" href="#/projects">All projects</a>
            <a role="menuitem" href="#/account">Account</a>
            {#if me.isAdmin}<a role="menuitem" href="#/admin">Admin</a>{/if}
            <button type="button" role="menuitem" onclick={logOutHere}>Log out</button>
          </div>
        {/if}
      </span>
    </header>

    <div class="workspace">
      <aside class="sidebar" aria-label="Document">
        <div class="side-tabs">
          <div role="tablist" aria-label="Sidebar" class="tablist">
            <button type="button" role="tab" aria-selected={prefs.sidebar === 'contents'} class:on={prefs.sidebar === 'contents'}
              title="Contents: the sections of the document, across all files" onclick={() => setPref('sidebar', 'contents')}>Contents</button>
            <button type="button" role="tab" aria-selected={prefs.sidebar === 'files'} class:on={prefs.sidebar === 'files'}
              title="Files: create, upload, rename, move; the trash is at the bottom" onclick={() => setPref('sidebar', 'files')}>Files</button>
          </div>
        </div>
        <div class="side-body">
          {#if prefs.sidebar === 'contents'}
            <nav class="contents" aria-label="Contents">
              {#if !detail.mainFileId}
                <p class="side-note">Choose a main file in Settings to see the contents.</p>
              {:else if outlineLoading && outline.length === 0}
                <p class="side-note">Reading the document…</p>
              {:else if outline.length === 0}
                <p class="side-note">No sections yet. Headings such as <code>\section&#123;…&#125;</code> appear here, from {mainName} and the files it includes.</p>
              {:else}
                <ol>
                  {#each outline as e, i (`${e.fileId}:${e.line}:${i}`)}
                    {@const mark = outlineMarks[i]}
                    <li>
                      <button type="button" class="entry depth-{Math.min(e.depth, 2)}" class:current={i === currentEntry}
                        title="{e.title} ({entryPath(detail.tree, e.fileId) ?? ''}:{e.line})" onclick={() => openOutlineEntry(e)}>
                        <span class="num">{e.number}</span>
                        <span class="ttl" class:unnumbered={e.unnumbered}>{e.title}</span>
                        {#if mark === 'error'}
                          <svg class="mark" width="11" height="11" viewBox="0 0 12 12" aria-label="has errors"><rect width="12" height="12" fill="var(--red)" /><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="#FFFFFF" stroke-width="1.6" /></svg>
                        {:else if mark === 'warning'}
                          <svg class="mark" width="11" height="11" viewBox="0 0 12 12" aria-label="has warnings"><path d="M6 1L11.5 11H0.5Z" fill="var(--amber-mark)" /><path d="M6 4.5v3.2M6 8.6v1" stroke="#FFFFFF" stroke-width="1.3" /></svg>
                        {/if}
                      </button>
                    </li>
                  {/each}
                </ol>
              {/if}
            </nav>
          {:else}
            <FileTree projectId={id} tree={detail.tree} rootId={detail.rootId} mainFileId={detail.mainFileId} {canEdit}
              openId={file?.fileId ?? preview?.id ?? null} onOpen={openEntry}
              onChanged={() => { void refreshProject(); void loadTrash() }}
              onSetMain={setMainFile} trashCount={trash?.length ?? null} trashOpen={panel === 'trash'}
              onToggleTrash={() => togglePanel('trash')} {highlightId} />
          {/if}
        </div>
      </aside>

      <section class="editor-pane" aria-label="Source">
        {#if reportShown}
          <div class="import-notice" role="status">
            <div class="import-text">
              {reportShown.summary}
              {#if reportShown.skipped.length}
                <ul>
                  {#each reportShown.skipped as s, i (i)}<li>{s}</li>{/each}
                  {#if reportShown.more}<li>… and {reportShown.more} more</li>{/if}
                </ul>
              {/if}
            </div>
            <button type="button" class="quiet small" title="Dismiss" aria-label="Dismiss" onclick={() => { importReport = null }}>{@render icon('close')}</button>
          </div>
        {/if}
        <div class="pane-head">
          <span class="path" title={openPath}>
            {#if openPath}
              {#each crumbs.dirs as d, i (i)}<span class="dir">{d}</span><span class="sep">/</span>{/each}<span class="file">{crumbs.name}</span>
              {#if file && !canEdit}<span class="tag ro">Read-only</span>{/if}
            {:else}
              <span class="muted">No file open</span>
            {/if}
          </span>
          {#if backTo}
            <button type="button" class="small back" onclick={goBack}
              title="Return to {backTo.path}:{backTo.line}, where you were before the last jump to a definition">
              <span>← Back to {backTo.name}:{backTo.line}</span>
            </button>
          {/if}
          {#if preview}<a class="button small" href={rawFileUrl(id, preview.id)} download={preview.name}>{@render icon('download')} Download</a>{/if}
          <button type="button" class="small" onclick={showInPdf} disabled={showInPdfProblem !== null}
            aria-keyshortcuts="Control+Alt+J" title={showInPdfProblem ?? 'Show the cursor’s line in the PDF (Ctrl+Alt+J). Double-click the PDF to jump back.'}>
            {@render icon('target')} Show in PDF
          </button>
        </div>
        <div class="pane-body">
          {#if fileError}
            <div class="message">
              <p class="error">{fileError}</p>
              <button type="button" onclick={() => location.reload()}>Reload</button>
            </div>
          {:else if preview}
            <div class="preview">
              <img src="{rawFileUrl(id, preview.id, true)}&v={detail.treeVersion}" alt={preview.name} />
            </div>
          {:else if file && fileReady}
            {#key file}
              {#key canEdit}
                <Editor bind:this={editor} ytext={file.ytext} awareness={file.awareness} undoManager={file.undoManager}
                  readOnly={!canEdit} diagnostics={editorDiags} fontSize={prefs.fontSize} wrap={prefs.wrap}
                  explain={d => explain(d, mainName)} onFix={applyFix} {completion}
                  {definitionAt} onGoToDefinition={goToDefinition}
                  onCursor={(line, column) => { cursorPos = { line, column } }} />
              {/key}
            {/key}
          {:else if file || recovering}
            <div class="message muted">Loading file…</div>
          {:else}
            <div class="message">
              {#if fileNotice}<p class="notice">{fileNotice}</p>{/if}
              <p class="muted">Pick a file in Files, or a section in Contents.</p>
            </div>
          {/if}
        </div>
        <div class="problems" class:collapsed={prefs.problemsCollapsed}>
          <LogPanel info={logInfo} onJump={jumpTo} onProblem={openProblem} bind:tab={logTab}
            bind:collapsed={() => prefs.problemsCollapsed, v => setPref('problemsCollapsed', v)} />
        </div>
      </section>

      <section class="output" aria-label="PDF preview">
        <PdfView bind:this={pdfView} url={pdfUrl} onInverseSearch={inverseSearch}
          pageTitle={syncProblem ?? 'Double-click to open the source at that line'}
          placeholder={canCompile ? 'No PDF yet. Press Recompile (Ctrl+S).' : 'No PDF yet. It appears when an editor compiles.'}>
          {#snippet toolbar()}
            <span class="split menu" bind:this={compileMenuEl}>
              <button type="button" class="primary" onclick={recompile} disabled={!canCompile || compiling}
                title={canCompile ? 'Compile (Ctrl+S)' : 'Viewers cannot compile'} aria-keyshortcuts="Control+S">
                <span class:spin={compiling}>{@render icon('recompile')}</span>
                {compiling ? 'Compiling…' : 'Recompile'}
              </button>
              <button type="button" class="primary caret" aria-label="Compile options: download PDF, raw log, settings"
                aria-haspopup="menu" aria-expanded={compileMenuOpen} onclick={() => { compileMenuOpen = !compileMenuOpen }}>
                {@render icon('chevron')}
              </button>
              {#if compileMenuOpen}
                <div class="menu-list" role="menu">
                  {#if pdfUrl}
                    <a role="menuitem" href={pdfUrl} download="{detail?.name ?? 'output'}.pdf" onclick={() => { compileMenuOpen = false }}>{@render icon('download')} Download PDF</a>
                  {/if}
                  <button type="button" role="menuitem" disabled={!logInfo}
                    onclick={() => { logTab = 'log'; setPref('problemsCollapsed', false); compileMenuOpen = false }}>{@render icon('log')} Raw log</button>
                  <button type="button" role="menuitem" onclick={() => { compileMenuOpen = false; togglePanel('settings') }}>
                    {@render icon('settings')} Compiler and auto-compile…
                  </button>
                </div>
              {/if}
            </span>
          {/snippet}
          {#snippet status()}
            <div class="build-status" role="status">
              {#if compiling}
                <p class="first"><span class="dot busy"></span><strong>Compiling…</strong> <span class="muted">{engineLabel(detail?.engine ?? '')}</span></p>
              {:else if logInfo}
                {@const ok = logInfo.status === 'success'}
                <p class="first">
                  {#if ok}
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" fill="var(--green)" /><path d="M3 6.2l2 2 4-4.4" stroke="#FFFFFF" stroke-width="1.6" fill="none" /></svg>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" fill="var(--red)" /><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="#FFFFFF" stroke-width="1.6" /></svg>
                  {/if}
                  <strong class:failed={!ok}>{statusLabel(logInfo.status)}</strong>
                  {#if logInfo.durationMs !== null}<span class="sep">·</span><span>{(logInfo.durationMs / 1000).toFixed(1)} s</span>{/if}
                  {#if logInfo.source}<span class="sep">·</span><span class="muted">{logInfo.source}</span>{/if}
                </p>
              {:else}
                <p class="first muted">No build yet.</p>
              {/if}
              {#if behind || autoState?.pausedUntil}
                <p class="second">
                  {#if behind}<span class="behind">PDF is behind your edits</span>{/if}
                  {#if autoState?.pausedUntil}
                    <span class="behind" title="Auto-compile waits until {new Date(autoState.pausedUntil).toLocaleTimeString()}">
                      Auto-compile paused: {autoState.pauseReason}
                    </span>
                  {/if}
                </p>
              {/if}
            </div>
          {/snippet}
        </PdfView>

        {#if panel !== 'none'}
          <aside class="side-panel" aria-label={panelTitle}>
            <div class="side-head">
              <span class="side-title">
                {@render icon(panel === 'trash' ? 'trash' : panel)}
                <span class="eyebrow">{panelTitle}</span>
                {#if panel === 'settings'}<span class="muted sub">Changes save as you make them</span>{/if}
              </span>
              <button type="button" class="small close" aria-label="Close {panelTitle}" onclick={() => { panel = 'none'; diffReq = null }}>{@render icon('close')}</button>
            </div>
            <div class="side-scroll">
              {#if panel === 'settings'}
                <SettingsPanel {detail} {me} onUpdated={applyDetail} autoCompile={autoOn} onAutoCompile={setAuto} {compiling}
                  onRecompile={recompile} onDeleted={() => { leaving = true; toast('Project deleted.'); go('/projects') }} />
              {:else if panel === 'members'}
                <MembersPanel bind:this={membersPanel} projectId={id} projectName={detail.name} {me} role={detail.role} />
              {:else if panel === 'history'}
                <HistoryPanel bind:this={historyPanel} projectId={id} tree={detail.tree} rootId={detail.rootId} {canEdit}
                  onOpenDiff={d => { diffReq = d }} onRestore={restoreFromHistory} />
              {:else}
                <TrashPanel projectId={id} entries={trash} loadError={trashError} tree={detail.tree} {canEdit}
                  isOwner={detail.role === 'owner'} {onRestored} onChanged={() => void loadTrash()} />
              {/if}
            </div>
          </aside>
        {/if}
      </section>

      {#if panel === 'history' && diffReq}
        <section class="diff-overlay" aria-label="Differences">
          <FileDiff projectId={id} row={diffReq.row} left={diffReq.left} right={diffReq.right} leftTitle={diffReq.leftTitle}
            rightTitle={diffReq.rightTitle} onClose={() => { diffReq = null }} />
        </section>
      {/if}
    </div>

    <footer class="statusbar">
      <span class="hint">
        {#if !canEdit}You are a viewer: read-only.{:else}Ctrl+S compiles · Ctrl+Alt+J shows the cursor in the PDF{/if}
      </span>
      <span class="spacer"></span>
      {#if cursorPos && file && fileReady}<span class="pos">Ln {cursorPos.line}, Col {cursorPos.column}</span>{/if}
      <span class="conn conn-{status}" title="Connection to the collaboration server">
        <span class="sq" aria-hidden="true"></span>{status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Offline: edits are kept and sent on reconnect'}
      </span>
      <button type="button" class="engine" title="Compiler (change it in Settings)" onclick={() => togglePanel('settings')}>
        {engineLabel(detail.engine)}{@render icon('chevron')}
      </button>
    </footer>

    {#if recovery}
      <RecoveryDialog path={recovery.path} localText={recovery.localText} serverText={recovery.serverText}
        error={recovery.error} onCopy={copyRecoveryText} onOpenCurrent={closeRecovery} />
    {/if}
  </div>
{/if}

<style>
  .layout {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    overflow: hidden;
  }

  /* ---------- top bar ---------- */
  .topbar {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 16px;
    min-height: 46px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
  }
  .left { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .brand { position: relative; top: -3px; display: inline-flex; color: var(--ink); text-decoration: none; margin-right: 4px; }
  .crumb { color: var(--ink-3); text-decoration: none; }
  .crumb:hover { color: var(--ink); text-decoration: underline; }
  .slash { color: var(--ink-4); }
  h1 { display: inline-flex; margin: 0; font: inherit; }
  .project-name {
    height: 30px;
    margin-left: -6px;
    padding: 0 6px;
    border-color: transparent;
    background: transparent;
    font: 600 18px/1 var(--font-doc);
    color: var(--ink);
    gap: 6px;
  }
  .project-name:hover:not(:disabled), .project-name[aria-expanded='true'] { background: var(--paper-2); border-color: var(--rule-strong); }
  .spacer { flex: 1 1 0; }
  .peers { display: flex; align-items: center; gap: 6px 16px; margin: 0; padding: 0; list-style: none; }
  .peers li { display: flex; align-items: center; gap: 7px; font-size: 12.5px; white-space: nowrap; }
  .peers .more { color: var(--ink-3); font-weight: 500; }
  .seg { display: flex; height: 30px; border: 1px solid var(--rule-strong); background: var(--sheet); }
  .seg button { min-height: 0; border: 0; background: transparent; color: var(--ink-2); }
  .seg button + button { border-left: 1px solid var(--rule-strong); }
  .seg button:hover:not(:disabled) { background: var(--paper-2); }
  .seg button.on { background: var(--paper-2); box-shadow: inset 0 -2px 0 var(--teal); color: var(--ink); }
  .account { border: 0; background: transparent; padding: 0 2px; gap: 5px; color: var(--ink-3); }
  .account:hover:not(:disabled) { background: transparent; }

  .menu { position: relative; display: inline-flex; }
  .menu-list {
    position: absolute;
    left: 0;
    top: calc(100% + 4px);
    z-index: 60;
    display: flex;
    flex-direction: column;
    min-width: 200px;
    padding: 4px 0;
    background: var(--sheet);
    border: 1px solid var(--rule-strong);
    box-shadow: var(--shadow);
  }
  .menu-list.right { left: auto; right: 0; }
  .menu-list a, .menu-list button {
    display: flex;
    justify-content: flex-start;
    gap: 9px;
    min-height: 32px;
    padding: 0 14px;
    border: 0;
    background: none;
    font: 400 13px/1 var(--font-ui);
    color: var(--ink);
    text-decoration: none;
    align-items: center;
    white-space: nowrap;
  }
  .menu-list a:hover, .menu-list button:hover:not(:disabled) { background: var(--paper-2); color: var(--ink); }
  .menu-head { display: flex; flex-direction: column; gap: 2px; padding: 8px 14px 10px; border-bottom: 1px solid var(--rule-soft); margin-bottom: 4px; }

  /* ---------- workspace ---------- */
  .workspace {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
  .sidebar {
    grid-column: 1;
    grid-row: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--rule);
    background: var(--paper);
  }
  .side-tabs { flex: none; display: flex; height: 36px; border-bottom: 1px solid var(--rule); background: var(--paper-2); }
  .tablist { display: flex; flex: 1; }
  .tablist button {
    flex: 1;
    min-height: 0;
    margin-bottom: -1px;
    border: 0;
    border-top: 2px solid transparent;
    border-right: 1px solid var(--rule);
    background: transparent;
    font: 600 10.5px/1 var(--font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .tablist button:last-child { border-right: 0; }
  .tablist button:hover:not(:disabled) { background: var(--paper); color: var(--ink); }
  .tablist button.on { background: var(--paper); border-top-color: var(--teal); color: var(--ink); border-bottom: 1px solid var(--paper); }
  .side-body { flex: 1; min-height: 0; overflow: auto; }
  .contents { padding: 8px 0; font-family: var(--font-doc); }
  .contents ol { list-style: none; margin: 0; padding: 0; }
  .entry {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    width: 100%;
    min-height: 28px;
    padding: 0 12px 0 14px;
    border: 0;
    border-left: 2px solid transparent;
    background: none;
    font: 400 14px/1.2 var(--font-doc);
    color: var(--ink);
    gap: 0;
    text-align: left;
  }
  .entry:hover:not(:disabled) { background: var(--paper-2); }
  .entry.current { background: var(--teal-tint); border-left-color: var(--teal); }
  .entry .num { flex: 0 0 28px; color: var(--ink-3); font-size: 13px; font-variant-numeric: tabular-nums; }
  .entry.depth-1 { padding-left: 30px; font-size: 13.5px; }
  .entry.depth-1 .num { flex-basis: 30px; }
  .entry.depth-2 { padding-left: 46px; font-size: 13px; color: var(--ink-2); }
  .entry.depth-2 .num { flex-basis: 38px; }
  .ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ttl.unnumbered { font-style: italic; }
  .entry.depth-0 .ttl:not(.unnumbered) { font-weight: 600; }
  .mark { flex: none; margin-left: 6px; }
  .side-note { margin: 10px 16px; font: 400 12.5px/1.45 var(--font-ui); color: var(--ink-4); }

  .editor-pane {
    grid-column: 2;
    grid-row: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--sheet);
  }
  .import-notice {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 12px;
    font-size: 12.5px;
    background: var(--green-tint);
    border-bottom: 1px solid var(--rule);
    max-height: 30%;
    overflow: auto;
  }
  .import-text { flex: 1; }
  .import-text ul { margin: 4px 0 0; padding-left: 18px; font-size: 12px; }
  .pane-head {
    flex: none;
    display: flex;
    gap: 8px;
    align-items: center;
    height: 36px;
    padding: 0 8px 0 14px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
  }
  .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; }
  .path .dir { color: var(--ink-3); }
  .path .sep { color: var(--ink-4); margin: 0 3px; }
  .path .file { font: 500 13px/1 var(--font-mono); color: var(--ink); }
  .path .ro { margin-left: 10px; }
  .back { flex: 0 1 auto; min-width: 0; max-width: 45%; color: var(--teal); border-color: var(--teal-edge); background: var(--teal-tint); }
  .back:hover:not(:disabled) { background: var(--teal-tint); color: var(--teal-dark); border-color: var(--teal); }
  .back span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pane-body { flex: 1; min-height: 0; overflow: auto; }
  .preview {
    padding: 16px;
    background: repeating-conic-gradient(var(--paper-2) 0 25%, var(--sheet) 0 50%) 0 0 / 16px 16px;
    min-height: 100%;
  }
  .preview img { max-width: 100%; height: auto; display: block; margin: 0 auto; outline: 1px solid var(--rule); }
  .problems {
    flex: none;
    height: 168px;
    border-top: 1px solid var(--rule);
  }
  .problems.collapsed { height: 37px; }

  .output {
    grid-column: 3;
    grid-row: 1;
    position: relative;
    min-height: 0;
    min-width: 0;
    border-left: 1px solid var(--rule);
  }
  .split { display: inline-flex; }
  .split .caret { width: 28px; padding: 0; border-left: 1px solid var(--teal-edge); }
  .split .menu-list { top: calc(100% + 4px); }
  .spin { display: inline-flex; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .build-status { flex: none; padding: 8px 14px 9px; border-bottom: 1px solid var(--rule); background: var(--paper); font-size: 12.5px; }
  .build-status p { margin: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .build-status .second { margin-top: 3px; }
  .build-status strong { font-weight: 600; color: var(--green); }
  .build-status strong.failed { color: var(--red); }
  .build-status .sep { color: var(--ink-4); }
  .behind { color: var(--amber); font-weight: 500; }
  .behind + .behind::before { content: '·'; color: var(--ink-4); margin-right: 6px; }
  .dot.busy { width: 10px; height: 10px; border: 2px solid var(--teal); border-right-color: transparent; animation: spin 0.8s linear infinite; }
  .build-status .first strong { color: var(--ink); }
  .build-status .first strong.failed { color: var(--red); }
  .build-status .first svg + strong:not(.failed) { color: var(--green); }

  .side-panel {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    background: var(--sheet);
  }
  .side-head {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: 44px;
    padding: 0 10px 0 16px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
  }
  .side-title { display: flex; align-items: center; gap: 10px; min-width: 0; color: var(--ink-3); }
  .side-title .eyebrow { color: var(--ink); }
  .side-title .sub { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .close { width: 28px; padding: 0; }
  .side-scroll { flex: 1; min-height: 0; overflow: auto; }
  .diff-overlay {
    grid-column: 1 / 3;
    grid-row: 1;
    z-index: 15;
    min-height: 0;
    border-right: 1px solid var(--rule-strong);
    box-shadow: var(--shadow);
    background: var(--sheet);
  }

  /* ---------- status bar ---------- */
  .statusbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 20px;
    height: 26px;
    padding: 0 6px 0 14px;
    border-top: 1px solid var(--rule);
    background: var(--paper);
    font-size: 12px;
    color: var(--ink-3);
  }
  .statusbar .hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pos { font-variant-numeric: tabular-nums; }
  .conn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .sq { width: 7px; height: 7px; background: var(--green); }
  .conn-connecting .sq { background: var(--amber-mark); }
  .conn-disconnected { color: var(--red); }
  .conn-disconnected .sq { background: var(--red); }
  .engine { min-height: 22px; border: 0; background: transparent; padding: 0 8px; gap: 5px; font-size: 12px; font-weight: 500; color: var(--ink-2); }

  .message { padding: 20px; }
  .notice { color: var(--amber); }

  @media (max-width: 1100px) {
    .workspace { grid-template-columns: 210px minmax(0, 1fr) minmax(0, 1fr); }
    .peer-name { display: none; }
  }
</style>
