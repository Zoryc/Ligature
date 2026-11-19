<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { AdminUser, AuditCategory, AuditEntryView } from '@ligature/shared'
  import { api, type AuditQuery } from './api.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'
  import {
    actorLabel, auditParts, auditSentence, CATEGORY_OPTIONS, detailLines, isAlarming, olderLoadedText, PERIOD_OPTIONS, periodSince,
    type AuditPeriod,
  } from './auditText.ts'
  import Avatar from './Avatar.svelte'

  /** The audit log tab of the admin page (docs/M4.md §2). */

  const PAGE = 100

  let people = $state.raw<AdminUser[]>([])
  let category = $state<AuditCategory | ''>('')
  let actor = $state('')
  /** The name shown on the row the person filter was set from (the user list may not have loaded). */
  let actorName = $state('')
  let period = $state<AuditPeriod>('all')
  let project = $state<{ id: string; name: string } | null>(null)

  let entries = $state.raw<AuditEntryView[]>([])
  let next = $state<number | null>(null)
  let loading = $state(false)
  let loadingOlder = $state(false)
  let error = $state<string | null>(null)
  let expanded = $state.raw<ReadonlySet<number>>(new Set())
  /** Polite announcement after "Load older". */
  let announce = $state('')
  let periodSelect = $state<HTMLSelectElement | undefined>(undefined)
  let tbody = $state<HTMLTableSectionElement | undefined>(undefined)
  /** The filters of the loaded list ("Load older" continues with the same `since`, not a newer one). */
  let query: AuditQuery = {}
  let seq = 0

  // A person filter set from a row may name someone the select does not list: an account without a row,
  // or anyone when the user list failed to load. The option then shows the name from that row.
  let actorMissing = $derived(actor !== '' && !people.some(p => p.id === actor))

  function currentQuery(): AuditQuery {
    const since = periodSince(period, Date.now())
    return {
      limit: PAGE,
      ...(category ? { category } : {}),
      ...(actor ? { actor } : {}),
      ...(project ? { project: project.id } : {}),
      ...(since !== undefined ? { since } : {}),
    }
  }

  /** First page for the current filters; a newer request wins over one still in flight. */
  async function reload() {
    const mine = ++seq
    query = currentQuery()
    loading = true
    try {
      const page = await api.adminAudit(query)
      if (mine !== seq) return
      entries = page.entries
      next = page.next
      expanded = new Set()
      error = null
    } catch (e) {
      if (mine !== seq) return
      entries = []
      next = null
      error = `Could not load the audit log: ${errorMessage(e)}`
    } finally {
      if (mine === seq) loading = false
    }
  }

  /**
   * The button stays enabled while loading (a disabled button loses keyboard focus); repeated presses are
   * ignored here. When the last page arrives the button goes away, so focus moves to the first new row.
   */
  async function loadOlder() {
    if (next === null || loadingOlder || loading) return
    const mine = seq
    loadingOlder = true
    announce = ''
    try {
      const page = await api.adminAudit({ ...query, before: next })
      if (mine !== seq) return // the filters changed meanwhile
      const first = page.entries[0]?.id ?? entries.at(-1)?.id
      entries = [...entries, ...page.entries]
      next = page.next
      announce = olderLoadedText(page.entries.length, page.next !== null)
      if (page.next === null && first !== undefined) {
        await tick()
        tbody?.querySelector<HTMLElement>(`tr[data-id="${first}"]`)?.focus()
      }
    } catch (e) {
      if (mine === seq) toast(`Could not load older entries: ${errorMessage(e)}`, 'error')
    } finally {
      loadingOlder = false
    }
  }

  onMount(() => {
    void reload()
    api.adminUsers().then(u => { people = u }).catch(() => { /* the person select just lists fewer people */ })
  })

  function filterByPerson(id: string, name: string) {
    if (actor === id) return
    actor = id
    actorName = name
    void reload()
  }

  function filterByProject(p: { id: string; name: string }) {
    if (project?.id === p.id) return
    project = p
    void reload()
  }

  /** The chip (and its focused × button) goes away: keep keyboard focus nearby, on the period select. */
  async function clearProject() {
    project = null
    void reload()
    await tick()
    periodSelect?.focus()
  }

  function toggle(id: number) {
    const s = new Set(expanded)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    expanded = s
  }

  const dateText = (at: number) => new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  const timeText = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const fullText = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })
  const projectName = (p: NonNullable<AuditEntryView['project']>) => p.name || 'a deleted project'
</script>

<section class="card audit" aria-labelledby="audit-title">
  <div class="head">
    <h2 id="audit-title">Audit log</h2>
    <span class="spacer"></span>
    <!-- aria-disabled, not disabled: a disabled button drops keyboard focus (reload() lets the newest request win). -->
    <button type="button" onclick={() => { if (!loading) void reload() }} aria-disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
  </div>
  <p class="sub">Who changed what, and when. Times are local.</p>

  <div class="filters" role="group" aria-label="Filters">
    <label>
      <span class="eyebrow">Activity</span>
      <select value={category} onchange={e => { category = e.currentTarget.value as AuditCategory | ''; void reload() }}>
        {#each CATEGORY_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
      </select>
    </label>
    <label>
      <span class="eyebrow">Person</span>
      <select value={actor} onchange={e => { actor = e.currentTarget.value; void reload() }}>
        <option value="">Everyone</option>
        {#if actorMissing}<option value={actor}>{actorName || 'A deleted account'}</option>{/if}
        {#each people as p (p.id)}<option value={p.id}>{p.displayName} ({p.username})</option>{/each}
      </select>
    </label>
    <label>
      <span class="eyebrow">Period</span>
      <select bind:this={periodSelect} value={period} onchange={e => { period = e.currentTarget.value as AuditPeriod; void reload() }}>
        {#each PERIOD_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
      </select>
    </label>
    {#if project}
      <span class="chip">
        <span class="eyebrow">Project</span>
        <em>{project.name || 'a deleted project'}</em>
        <button type="button" class="quiet small" aria-label="Remove the project filter" title="Remove the project filter"
          onclick={clearProject}>×</button>
      </span>
    {/if}
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if entries.length === 0}
    <p class="muted empty">{loading ? 'Loading…' : 'No activity matches these filters.'}</p>
  {:else}
    <div class="table-wrap">
      <table class="list" aria-busy={loading}>
        <thead>
          <tr><th>When</th><th>Who</th><th>What</th><th>Project</th><th><span class="sr-only">Details</span></th></tr>
        </thead>
        <tbody bind:this={tbody}>
          {#each entries as e (e.id)}
            {@const open = expanded.has(e.id)}
            {@const lines = detailLines(e)}
            {@const alarm = isAlarming(e)}
            <tr class:open data-id={e.id} tabindex="-1">
              <td class="when">
                <time datetime={new Date(e.at).toISOString()} title={fullText(e.at)}>
                  <span class="date">{dateText(e.at)}</span>
                  <span class="time">{timeText(e.at)}</span>
                </time>
              </td>
              <td class="who">
                {#if e.actor}
                  <button type="button" class="person" title="Show only {actorLabel(e)}" onclick={() => filterByPerson(e.actor!.id, actorLabel(e))}>
                    <Avatar id={e.actor.id} name={actorLabel(e)} size={20} />
                    <span>{actorLabel(e)}</span>
                  </button>
                {:else}
                  <span class="server">{actorLabel(e)}</span>
                {/if}
              </td>
              <td class="what" title={auditSentence(e)}>
                <!-- One line: whitespace between the parts would end up in the sentence. -->
                {#if alarm}<span class="mark" aria-hidden="true"></span><span class="sr-only">Alert: </span>{/if}{#each auditParts(e) as part, i (i)}{#if typeof part === 'string'}{part}{:else if 'name' in part}<em>{part.name}</em>{:else}<code>{part.file}</code>{/if}{/each}
              </td>
              <td class="project">
                {#if e.project}
                  {@const p = e.project}
                  <button type="button" class="link" title="Show only this project" onclick={() => filterByProject({ id: p.id, name: projectName(p) })}>
                    {projectName(p)}</button>{#if p.deleted && p.name}{' '}<span class="muted">(deleted)</span>{/if}
                {/if}
              </td>
              <td class="end">
                {#if lines.length}
                  <button type="button" class="small quiet" aria-expanded={open} aria-controls="audit-detail-{e.id}" onclick={() => toggle(e.id)}>
                    {open ? 'Hide' : 'Details'}
                  </button>
                {/if}
              </td>
            </tr>
            {#if open}
              <tr class="detail" id="audit-detail-{e.id}">
                <td colspan="5">
                  <dl>
                    <dt>action</dt><dd>{e.action}</dd>
                    {#each lines as l (l.key)}<dt>{l.key}</dt><dd>{l.value}</dd>{/each}
                  </dl>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
    {#if next !== null}
      <div class="more">
        <button type="button" onclick={loadOlder} aria-disabled={loadingOlder || loading}>{loadingOlder ? 'Loading…' : 'Load older'}</button>
      </div>
    {/if}
  {/if}
  <p class="sr-only" aria-live="polite">{announce}</p>
</section>

<style>
  .head { display: flex; align-items: center; gap: 8px; }
  .head h2 { margin: 0; }
  .spacer { flex: 1; }
  .sub { margin: 2px 0 14px; color: var(--ink-4); font-size: 12.5px; }

  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px 14px;
    padding: 0 0 14px;
    margin-bottom: 14px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .filters label { display: flex; flex-direction: column; gap: 5px; }
  .filters select { min-width: 170px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding: 0 2px 0 9px;
    border: 1px solid var(--teal-edge);
    background: var(--teal-tint);
  }
  .chip em { font: italic 600 13.5px/1.2 var(--font-doc); color: var(--ink); }
  .chip button { min-height: 24px; padding: 0 7px; font-size: 15px; }

  .empty { margin: 8px 0 0; }
  .table-wrap { overflow-x: auto; }
  table.list td { vertical-align: top; }
  .when { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .when time { display: flex; flex-direction: column; gap: 2px; }
  .when .date { color: var(--ink-2); }
  .when .time { color: var(--ink-4); font-size: 12px; }
  .who { white-space: nowrap; }
  .person {
    min-height: 0;
    gap: 8px;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--ink);
  }
  .person:hover:not(:disabled) { background: none; text-decoration: underline; text-underline-offset: 2px; }
  .server { color: var(--ink-3); font-style: italic; }
  .what { min-width: 240px; line-height: 1.45; color: var(--ink-2); }
  .what em { font-family: var(--font-doc); font-style: italic; font-weight: 600; color: var(--ink); }
  .what code { font-size: 12px; color: var(--ink); }
  .mark {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 7px;
    background: var(--red);
    vertical-align: 1px;
  }
  .project { white-space: nowrap; }
  .project .link { font-weight: 500; text-align: left; }
  .end { width: 1%; text-align: right; white-space: nowrap; }
  tr.open td { border-bottom-color: transparent; }
  tr.detail td { padding-top: 0; background: var(--paper); }
  tr.detail dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 3px 16px;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--rule-soft);
    background: var(--sheet);
    font: 12px/1.45 var(--font-mono);
  }
  tr.detail dt { color: var(--ink-4); }
  tr.detail dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
  .more { display: flex; justify-content: center; margin-top: 14px; }
  button[aria-disabled='true'] { cursor: default; opacity: 0.55; }
</style>
