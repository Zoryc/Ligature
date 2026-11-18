<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import { can, type Me, type MetaEvent, type ProjectDetail, type TreeEntry } from '@ligature/shared'
  import { api, ApiError, buildFileUrl, buildHasPdf, fetchBuildLog, type BuildResult } from '../lib/api.ts'
  import { ProjectCollab, type ConnectionStatus, type FileSession, type PresenceUser } from '../lib/collab.ts'
  import { userColor } from '../lib/colors.ts'
  import { treeRows, textFilesByPath } from '../lib/tree.ts'
  import { BehindTracker } from '../lib/behind.ts'
  import { BuildEvents } from '../lib/buildEvents.ts'
  import type { LogInfo } from '../lib/logParse.ts'
  import { toast } from '../lib/toasts.svelte.ts'
  import { go } from '../lib/router.svelte.ts'
  import { logout } from '../lib/session.svelte.ts'
  import FileTree from '../lib/FileTree.svelte'
  import Editor from '../lib/Editor.svelte'
  import PdfView from '../lib/PdfView.svelte'
  import LogPanel from '../lib/LogPanel.svelte'

  interface Props { id: string; me: Me }
  let { id, me }: Props = $props()

  // Project + presence
  let detail = $state.raw<ProjectDetail | null>(null)
  let loadError = $state<string | null>(null)
  let status = $state<ConnectionStatus>('connecting')
  let peers = $state.raw<PresenceUser[]>([])
  let metaError = $state<string | null>(null)

  // Open file
  let file = $state.raw<FileSession | null>(null)
  let fileReady = $state(false)
  let fileError = $state<string | null>(null)
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
  let openPath = $derived(file ? rows.find(r => r.entry.id === file?.fileId)?.path ?? '' : '')

  let collab: ProjectCollab | null = null
  let destroyed = false

  function authMessage(reason: string): string {
    switch (reason) {
      case 'reload-required': return 'This file was reset on the server. Reload the page.'
      case 'forbidden': return 'You do not have access to this project (any more).'
      case 'not-found': return 'This file no longer exists.'
      case 'unauthenticated': return 'Your session has expired. Log in again.'
      default: return `Access denied (${reason}).`
    }
  }

  onMount(() => {
    void (async () => {
      let d: ProjectDetail
      try {
        d = await api.project(id)
      } catch (e) {
        loadError = e instanceof ApiError && e.status === 404 ? 'Project not found.' : `Could not load project: ${(e as Error).message}`
        return
      }
      if (destroyed) return
      detail = d
      const user: PresenceUser = { id: me.id, name: me.displayName, ...userColor(me.id) }
      collab = new ProjectCollab(id, user, {
        onStatus: s => { status = s },
        onPeers: p => { peers = p },
        onEvent: handleEvent,
        onAuthFailed: reason => { metaError = authMessage(reason) },
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

  function openFile(entry: TreeEntry, jumpTo: number | null = null) {
    if (!collab || entry.kind !== 'text' || entry.epoch === undefined) return
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
      onAuthFailed: reason => {
        if (file === s) fileError = authMessage(reason)
      },
    })
    s.doc.on('update', onDocUpdate)
    file = s
    updateBehind()
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

  async function refreshTree() {
    let d: ProjectDetail
    try {
      d = await api.project(id)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        toast('You no longer have access to this project.', 'error')
        go('/projects')
      }
      return
    }
    if (destroyed) return
    detail = d
    if (!file) return
    const entry = d.tree.find(e => e.id === file?.fileId)
    if (!entry || entry.kind !== 'text') {
      closeFile()
      fileError = 'This file was deleted.'
    } else if (entry.epoch !== file.epoch) {
      toast('This file was reset on the server; reopening it.')
      openFile(entry)
    }
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
      const msg = e instanceof ApiError
        ? (e.code === 'compiler-unavailable' ? `Compiler unavailable: ${e.message}` : `Compile failed: ${e.code}`)
        : `Compile failed: ${(e as Error).message}`
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

  function handleEvent(e: MetaEvent) {
    switch (e.type) {
      case 'tree-changed':
        if (!detail || e.treeVersion !== detail.treeVersion) void refreshTree()
        break
      case 'compile-finished':
        if (buildEvents.onEvent(e) === 'show') {
          toast(`A collaborator compiled (${e.status}).`)
          void showForeignBuild(e.buildId, e.status)
        }
        break
      case 'access-revoked':
        if (e.userId === me.id) {
          toast('Your access to this project was revoked.', 'error')
          go('/projects')
        }
        break
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
      <span class="pill">{detail.role}</span>
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
      <span class="muted">{me.displayName}</span>
      <button type="button" onclick={logout}>Log out</button>
    </header>

    {#if metaError}<div class="banner">{metaError} <button type="button" onclick={() => location.reload()}>Reload</button></div>{/if}

    <aside class="files">
      <FileTree {rows} selectedId={file?.fileId ?? null} mainFileId={detail.mainFileId} onOpen={e => openFile(e)} />
    </aside>

    <section class="editor-pane">
      <div class="pane-title">{openPath || 'No file open'}{#if !canEdit}<span class="muted"> (read-only)</span>{/if}</div>
      <div class="pane-body">
        {#if fileError}
          <div class="message">
            <p class="error">{fileError}</p>
            <button type="button" onclick={() => location.reload()}>Reload</button>
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
          <div class="message muted">Pick a file on the left.</div>
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
  </div>
{/if}

<style>
  .layout {
    height: 100vh;
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas:
      'top top top'
      'banner banner banner'
      'files editor output';
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
  .banner {
    grid-area: banner;
    background: #fdecee;
    color: #b00020;
    padding: 6px 10px;
  }
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
  }
  .pane-body {
    flex: 1;
    min-height: 0;
  }
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
  .message { padding: 16px; }
  .muted { color: #666; }
  .error { color: #b00020; }
  .primary {
    background: #2a5bd7;
    color: white;
    border: 1px solid #2a5bd7;
  }
  .primary:hover:not(:disabled) {
    background: #1f48b0;
  }
  .primary:disabled {
    background: #9db3e8;
    border-color: #9db3e8;
  }
</style>
