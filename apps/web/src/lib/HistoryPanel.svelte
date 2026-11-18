<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { TreeEntry, VersionDiff, VersionSummary } from '@ligature/shared'
  import { api, ApiError, versionZipUrl } from './api.ts'
  import {
    appendPage, authorsText, changeBadge, changeRows, changeSummary, changeWord, dateTimeText, filterVersions, groupByDay,
    isNamed, kindIcon, kindName, labelProblem, reloadLimit, restoreConfirmText, restoreFileConfirmText, sideSource,
    timeText, versionTitle, type ChangeRow, type DiffRequest,
  } from './history.ts'
  import { treeRows } from './tree.ts'
  import { confirmDialog, promptDialog } from './dialogs.svelte.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'

  interface Props {
    projectId: string
    tree: TreeEntry[]
    rootId: string
    canEdit: boolean
    /** Open a file comparison (shown next to the panel); null closes it (it no longer matches what is selected). */
    onOpenDiff: (d: DiffRequest | null) => void
    /** Restore a version (whole project, or only `paths`); resolves true when it was restored. */
    onRestore: (v: VersionSummary, paths?: string[]) => Promise<boolean>
  }

  let { projectId, tree, rootId, canEdit, onOpenDiff, onRestore }: Props = $props()

  const PAGE = 50
  /** "Load more" with the named-only filter fetches up to this many pages looking for a named version. */
  const MAX_FILTER_PAGES = 10

  let versions = $state.raw<VersionSummary[]>([])
  let hasMore = $state(false)
  let loading = $state(false)
  let listError = $state<string | null>(null)
  let namedOnly = $state(false)
  let now = $state(Date.now())
  let listSeq = 0

  let selected = $state.raw<VersionSummary | null>(null)
  let mode = $state<'previous' | 'current'>('previous')
  let diff = $state.raw<VersionDiff | null>(null)
  let diffError = $state<string | null>(null)
  let diffLoading = $state(false)
  let diffSeq = 0
  let busy = $state(false)

  const clock = setInterval(() => { now = Date.now() }, 60_000)
  onDestroy(() => clearInterval(clock))

  let shown = $derived(filterVersions(versions, namedOnly))
  let groups = $derived(groupByDay(shown, now))
  let rows = $derived(diff ? changeRows(diff) : null)
  let liveIdByPath = $derived(new Map(treeRows(tree, rootId).filter(r => r.entry.kind !== 'folder').map(r => [r.path, r.entry.id])))

  let reloadRunning = false
  let reloadQueued = false

  /**
   * Reload the list (first page, as many as were loaded) and the open version. Called on versions-changed;
   * coalesced like the project refresh (one request in flight, one queued), since events can come in bursts.
   */
  export async function reload(): Promise<void> {
    if (reloadRunning) {
      reloadQueued = true
      return
    }
    reloadRunning = true
    try {
      do {
        reloadQueued = false
        await reloadOnce()
      } while (reloadQueued)
    } finally {
      reloadRunning = false
    }
  }

  async function reloadOnce(): Promise<void> {
    const my = ++listSeq
    loading = true
    try {
      const page = await api.versions(projectId, undefined, reloadLimit(versions.length, PAGE))
      if (my !== listSeq) return
      versions = page.versions
      hasMore = page.hasMore
      listError = null
      now = Date.now()
      if (selected) {
        const cur = selected
        const fresh = page.versions.find(v => v.id === cur.id)
        if (fresh) selected = fresh
        void loadDiff()
      }
    } catch (e) {
      if (my === listSeq) listError = `Could not load the history: ${errorMessage(e)}`
    } finally {
      if (my === listSeq) loading = false
    }
  }

  async function loadMore() {
    if (loading || !hasMore) return
    const my = ++listSeq
    loading = true
    try {
      let list = versions
      let more: boolean = hasMore
      // With "Named only", keep going until a named version turns up (bounded).
      for (let i = 0; i < (namedOnly ? MAX_FILTER_PAGES : 1) && more; i++) {
        const page = await api.versions(projectId, list.at(-1)?.id, PAGE)
        if (my !== listSeq) return
        const before = list.length
        list = appendPage(list, page.versions)
        more = page.hasMore
        if (!namedOnly || list.slice(before).some(isNamed)) break
      }
      versions = list
      hasMore = more
      listError = null
    } catch (e) {
      if (my !== listSeq) return
      if (e instanceof ApiError && e.status === 400) {
        // The last version we know of was thinned meanwhile: start over.
        void reload()
        return
      }
      listError = `Could not load more: ${errorMessage(e)}`
    } finally {
      if (my === listSeq) loading = false
    }
  }

  void reload()

  function select(v: VersionSummary) {
    selected = v
    mode = 'previous'
    onOpenDiff(null)
    void loadDiff()
  }

  function back() {
    onOpenDiff(null)
    selected = null
    diff = null
    diffError = null
    diffSeq++
  }

  async function loadDiff() {
    const v = selected
    if (!v) return
    const my = ++diffSeq
    diffLoading = true
    diffError = null
    try {
      const d = await api.versionDiff(projectId, v.id, mode === 'current' ? 'current' : undefined)
      if (my !== diffSeq) return
      diff = d
    } catch (e) {
      if (my !== diffSeq) return
      diff = null
      diffError = e instanceof ApiError && e.status === 404
        ? 'This version no longer exists (it was removed by the history clean-up).'
        : `Could not load the changes: ${errorMessage(e)}`
    } finally {
      if (my === diffSeq) diffLoading = false
    }
  }

  function setMode(m: 'previous' | 'current') {
    if (mode === m) return
    mode = m
    onOpenDiff(null)
    void loadDiff()
  }

  function sideTitles(v: VersionSummary, d: VersionDiff): [string, string] {
    const right = `This version (${dateTimeText(v.createdAt)})`
    if (d.from === 'current') return ['Current state', right]
    if (d.from === '') return ['(no earlier version)', right]
    const prev = versions.find(x => x.id === d.from)
    return [prev ? `Previous version (${dateTimeText(prev.createdAt)})` : 'Previous version', right]
  }

  function openRow(r: ChangeRow) {
    if (!selected || !diff) return
    const [leftTitle, rightTitle] = sideTitles(selected, diff)
    onOpenDiff({
      row: r,
      left: sideSource(diff.from, r.file.oldPath, liveIdByPath),
      right: sideSource(diff.to, r.file.path, liveIdByPath),
      leftTitle,
      rightTitle,
    })
  }

  async function nameVersion(v: VersionSummary) {
    const label = await promptDialog(v.label ? 'Rename this version' : 'Name this version', 'Name', v.label ?? '',
      { confirmLabel: 'Save', validate: labelProblem, message: 'Named versions are kept forever.' })
    if (label === null) return
    busy = true
    try {
      const updated = await api.labelVersion(projectId, v.id, label.trim())
      versions = versions.map(x => (x.id === updated.id ? updated : x))
      if (selected?.id === updated.id) selected = updated
      toast(`Named the version "${updated.label ?? ''}".`)
    } catch (e) {
      toast(`Could not name the version: ${errorMessage(e)}`, 'error', 6000)
    } finally {
      busy = false
    }
  }

  async function nameCurrent() {
    const label = await promptDialog('Name the current version', 'Name', '',
      { confirmLabel: 'Save', validate: labelProblem, message: 'Saves the project as it is now, under this name. Named versions are kept forever.' })
    if (label === null) return
    busy = true
    try {
      const v = await api.createVersion(projectId, label.trim())
      versions = [v, ...versions.filter(x => x.id !== v.id)]
      toast(`Saved the current state as "${v.label ?? ''}".`)
    } catch (e) {
      toast(`Could not save the version: ${errorMessage(e)}`, 'error', 6000)
    } finally {
      busy = false
    }
  }

  /** The live state changed: a comparison with it is out of date. */
  function afterRestore() {
    if (mode === 'current') onOpenDiff(null)
    void loadDiff()
  }

  async function restoreAll(v: VersionSummary) {
    const ok = await confirmDialog('Restore this version', restoreConfirmText(v), { confirmLabel: 'Restore', danger: true })
    if (!ok) return
    busy = true
    try {
      if (await onRestore(v)) afterRestore()
    } finally {
      busy = false
    }
  }

  async function restoreFile(v: VersionSummary, r: ChangeRow) {
    const ok = await confirmDialog('Restore this file', restoreFileConfirmText(r.file.path, v), { confirmLabel: 'Restore file' })
    if (!ok) return
    busy = true
    try {
      if (await onRestore(v, [r.file.path])) afterRestore()
    } finally {
      busy = false
    }
  }
</script>

<div class="history">
  {#if !selected}
    <div class="toolbar">
      <label class="filter"><input type="checkbox" bind:checked={namedOnly} /> Named only</label>
      <span class="spacer"></span>
      {#if canEdit}
        <button type="button" disabled={busy} onclick={nameCurrent} title="Save the project as it is now, with a name">Name current version</button>
      {/if}
    </div>
    {#if listError}<p class="error">{listError}</p>{/if}
    {#if versions.length === 0 && loading}
      <p class="muted">Loading…</p>
    {:else if versions.length === 0 && !listError}
      <p class="muted">No versions yet. A version is saved automatically a few minutes after a change.</p>
    {:else if shown.length === 0}
      <p class="muted">No named versions{hasMore ? ' among the versions loaded so far' : ''}.</p>
    {/if}
    {#each groups as g (g.key)}
      <h3 class="day">{g.title}</h3>
      <ul class="versions">
        {#each g.items as v (v.id)}
          {@const who = authorsText(v)}
          {@const badge = changeBadge(v.changes)}
          <li>
            <button type="button" class="version" onclick={() => select(v)} title="{kindName(v.kind)} · {changeSummary(v.changes)}">
              <span class="icon kind-{v.kind}" aria-label={kindName(v.kind)}>{kindIcon(v.kind)}</span>
              <span class="main">
                <span class="title" class:named={v.label !== null}>{versionTitle(v)}</span>
                <span class="meta muted">{timeText(v.createdAt)}{who ? ` · ${who}` : ''}</span>
              </span>
              {#if badge}<span class="badge">{badge}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/each}
    {#if hasMore}
      <button type="button" class="more" disabled={loading} onclick={loadMore}>{loading ? 'Loading…' : 'Load more'}</button>
    {/if}
  {:else}
    {@const v = selected}
    <button type="button" class="link" onclick={back}>&larr; All versions</button>
    <div class="detail-head">
      <div class="title-line">
        <span class="icon kind-{v.kind}" aria-label={kindName(v.kind)}>{kindIcon(v.kind)}</span>
        <strong>{versionTitle(v)}</strong>
      </div>
      <div class="muted small">
        {dateTimeText(v.createdAt)} · {kindName(v.kind)} · {v.fileCount} file{v.fileCount === 1 ? '' : 's'}
        {#if authorsText(v)}<br />{authorsText(v)}{/if}
      </div>
    </div>
    <div class="actions">
      {#if canEdit}
        <button type="button" disabled={busy} onclick={() => nameVersion(v)}>{v.label ? 'Rename' : 'Name this version'}</button>
        <button type="button" class="primary" disabled={busy} onclick={() => restoreAll(v)}>Restore this version</button>
      {/if}
      <a class="button" href={versionZipUrl(projectId, v.id)} download>Download as .zip</a>
    </div>
    <div class="compare">
      Compare with:
      <label><input type="radio" name="history-compare" checked={mode === 'previous'} onchange={() => setMode('previous')} /> previous version</label>
      <label><input type="radio" name="history-compare" checked={mode === 'current'} onchange={() => setMode('current')} /> current state</label>
      <button type="button" class="link" onclick={() => void loadDiff()} disabled={diffLoading}>Refresh</button>
    </div>
    {#if diffError}
      <p class="error">{diffError}</p>
    {:else if !rows}
      <p class="muted">Loading…</p>
    {:else}
      <p class="muted small">
        {#if mode === 'previous'}
          {diff?.from === '' ? 'The first version: every file is new.' : 'What changed in this version.'}
        {:else}
          How this version differs from the project now (what restoring it would change).
        {/if}
      </p>
      {#if rows.changed.length === 0}
        <p class="muted">No differences.</p>
      {:else}
        <ul class="changes">
          {#each rows.changed as r (r.key)}
            <li>
              <button type="button" class="file" onclick={() => openRow(r)} title="Show the differences">
                <span class="path">{r.path}</span>
                <span class="change change-{r.change}">{changeWord(r.file)}</span>
                {#if r.kind === 'binary'}<span class="muted small">binary</span>{/if}
                {#if r.detail}<span class="muted small">{r.detail}</span>{/if}
              </button>
              {#if canEdit && r.inNew}
                <button type="button" class="small-btn" disabled={busy} onclick={() => restoreFile(v, r)}
                  title="Restore only this file as it was in this version">Restore this file</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if rows.unchanged.length}
        <details>
          <summary class="muted small">{rows.unchanged.length} unchanged file{rows.unchanged.length === 1 ? '' : 's'}</summary>
          <ul class="changes">
            {#each rows.unchanged as r (r.key)}
              <li>
                <button type="button" class="file" onclick={() => openRow(r)}><span class="path">{r.path}</span></button>
                {#if canEdit && r.inNew && mode === 'previous'}
                  <button type="button" class="small-btn" disabled={busy} onclick={() => restoreFile(v, r)}>Restore this file</button>
                {/if}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .spacer { flex: 1; }
  .filter { display: flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }
  .day { font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; color: #555; margin: 12px 0 4px; }
  .versions, .changes { list-style: none; margin: 0; padding: 0; }
  .version {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    border-bottom: 1px solid #eee;
    border-radius: 0;
    padding: 6px 4px;
    background: none;
  }
  .version:hover:not(:disabled) { background: #f3f5ff; }
  .icon {
    width: 22px;
    height: 22px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: #eee;
    font-size: 12px;
  }
  .kind-named { background: #fff1c2; color: #8a5300; }
  .kind-pre_restore { background: #e6ecff; color: #2a5bd7; }
  .kind-compile { background: #e3f4e6; color: #1b7f3b; }
  .kind-import { background: #f0e6ff; color: #5b2ab0; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title.named { font-weight: 600; }
  .meta { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 12px; color: #555; font-family: ui-monospace, monospace; white-space: nowrap; }
  .more { margin-top: 10px; width: 100%; }
  .detail-head { margin: 10px 0; }
  .title-line { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .small { font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  a.button {
    display: inline-block;
    padding: 4px 10px;
    border: 1px solid #bbb;
    border-radius: 3px;
    color: inherit;
    text-decoration: none;
  }
  a.button:hover { background: #f0f0f0; }
  .compare { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; margin-bottom: 6px; }
  .compare label { display: flex; align-items: center; gap: 3px; cursor: pointer; }
  .changes li { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid #eee; }
  .file {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 6px;
    align-items: center;
    text-align: left;
    border: 0;
    border-radius: 0;
    background: none;
    padding: 5px 2px;
  }
  .file:hover:not(:disabled) { background: #f3f5ff; }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .change { font-size: 11px; padding: 0 6px; border-radius: 8px; background: #eee; white-space: nowrap; }
  .change-added { background: #e3f4e6; color: #1b7f3b; }
  .change-removed { background: #fde7ea; color: #b00020; }
  .change-modified, .change-renamed { background: #fff1d6; color: #8a5300; }
  .small-btn { font-size: 12px; padding: 1px 6px; white-space: nowrap; }
  details { margin-top: 8px; }
  summary { cursor: pointer; }
</style>
