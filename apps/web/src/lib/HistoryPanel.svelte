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
        <button type="button" class="small" disabled={busy} onclick={nameCurrent} title="Save the project as it is now, with a name">
          <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" fill="none" aria-hidden="true"><path d="M5 4h14v16l-7-5-7 5z" /></svg>
          Name current version
        </button>
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
    <div class="back"><button type="button" class="link" onclick={back}>&larr; All versions</button></div>
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
      <a class="button" href={versionZipUrl(projectId, v.id)} download>
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" fill="none" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4 14v6h16v-6" /></svg>
        Download as .zip
      </a>
    </div>
    <div class="compare">
      <span class="eyebrow">Compare with</span>
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
                <button type="button" class="small restore-file" disabled={busy} onclick={() => restoreFile(v, r)}
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
                  <button type="button" class="small restore-file" disabled={busy} onclick={() => restoreFile(v, r)}>Restore this file</button>
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
  .history { font-size: 13px; padding-bottom: 16px; }
  .history > p { margin: 0; padding: 10px 20px; }
  .small { font-size: 12px; }

  /* List */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    background: var(--paper);
    border-bottom: 1px solid var(--rule);
  }
  .spacer { flex: 1; }
  .filter { display: flex; align-items: center; gap: 7px; color: var(--ink-2); cursor: pointer; }
  .day {
    margin: 0;
    padding: 16px 20px 7px;
    font: 600 10.5px/1.2 var(--font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .versions, .changes { list-style: none; margin: 0; padding: 0; border-bottom: 1px solid var(--rule-soft); }
  .versions li + li, .changes li + li { border-top: 1px solid var(--rule-soft); }
  .versions { border-top: 1px solid var(--rule-soft); }
  .version {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 0;
    padding: 8px 20px;
    border: 0;
    background: none;
    color: var(--ink);
    font: 400 13px/1.35 var(--font-ui);
    text-align: left;
    white-space: normal;
  }
  .version:hover:not(:disabled) { background: var(--sheet-hover); }
  .icon {
    width: 22px;
    height: 22px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--rule);
    background: var(--paper);
    color: var(--ink-4);
    font-size: 11px;
    line-height: 1;
  }
  .kind-named { background: var(--amber-tint); border-color: var(--amber-rule); color: var(--amber); }
  .kind-pre_restore { background: var(--teal-tint); border-color: var(--teal-edge); color: var(--teal); }
  .kind-compile { background: var(--green-tint); border-color: var(--green); color: var(--green); }
  .kind-import { background: var(--paper-2); border-color: var(--rule-strong); color: var(--ink-3); }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
  .title.named { font: 600 14px/1.3 var(--font-doc); color: var(--ink); }
  .meta { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font: 11.5px/1 var(--font-mono); color: var(--ink-4); white-space: nowrap; }
  .more { display: flex; margin: 14px 20px 0; width: calc(100% - 40px); }

  /* Detail */
  .back { padding: 12px 20px 0; }
  .detail-head { padding: 10px 20px 14px; }
  .title-line { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .title-line strong { font: 600 17px/1.25 var(--font-doc); color: var(--ink); min-width: 0; overflow-wrap: anywhere; }
  .detail-head .muted { padding-left: 32px; line-height: 1.5; }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 20px 16px;
    border-bottom: 1px solid var(--rule);
  }
  .compare {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    align-items: center;
    padding: 10px 20px;
    background: var(--paper);
    border-bottom: 1px solid var(--rule);
  }
  .compare label { display: flex; align-items: center; gap: 6px; color: var(--ink-2); cursor: pointer; }
  .compare .link { margin-left: auto; font-size: 12px; }
  .history > p.small { padding: 12px 20px 8px; }
  .changes li { display: flex; align-items: center; gap: 8px; padding-right: 20px; }
  .changes li:hover { background: var(--sheet-hover); }
  .file {
    flex: 1;
    min-width: 0;
    display: flex;
    justify-content: flex-start;
    gap: 8px;
    align-items: center;
    min-height: 34px;
    padding: 6px 0 6px 20px;
    border: 0;
    background: none;
    color: var(--ink);
    font: 400 13px/1.3 var(--font-ui);
    text-align: left;
  }
  .file:hover:not(:disabled) { background: none; }
  .file:hover .path { text-decoration: underline; text-underline-offset: 2px; }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font: 12.5px/1.3 var(--font-mono); }
  .change {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 5px;
    border: 1px solid var(--rule-strong);
    background: var(--paper);
    color: var(--ink-3);
    font: 600 10px/1 var(--font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .change-added { background: var(--green-tint); border-color: var(--green); color: var(--green); }
  .change-removed { background: var(--red-tint); border-color: var(--red-rule); color: var(--red); }
  .change-modified, .change-renamed { background: var(--amber-tint); border-color: var(--amber-rule); color: var(--amber); }
  .restore-file { flex: none; }
  details { margin-top: 4px; }
  summary { padding: 10px 20px; cursor: pointer; }
  summary:hover { color: var(--ink-2); }
</style>
