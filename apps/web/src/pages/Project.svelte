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
  let pendingJump: { line: number; flash: boolean } | null = null

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

  // Auto-compile only for owners/editors, and only while the toggle is on.
  $effect(() => { auto.setEnabled(canCompile && autoOn) })

  // The "Project ▾" menu closes on a click outside it and on Escape.
  $effect(() => {
    if (!menuOpen) return
    return dismissMenu(window, t => !!menuEl && t instanceof Node && menuEl.contains(t), () => { menuOpen = false })
  })

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

  function setAuto(on: boolean) {
    autoOn = on
    saveAutoCompile(localStorageOrNull(), id, on)
  }

  // ---------- files ----------

  function onDocUpdate(_update: Uint8Array, origin: unknown) {
    if (file?.isLocal(origin)) auto.localEdit()
    // Not needed per keystroke: coalesce (a Y snapshot walks the whole doc).
    if (behindTimer) return
    behindTimer = setTimeout(() => {
      behindTimer = null
      updateBehind()
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

  function openFile(entry: TreeEntry, jumpTo: number | null = null, flash = false) {
    if (!collab || entry.kind !== 'text' || entry.epoch === undefined) return
    preview = null
    fileNotice = null
    const jump = jumpTo === null ? null : { line: jumpTo, flash }
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
      editor.gotoLine(pendingJump.line, pendingJump.flash)
      pendingJump = null
    }
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
    detail = d
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
      <a href="#/projects" title="All projects">&larr;</a>
      <strong>{detail.name}</strong>
      <span class="pill" title="Your role in this project">{detail.role}</span>
      <span class="conn conn-{status}" title="Connection to the collaboration server">{status}</span>
      <span class="peers">
        {#each peers as p (p.id)}
          <span class="peer" style="border-color: {p.color}" title={p.name}>
            <span class="dot" style="background: {p.color}"></span>{p.name}{p.id === me.id ? ' (you)' : ''}
          </span>
        {/each}
      </span>
      <span class="spacer"></span>
      {#if behind}<span class="behind" title="The open file has changed since the last compile">PDF is behind</span>{/if}
      {#if autoState?.pausedUntil}
        <span class="behind" title="Auto-compile waits until {new Date(autoState.pausedUntil).toLocaleTimeString()}">
          Auto-compile paused: {autoState.pauseReason}
        </span>
      {/if}
      {#if canCompile}
        <label class="auto" title="Compile 2.5 s after you stop typing (saved for this project in this browser)">
          <input type="checkbox" checked={autoOn} onchange={e => setAuto(e.currentTarget.checked)} /> Auto-compile
        </label>
      {/if}
      <button type="button" class="primary" onclick={recompile} disabled={!canCompile || compiling}
        title={canCompile ? 'Compile (Ctrl+S)' : 'Viewers cannot compile'}>
        {compiling ? 'Compiling…' : 'Recompile'}
      </button>
      <button type="button" class:active={panel === 'settings'} onclick={() => togglePanel('settings')}>Settings</button>
      <button type="button" class:active={panel === 'members'} onclick={() => togglePanel('members')}>Members</button>
      <button type="button" class:active={panel === 'history'} onclick={() => togglePanel('history')}>History</button>
      <span class="menu" bind:this={menuEl}>
        <button type="button" class:active={menuOpen} aria-haspopup="menu" aria-expanded={menuOpen}
          onclick={() => { menuOpen = !menuOpen }}>Project ▾</button>
        {#if menuOpen}
          <div class="menu-list" role="menu">
            <a role="menuitem" href={exportZipUrl(id)} download onclick={() => { menuOpen = false }}>Download .zip</a>
            <button type="button" role="menuitem" onclick={() => togglePanel('trash')}>Trash{trash?.length ? ` (${trash.length})` : ''}</button>
          </div>
        {/if}
      </span>
      <span class="muted">{me.displayName}</span>
      <button type="button" onclick={logOutHere}>Log out</button>
    </header>

    <aside class="files">
      <FileTree projectId={id} tree={detail.tree} rootId={detail.rootId} mainFileId={detail.mainFileId} {canEdit}
        openId={file?.fileId ?? preview?.id ?? null} onOpen={openEntry}
        onChanged={() => { void refreshProject(); void loadTrash() }}
        onSetMain={setMainFile} trashCount={trash?.length ?? null} trashOpen={panel === 'trash'}
        onToggleTrash={() => togglePanel('trash')} {highlightId} />
    </aside>

    <section class="editor-pane">
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
          <button type="button" title="Dismiss" onclick={() => { importReport = null }}>×</button>
        </div>
      {/if}
      <div class="pane-title">
        <span class="path">{openPath || 'No file open'}{#if file && !canEdit}<span class="muted"> (read-only)</span>{/if}</span>
        {#if preview}<a class="dl" href={rawFileUrl(id, preview.id)} download={preview.name}>Download</a>{/if}
        <button type="button" class="sync" onclick={showInPdf} disabled={showInPdfProblem !== null}
          title={showInPdfProblem ?? 'Show the cursor’s line in the PDF (Ctrl+Alt+J)'}>Show in PDF</button>
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
                readOnly={!canEdit} diagnostics={editorDiags} />
            {/key}
          {/key}
        {:else if file || recovering}
          <div class="message muted">Loading file…</div>
        {:else}
          <div class="message">
            {#if fileNotice}<p class="notice">{fileNotice}</p>{/if}
            <p class="muted">Pick a file on the left.</p>
          </div>
        {/if}
      </div>
    </section>

    <section class="output">
      <div class="pdf-pane">
        <PdfView bind:this={pdfView} url={pdfUrl} onInverseSearch={inverseSearch}
          pageTitle={syncProblem ?? 'Double-click to open the source at that line'}
          placeholder={canCompile ? 'No PDF yet. Click Recompile.' : 'No PDF yet. Wait for an editor to compile.'} />
      </div>
      <div class="log-pane">
        <LogPanel info={logInfo} onJump={jumpTo} onProblem={openProblem} />
      </div>
    </section>

    {#if panel === 'history' && diffReq}
      <section class="diff-overlay" aria-label="Differences">
        <FileDiff projectId={id} row={diffReq.row} left={diffReq.left} right={diffReq.right} leftTitle={diffReq.leftTitle}
          rightTitle={diffReq.rightTitle} onClose={() => { diffReq = null }} />
      </section>
    {/if}

    {#if recovery}
      <RecoveryDialog path={recovery.path} localText={recovery.localText} serverText={recovery.serverText}
        error={recovery.error} onCopy={copyRecoveryText} onOpenCurrent={closeRecovery} />
    {/if}

    {#if panel !== 'none'}
      <aside class="side-panel" class:wide={panel === 'history'} aria-label={panelTitle}>
        <div class="side-head">
          <strong>{panelTitle}</strong>
          <button type="button" onclick={() => { panel = 'none'; diffReq = null }}>Close</button>
        </div>
        {#if panel === 'settings'}
          <SettingsPanel {detail} onUpdated={applyDetail} />
        {:else if panel === 'members'}
          <MembersPanel bind:this={membersPanel} projectId={id} projectName={detail.name} {me} role={detail.role} />
        {:else if panel === 'history'}
          <HistoryPanel bind:this={historyPanel} projectId={id} tree={detail.tree} rootId={detail.rootId} {canEdit}
            onOpenDiff={d => { diffReq = d }} onRestore={restoreFromHistory} />
        {:else}
          <TrashPanel projectId={id} entries={trash} loadError={trashError} tree={detail.tree} {canEdit}
            isOwner={detail.role === 'owner'} {onRestored} onChanged={() => void loadTrash()} />
        {/if}
      </aside>
    {/if}
  </div>
{/if}

<style>
  .layout {
    height: 100vh;
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      'top top top'
      'files editor output';
    position: relative;
  }
  .topbar {
    grid-area: top;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #ccc;
    background: #f6f6f6;
    flex-wrap: wrap;
  }
  .topbar a { text-decoration: none; font-size: 18px; }
  .topbar button.active { background: #dde4ff; }
  .spacer { flex: 1; }
  .pill {
    font-size: 12px;
    padding: 1px 6px;
    border-radius: 8px;
    background: #e0e0e0;
  }
  .conn { font-size: 12px; }
  .conn::before { content: '● '; }
  .conn-connected { color: #1b7f3b; }
  .conn-connecting { color: #a15c00; }
  .conn-disconnected { color: #b00020; }
  .peers { display: flex; gap: 6px; flex-wrap: wrap; }
  .peer {
    font-size: 12px;
    border: 1px solid;
    border-radius: 10px;
    padding: 0 6px;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 4px;
  }
  .behind {
    font-size: 12px;
    color: #a15c00;
  }
  .auto {
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .menu { position: relative; }
  .menu-list {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 60;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    background: white;
    border: 1px solid #bbb;
    border-radius: 3px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }
  .menu-list a, .menu-list button {
    display: block;
    padding: 6px 12px;
    text-align: left;
    border: 0;
    border-radius: 0;
    background: none;
    font-size: 14px;
    color: inherit;
    text-decoration: none;
  }
  .menu-list a:hover, .menu-list button:hover { background: #eef; }
  .files {
    grid-area: files;
    overflow: auto;
    border-right: 1px solid #ccc;
  }
  .editor-pane {
    grid-area: editor;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid #ccc;
  }
  .import-notice {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 6px 10px;
    font-size: 13px;
    background: #eef6ee;
    border-bottom: 1px solid #b9d8b9;
    max-height: 30%;
    overflow: auto;
  }
  .import-text { flex: 1; }
  .import-text ul { margin: 4px 0 0; padding-left: 18px; font-size: 12px; }
  .import-notice button { padding: 0 8px; }
  .pane-title {
    font-size: 12px;
    padding: 4px 8px;
    border-bottom: 1px solid #ddd;
    background: #fafafa;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .pane-title .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pane-title .sync { font-size: 12px; padding: 1px 8px; }
  .pane-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .preview {
    padding: 12px;
    background: repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0 / 16px 16px;
    min-height: 100%;
  }
  .preview img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  .output {
    grid-area: output;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .pdf-pane {
    flex: 1;
    min-height: 0;
  }
  .log-pane {
    height: 30%;
    min-height: 80px;
    border-top: 1px solid #ccc;
  }
  .side-panel {
    position: absolute;
    top: 42px;
    right: 0;
    bottom: 0;
    width: min(420px, 100vw);
    background: white;
    border-left: 1px solid #bbb;
    box-shadow: -2px 0 8px rgba(0, 0, 0, 0.15);
    padding: 10px 14px;
    overflow: auto;
    z-index: 50;
  }
  .side-panel.wide { width: min(440px, 100vw); }
  .diff-overlay {
    position: absolute;
    top: 42px;
    left: 0;
    right: min(440px, 100vw);
    bottom: 0;
    z-index: 45;
    border-right: 1px solid #bbb;
    box-shadow: 0 0 8px rgba(0, 0, 0, 0.15);
    background: white;
  }
  .side-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }
  .message { padding: 16px; }
  .notice { color: #a15c00; }
  .primary:disabled {
    background: #9db3e8;
    border-color: #9db3e8;
  }
</style>
