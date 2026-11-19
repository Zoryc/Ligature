<script lang="ts">
  import type { Diagnostic } from '@ligature/shared'
  import { parseLog, type LogInfo } from './logParse.ts'
  import { countSeverities, locationText } from './diagnostics.ts'

  interface Props {
    info: LogInfo | null
    /** A `file:line:` line of the raw log was clicked. */
    onJump?: (file: string, line: number) => void
    /** A problem was clicked. */
    onProblem?: (d: Diagnostic) => void
    /** Collapsed to its header line (bindable; personal). */
    collapsed?: boolean
    /** Show the raw log instead of the problems (bindable: the PDF menu can open it). */
    tab?: 'problems' | 'log'
  }

  let { info, onJump, onProblem, collapsed = $bindable(false), tab = $bindable('problems') }: Props = $props()

  let lines = $derived(info && tab === 'log' && !collapsed ? parseLog(info.log) : [])
  let counts = $derived(countSeverities(info?.diagnostics ?? []))
  let failedEmpty = $derived(!!info && info.diagnostics.length === 0 && info.status !== 'success')

  function toggleLog() {
    tab = tab === 'log' ? 'problems' : 'log'
    collapsed = false
  }
</script>

<section class="problems-panel" class:collapsed aria-label="Problems">
  <header>
    <button type="button" class="title" aria-expanded={!collapsed} onclick={() => { collapsed = !collapsed }}
      title={collapsed ? 'Show the problems' : 'Hide the problems'}>
      <span class="eyebrow">{tab === 'log' ? 'Raw log' : 'Problems'}</span>
      {#if !info}
        <span class="count muted">no build yet</span>
      {:else}
        {#if counts.errors}<span class="count err">{counts.errors} error{counts.errors === 1 ? '' : 's'}</span>{/if}
        {#if counts.warnings}<span class="count warn">{counts.warnings} warning{counts.warnings === 1 ? '' : 's'}</span>{/if}
        {#if counts.infos}<span class="count muted">{counts.infos} bad box{counts.infos === 1 ? '' : 'es'}</span>{/if}
        {#if !counts.errors && !counts.warnings && !counts.infos}
          <span class="count" class:ok={info.status === 'success'} class:err={info.status !== 'success'}>
            {info.status === 'success' ? 'none' : 'build did not complete'}
          </span>
        {/if}
      {/if}
    </button>
    <span class="spacer"></span>
    {#if info}
      <button type="button" class="small" class:on={tab === 'log' && !collapsed} aria-pressed={tab === 'log' && !collapsed}
        onclick={toggleLog}>{tab === 'log' ? 'Problems' : 'Raw log'}</button>
    {/if}
    <button type="button" class="chev quiet" aria-label={collapsed ? 'Show the problems' : 'Hide the problems'}
      onclick={() => { collapsed = !collapsed }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">
        <path d={collapsed ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
      </svg>
    </button>
  </header>

  {#if !collapsed && info}
    {#if tab === 'problems'}
      <ul class="list">
        {#each info.diagnostics as d, i (i)}
          {@const where = locationText(d)}
          <li>
            <button type="button" class="problem sev-{d.severity}" disabled={!d.fileId && !d.path}
              title={d.fileId || d.path ? `Go to ${where}` : 'Not in a project file'}
              onclick={() => onProblem?.(d)}>
              <span class="mark" aria-label={d.severity}>
                {#if d.severity === 'error'}
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" fill="var(--red)" /><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="#FFFFFF" stroke-width="1.6" /></svg>
                {:else if d.severity === 'warning'}
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1L11.5 11H0.5Z" fill="var(--amber-mark)" /><path d="M6 4.5v3.2M6 8.6v1" stroke="#FFFFFF" stroke-width="1.3" /></svg>
                {:else}
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" fill="none" stroke="var(--ink-4)" stroke-width="1.4" /></svg>
                {/if}
              </span>
              <span class="msg">{d.message}</span>
              {#if where}<span class="where">{where}</span>{/if}
            </button>
          </li>
        {:else}
          <li class="empty">
            {info.status === 'success' ? 'No errors or warnings.'
              : failedEmpty && info.status === 'error' ? 'The build did not complete. See the raw log.'
                : 'No problems were recognised. See the raw log.'}
          </li>
        {/each}
      </ul>
    {:else}
      <div class="lines">
        {#each lines as l, i (i)}
          {#if l.error}
            <button class="line err" type="button" title="Go to {l.error.file}:{l.error.line}"
              onclick={() => l.error && onJump?.(l.error.file, l.error.line)}>{l.text}</button>
          {:else}
            <div class="line">{l.text || ' '}</div>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  .problems-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    font-size: 12.5px;
  }
  header {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 6px 0 4px;
    border-bottom: 1px solid var(--rule);
  }
  .collapsed header { border-bottom: 0; }
  .title {
    border: 0;
    background: transparent;
    gap: 14px;
    padding: 0 10px;
  }
  .title:hover:not(:disabled) { background: transparent; }
  .count { font-weight: 500; font-size: 12px; }
  .count.err { color: var(--red); }
  .count.warn { color: var(--amber); }
  .count.ok { color: var(--green); }
  .spacer { flex: 1; }
  .on { background: var(--paper-2); }
  .chev { width: 28px; padding: 0; color: var(--ink-3); }
  .list {
    flex: 1;
    overflow: auto;
    list-style: none;
    margin: 0;
    padding: 0;
    background: var(--sheet);
  }
  .problem {
    display: flex;
    justify-content: flex-start;
    gap: 10px;
    align-items: baseline;
    width: 100%;
    min-height: 28px;
    padding: 6px 14px;
    text-align: left;
    border: 0;
    border-bottom: 1px solid var(--rule-soft);
    background: none;
    font: 400 12.5px/1.4 var(--font-ui);
    color: var(--ink);
    white-space: normal;
  }
  .problem:hover:not(:disabled) { background: var(--sheet-hover); }
  .problem:disabled { opacity: 1; color: var(--ink-3); }
  .sev-error { background: var(--red-tint); }
  .sev-error:hover:not(:disabled) { background: #F8E6E2; }
  .mark { flex: none; position: relative; top: 1px; display: inline-flex; }
  .msg { flex: 1; white-space: pre-wrap; word-break: break-word; }
  .where {
    flex: none;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: 12px;
    text-decoration: underline;
    text-decoration-color: var(--rule-strong);
    text-underline-offset: 3px;
  }
  .problem:hover:not(:disabled) .where { text-decoration-color: var(--ink); }
  .problem:disabled .where { text-decoration: none; color: var(--ink-4); }
  .lines {
    flex: 1;
    overflow: auto;
    padding: 6px 0;
    background: var(--sheet);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .line {
    display: block;
    width: 100%;
    min-height: 0;
    padding: 0 14px;
    text-align: left;
    font: inherit;
    border: 0;
    background: none;
    white-space: pre-wrap;
    justify-content: flex-start;
    color: var(--ink-2);
  }
  .err {
    color: var(--red);
    background: var(--red-tint);
    cursor: pointer;
  }
  .err:hover:not(:disabled) { text-decoration: underline; background: var(--red-tint); }
  .empty { padding: 10px 14px; color: var(--ink-4); }
</style>
