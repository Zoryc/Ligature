<script lang="ts">
  import { onMount } from 'svelte'
  import type { StorageReport } from '@ligature/shared'
  import { api } from './api.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'
  import { personName } from './people.ts'
  import {
    ariaSort, DEFAULT_SORT, formatBytes, formatDuration, gcLines, gcSummary, plural, projectBytes, sortProjects,
    storageTotals, toggleSort, type SortKey, type SortState,
  } from './storage.ts'

  let report = $state.raw<StorageReport | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let running = $state(false)
  let sort = $state<SortState>(DEFAULT_SORT)

  let totals = $derived(report ? storageTotals(report) : null)
  let rows = $derived(report ? sortProjects(report.projects, sort) : [])

  const COLUMNS: { key: SortKey; label: string; numeric: boolean; title?: string }[] = [
    { key: 'name', label: 'Project', numeric: false },
    { key: 'owner', label: 'Owner', numeric: false },
    { key: 'liveFiles', label: 'Files', numeric: true, title: 'Files not in the trash' },
    { key: 'liveBytes', label: 'Files size', numeric: true },
    { key: 'trashBytes', label: 'Trash', numeric: true },
    { key: 'total', label: 'Total', numeric: true, title: 'Files plus trash' },
    { key: 'versions', label: 'Versions', numeric: true },
  ]

  async function load() {
    loading = true
    try {
      report = await api.adminStorage()
      error = null
    } catch (e) {
      error = `Could not load the storage report: ${errorMessage(e)}`
    } finally {
      loading = false
    }
  }

  onMount(load)

  async function runGc() {
    running = true
    try {
      const g = await api.adminRunGc()
      toast(gcSummary(g), 'info', 6000)
      if (report) report = { ...report, lastGc: g }
      await load()
    } catch (e) {
      toast(`Garbage collection failed: ${errorMessage(e)}`, 'error', 6000)
    } finally {
      running = false
    }
  }

  function arrow(key: SortKey): string {
    return sort.key !== key ? '' : sort.dir === 'asc' ? ' ▲' : ' ▼'
  }
</script>

<section class="card storage">
  <div class="head">
    <h2>Storage</h2>
    <span class="spacer"></span>
    <button type="button" onclick={load} disabled={loading || running}>{loading ? 'Refreshing…' : 'Refresh'}</button>
    <button type="button" class="primary" onclick={runGc} disabled={running}
      title="Remove unreferenced blobs, orphaned documents, old automatic versions and long-deleted projects">
      {running ? 'Running GC…' : 'Run GC now'}
    </button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  {#if !report}
    {#if !error}<p class="muted">Loading…</p>{/if}
  {:else if totals}
    <dl class="totals">
      <dt>Database</dt><dd>{formatBytes(report.databaseBytes)}</dd>
      <dt>Blob store</dt><dd>{formatBytes(report.blobs.bytes)} <span class="muted">({plural(report.blobs.count, 'blob')})</span></dd>
      <dt>Unreferenced blobs</dt>
      <dd>
        {formatBytes(report.unreferenced.bytes)} <span class="muted">({plural(report.unreferenced.count, 'blob')})</span>
        {#if report.unreferenced.count}<span class="hint">removed by the next GC once older than the grace period</span>{/if}
      </dd>
      <dt>Projects</dt>
      <dd>{totals.projects}{#if totals.deletedProjects}{' '}<span class="muted">(+ {totals.deletedProjects} deleted, {formatBytes(totals.deletedBytes)}, waiting to be purged)</span>{/if}</dd>
      <!-- Files, trash and versions of live projects only: deleted ones are counted on the line above. -->
      <dt>Files</dt><dd>{formatBytes(totals.liveBytes)} <span class="muted">({plural(totals.liveFiles, 'file')})</span></dd>
      <dt>Trash</dt><dd>{formatBytes(totals.trashBytes)}</dd>
      <dt>Versions</dt><dd>{totals.versions}</dd>
    </dl>

    <h3>Projects</h3>
    {#if rows.length === 0}
      <p class="muted">No projects.</p>
    {:else}
      <div class="table-wrap">
        <table class="list">
          <thead>
            <tr>
              {#each COLUMNS as c (c.key)}
                <th class:num={c.numeric} aria-sort={ariaSort(sort, c.key)} title={c.title}>
                  <button type="button" class="sort" onclick={() => { sort = toggleSort(sort, c.key) }}>{c.label}{arrow(c.key)}</button>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as p (p.id)}
              <tr class:deleted={p.deleted}>
                <td><span class="pname">{p.name}</span>{#if p.deleted}{' '}<span class="muted">(deleted)</span>{/if}</td>
                <td>{personName(p.owner)}</td>
                <td class="num">{p.liveFiles}</td>
                <td class="num">{formatBytes(p.liveBytes)}</td>
                <td class="num">{formatBytes(p.trashBytes)}</td>
                <td class="num">{formatBytes(projectBytes(p))}</td>
                <td class="num">{p.versions}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <h3>Last garbage collection</h3>
    {#if report.lastGc}
      {@const g = report.lastGc}
      <p>{new Date(g.at).toLocaleString()} <span class="muted">(took {formatDuration(g.durationMs)})</span></p>
      <ul class="gc">
        {#each gcLines(g) as line (line)}<li>{line}</li>{/each}
      </ul>
    {:else}
      <p class="muted">The garbage collection has not run yet. It runs daily, or now with "Run GC now".</p>
    {/if}
  {/if}
</section>

<style>
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .head h2 { margin: 0; }
  .spacer { flex: 1; }
  h3 {
    margin: 22px 0 8px;
    font: 600 10.5px/1.2 var(--font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .totals {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr);
    margin: 0;
    border-top: 1px solid var(--rule-soft);
  }
  .totals dt, .totals dd { padding: 7px 0; border-bottom: 1px solid var(--rule-soft); }
  .totals dt { font-weight: 600; color: var(--ink-2); }
  .totals dd { margin: 0; font-variant-numeric: tabular-nums; }
  .hint { display: block; margin-top: 2px; font-size: 12px; color: var(--ink-4); }
  .table-wrap { overflow-x: auto; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.list th.num { text-align: right; }
  .sort {
    min-height: 0;
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
    color: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
  }
  .sort:hover:not(:disabled) { background: none; color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
  th[aria-sort='ascending'] .sort, th[aria-sort='descending'] .sort { color: var(--teal); }
  .pname { font: 600 14px/1.3 var(--font-doc); }
  tr.deleted td { color: var(--ink-4); }
  tr.deleted { background: var(--paper); }
  .gc { margin: 0; padding-left: 18px; color: var(--ink-2); }
  .gc li { margin: 2px 0; }
</style>
