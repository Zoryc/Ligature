<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import { can, type Me, type MetaEvent, type ProjectDetail, type TreeEntry } from '@ligature/shared'
  import { api, ApiError, buildFileUrl, buildHasPdf, fetchBuildLog, rawFileUrl, type BuildResult } from '../lib/api.ts'
  import { ProjectCollab, type ConnectionStatus, type FileSession, type PresenceUser } from '../lib/collab.ts'
  import { userColor } from '../lib/colors.ts'
  import { treeRows, textFilesByPath } from '../lib/tree.ts'
  import { entryPath, isInlineImage, openFileOutcome } from '../lib/treeOps.ts'
  import { authFailedActions, closeActions, metaEventActions, resyncActions, type ProjectAction } from '../lib/projectEvents.ts'
  import { BehindTracker } from '../lib/behind.ts'
  import { BuildEvents } from '../lib/buildEvents.ts'
  import type { LogInfo } from '../lib/logParse.ts'
  import { errorMessage } from '../lib/errors.ts'
  import { toast } from '../lib/toasts.svelte.ts'
  import { go } from '../lib/router.svelte.ts'
  import { loadMe, logout } from '../lib/session.svelte.ts'
  import FileTree from '../lib/FileTree.svelte'
  import Editor from '../lib/Editor.svelte'
  import PdfView from '../lib/PdfView.svelte'
  import LogPanel from '../lib/LogPanel.svelte'
  import SettingsPanel from '../lib/SettingsPanel.svelte'
  import MembersPanel from '../lib/MembersPanel.svelte'

  interface Props { id: string; me: Me }
  let { id, me }: Props = $props()

  // Project + presence
  let detail = $state.raw<ProjectDetail | null>(null)
  let loadError = $state<string | null>(null)
  let status = $state<ConnectionStatus>('connecting')
  let peers = $state.raw<PresenceUser[]>([])
  let panel = $state<'none' | 'settings' | 'members'>('none')
  let membersPanel = $state<ReturnType<typeof MembersPanel> | undefined>(undefined)

  // Open file (text, in the editor) or preview (image)
  let file = $state.raw<FileSession | null>(null)
  let fileReady = $state(false)
  let fileError = $state<string | null>(null)
  /** Informational message in the editor pane (e.g. "the file was deleted"). */
  let fileNotice = $state<string | null>(null)
  let preview = $state.raw<TreeEntry | null>(null)
  let editor = $state.raw<ReturnType<typeof Editor> | undefined>(undefined)
  let pendingJump: number | null = null

  // Builds
  let compiling = $state(false)
  let logInfo = $state.raw<LogInfo | null>(null)
  let pdfUrl = $state<string | null>(null)
  /** Baselines of the last build we started (null for collaborators' builds: no snapshot for those) */
  let tracker: BehindTracker | null = null
  let behind = $state<boolean | null>(null)
  let behindTimer: ReturnType<typeof setTimeout> | null = null
  const buildEvents = new BuildEvents()
  /** Increments for every build we start showing, so stale async loads are dropped. */
  let buildSeq = 0

  let rows = $derived(detail ? treeRows(detail.tree, detail.rootId) : [])
  let byPath = $derived(textFilesByPath(rows))
  let canEdit = $derived(detail ? can.edit(detail.role) : false)
  let canCompile = $derived(detail ? can.compile(detail.role) : false)
  let openPath = $derived.by(() => {
    const shownId = file?.fileId ?? preview?.id
    return detail && shownId ? entryPath(detail.tree, shownId) ?? '' : ''
  })

  let collab: ProjectCollab | null = null
  let destroyed = false
  /** Set once we are on our way out (project deleted / access lost): no more notices. */
  let leaving = false

  onMount(() => {
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
    })()
  })

  onDestroy(() => {
    destroyed = true
    if (behindTimer) clearTimeout(behindTimer)
    closeFile()
    collab?.destroy()
    collab = null
  })

  // ---------- files ----------

  function onDocUpdate() {
    // Not needed per keystroke: coalesce (a Y snapshot walks the whole doc).
    if (behindTimer) return
    behindTimer = setTimeout(() => {
      behindTimer = null
      updateBehind()
    }, 250)
  }

  function closeFile() {
    if (!file) return
    file.doc.off('update', onDocUpdate)
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

  function openFile(entry: TreeEntry, jumpTo: number | null = null) {
    if (!collab || entry.kind !== 'text' || entry.epoch === undefined) return
    preview = null
    fileNotice = null
    if (file && file.fileId === entry.id && file.epoch === entry.epoch) {
      if (jumpTo !== null) {
        pendingJump = jumpTo
        applyPendingJump() // or later, once the file has synced
      }
      return
    }
    closeFile()
    pendingJump = jumpTo
    fileError = null
    const s: FileSession = collab.openFile(entry.id, entry.epoch, {
      onSynced: () => {
        if (file !== s) return
        if (!fileReady) {
          fileReady = true
          void tick().then(applyPendingJump)
        }
        updateBehind()
      },
      onAuthFailed: reason => { if (file === s) runActions(authFailedActions(reason, 'file')) },
      onClosed: reason => { if (file === s) runActions(closeActions(reason, 'file')) },
    })
    s.doc.on('update', onDocUpdate)
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

  function applyPendingJump() {
    if (pendingJump !== null && editor) {
      editor.gotoLine(pendingJump)
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
    openFile(entry, line)
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
    if (preview && !d.tree.some(e => e.id === preview?.id && e.kind === 'binary')) {
      fileNotice = `"${preview.name}" was deleted.`
      preview = null
    }
    if (!file) return
    const outcome = openFileOutcome(d.tree, file.fileId, file.epoch)
    if (outcome === 'deleted') {
      const name = openPath || 'The open file'
      closeFile()
      fileNotice = `"${name}" was deleted.`
      toast(fileNotice)
    } else if (outcome === 'reopen') {
      toast('This file was reset on the server; reopening it.')
      reopenFile()
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
        case 'drop-peer':
          collab?.dropPeer(a.userId)
          break
        case 'refresh-members':
          void membersPanel?.reload()
          break
        case 'compile-finished':
          if (buildEvents.onEvent({ buildId: a.buildId, status: a.status }) === 'show') {
            toast(`A collaborator compiled (${a.status}).`)
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
            fileNotice = name ? `"${name}" was deleted.` : a.notice
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

  function togglePanel(p: 'settings' | 'members') {
    panel = panel === p ? 'none' : p
  }

  // ---------- builds ----------

  function updateBehind() {
    // Only compare synced docs: before the first sync the doc is empty or partial.
    behind = file && fileReady && tracker ? tracker.check(file.fileId, file.doc) : null
  }

  function showOwnBuild(r: BuildResult) {
    buildSeq++
    logInfo = { status: r.status, durationMs: r.durationMs, log: r.log, source: 'your compile' }
    tracker = new BehindTracker(r.snapshot)
    if (r.hasPdf) pdfUrl = buildFileUrl(id, r.buildId, 'output.pdf')
    updateBehind()
  }

  async function showForeignBuild(buildId: string, buildStatus: string) {
    const my = ++buildSeq
    logInfo = { status: buildStatus, durationMs: null, log: '', source: 'compiled by a collaborator' }
    tracker = null
    updateBehind()
    try {
      const [log, hasPdf] = await Promise.all([fetchBuildLog(id, buildId).catch(() => '(log unavailable)'), buildHasPdf(id, buildId)])
      if (my !== buildSeq || destroyed) return
      logInfo = { status: buildStatus, durationMs: null, log, source: 'compiled by a collaborator' }
      if (hasPdf) pdfUrl = buildFileUrl(id, buildId, 'output.pdf')
    } catch (e) {
      console.error('could not load build', e)
    }
  }

  async function recompile() {
    if (!canCompile || compiling) return
    compiling = true
    buildEvents.begin()
    try {
      const r = await api.compile(id)
      // Builds that finished while ours was running were someone else's (ours is newer): just mention them.
      const older = buildEvents.succeeded(r.buildId)
      if (destroyed) return
      showOwnBuild(r)
      for (const ev of older) toast(`A collaborator compiled (${ev.status}).`)
    } catch (e) {
      const held = buildEvents.failed()
      if (destroyed) return
      const msg = e instanceof ApiError && e.code === 'compiler-unavailable'
        ? `Compiler unavailable: ${e.message}`
        : `Compile failed: ${errorMessage(e)}`
      logInfo = { status: 'error', durationMs: null, log: msg }
      toast(msg, 'error')
      // A collaborator's build that finished meanwhile is now the newest: show it.
      const last = held.at(-1)
      if (last) {
        toast(`A collaborator compiled (${last.status}).`)
        void showForeignBuild(last.buildId, last.status)
      }
    } finally {
      compiling = false
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
      <button type="button" class="primary" onclick={recompile} disabled={!canCompile || compiling}
        title={canCompile ? 'Compile (Ctrl+S)' : 'Viewers cannot compile'}>
        {compiling ? 'Compiling…' : 'Recompile'}
      </button>
      <button type="button" class:active={panel === 'settings'} onclick={() => togglePanel('settings')}>Settings</button>
      <button type="button" class:active={panel === 'members'} onclick={() => togglePanel('members')}>Members</button>
      <span class="muted">{me.displayName}</span>
      <button type="button" onclick={logOutHere}>Log out</button>
    </header>

    <aside class="files">
      <FileTree projectId={id} tree={detail.tree} rootId={detail.rootId} mainFileId={detail.mainFileId} {canEdit}
        openId={file?.fileId ?? preview?.id ?? null} onOpen={openEntry} onChanged={() => void refreshProject()}
        onSetMain={setMainFile} />
    </aside>

    <section class="editor-pane">
      <div class="pane-title">
        {openPath || 'No file open'}{#if file && !canEdit}<span class="muted"> (read-only)</span>{/if}
        {#if preview}<a class="dl" href={rawFileUrl(id, preview.id)} download={preview.name}>Download</a>{/if}
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
                readOnly={!canEdit} onSave={recompile} />
            {/key}
          {/key}
        {:else if file}
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
        <PdfView url={pdfUrl} placeholder={canCompile ? 'No PDF yet. Click Recompile.' : 'No PDF yet. Wait for an editor to compile.'} />
      </div>
      <div class="log-pane">
        <LogPanel info={logInfo} onJump={jumpTo} />
      </div>
    </section>

    {#if panel !== 'none'}
      <aside class="side-panel" aria-label={panel === 'settings' ? 'Project settings' : 'Members'}>
        <div class="side-head">
          <strong>{panel === 'settings' ? 'Project settings' : 'Members'}</strong>
          <button type="button" onclick={() => { panel = 'none' }}>Close</button>
        </div>
        {#if panel === 'settings'}
          <SettingsPanel {detail} onUpdated={applyDetail} />
        {:else}
          <MembersPanel bind:this={membersPanel} projectId={id} projectName={detail.name} {me} role={detail.role} />
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
  .pane-title {
    font-size: 12px;
    padding: 4px 8px;
    border-bottom: 1px solid #ddd;
    background: #fafafa;
    display: flex;
    gap: 8px;
  }
  .pane-title .dl { margin-left: auto; }
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
