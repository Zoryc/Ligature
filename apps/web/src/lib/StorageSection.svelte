<script lang="ts">
  import { onMount } from 'svelte'
  import type { StorageReport } from '@ligature/shared'
  import { api } from './api.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'
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
                <td>{p.name}{#if p.deleted}{' '}<span class="muted">(deleted)</span>{/if}</td>
                <td>{p.owner || '—'}</td>
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
  .head { display: flex; align-items: center; gap: 8px; }
  .head h2 { margin: 0; }
  .spacer { flex: 1; }
  h3 { font-size: 14px; margin: 16px 0 6px; }
  .totals {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    margin: 12px 0 0;
  }
  .totals dt { font-weight: 600; color: #444; }
  .totals dd { margin: 0; }
  .hint { display: block; font-size: 12px; color: #666; }
  .table-wrap { overflow-x: auto; }
  .num { text-align: right; white-space: nowrap; }
  table.list th.num { text-align: right; }
  .sort {
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
    font-weight: 600;
    color: inherit;
  }
  .sort:hover:not(:disabled) { background: none; text-decoration: underline; }
  tr.deleted td { color: #999; }
  .gc { margin: 0; padding-left: 18px; }
</style>
