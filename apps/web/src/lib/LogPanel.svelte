<script lang="ts">
  import type { Diagnostic } from '@ligature/shared'
  import { parseLog, type LogInfo } from './logParse.ts'
  import { countSeverities, locationText, problemsSummary } from './diagnostics.ts'

  interface Props {
    info: LogInfo | null
    /** A `file:line:` line of the raw log was clicked. */
    onJump?: (file: string, line: number) => void
    /** A problem was clicked. */
    onProblem?: (d: Diagnostic) => void
  }

  let { info, onJump, onProblem }: Props = $props()

  let tab = $state<'problems' | 'log'>('problems')
  let lines = $derived(info && tab === 'log' ? parseLog(info.log) : [])
  let counts = $derived(countSeverities(info?.diagnostics ?? []))
  let summary = $derived(problemsSummary(counts))

  const ICON = { error: 'E', warning: 'W', info: 'i' } as const
</script>

<div class="log">
  {#if !info}
    <div class="empty">No build yet.</div>
  {:else}
    <div class="summary">
      <span class="status status-{info.status}">{info.status}</span>
      {#if info.durationMs !== null}<span>{(info.durationMs / 1000).toFixed(1)} s</span>{/if}
      {#if info.source}<span class="muted">{info.source}</span>{/if}
      <span class="tabs" role="tablist">
        <button type="button" role="tab" class:active={tab === 'problems'} aria-selected={tab === 'problems'}
          onclick={() => { tab = 'problems' }}>Problems: <span class:has-errors={counts.errors > 0}>{summary}</span></button>
        <button type="button" role="tab" class:active={tab === 'log'} aria-selected={tab === 'log'}
          onclick={() => { tab = 'log' }}>Raw log</button>
      </span>
    </div>
    {#if tab === 'problems'}
      <ul class="problems">
        {#each info.diagnostics as d, i (i)}
          {@const where = locationText(d)}
          <li>
            <button type="button" class="problem sev-{d.severity}" disabled={!d.fileId && !d.path}
              title={d.fileId || d.path ? `Go to ${where}` : 'Not in a project file'}
              onclick={() => onProblem?.(d)}>
              <span class="icon" aria-label={d.severity}>{ICON[d.severity]}</span>
              <span class="msg">{d.message}</span>
              {#if where}<span class="where">{where}</span>{/if}
            </button>
          </li>
        {:else}
          <li class="muted pad">
            {info.status === 'success' ? 'No errors or warnings.'
              : info.status === 'error' ? 'The build did not complete. See the raw log.'
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
</div>

<style>
  .log {
    height: 100%;
    display: flex;
    flex-direction: column;
    font-size: 12px;
    background: #fafafa;
  }
  .summary {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 4px 8px;
    border-bottom: 1px solid #ddd;
    flex-wrap: wrap;
  }
  .status {
    font-weight: bold;
    text-transform: uppercase;
  }
  .status-success { color: #1b7f3b; }
  .status-failure, .status-error { color: #b00020; }
  .status-timeout { color: #a15c00; }
  .tabs { margin-left: auto; display: flex; gap: 4px; }
  .tabs button { font-size: 12px; padding: 1px 8px; }
  .tabs button.active { background: #dde4ff; }
  .has-errors { color: #b00020; font-weight: 600; }
  .problems {
    flex: 1;
    overflow: auto;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .problem {
    display: flex;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    text-align: left;
    border: 0;
    border-bottom: 1px solid #eee;
    border-radius: 0;
    background: none;
    padding: 3px 8px;
    font: inherit;
  }
  .problem:hover:not(:disabled) { background: #eef; }
  .problem:disabled { opacity: 1; color: #555; }
  .icon {
    flex: none;
    width: 16px;
    height: 16px;
    line-height: 16px;
    border-radius: 50%;
    text-align: center;
    font-weight: bold;
    font-size: 11px;
    color: white;
  }
  .sev-error .icon { background: #b00020; }
  .sev-warning .icon { background: #c77800; }
  .sev-info .icon { background: #6b7a90; }
  .msg { flex: 1; white-space: pre-wrap; word-break: break-word; }
  .where { flex: none; color: #2a5bd7; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  .problem:disabled .where { color: #666; }
  .lines {
    flex: 1;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .line {
    display: block;
    width: 100%;
    padding: 0 8px;
    text-align: left;
    font: inherit;
    border: 0;
    background: none;
  }
  .err {
    color: #b00020;
    background: #fdecee;
    cursor: pointer;
  }
  .err:hover { text-decoration: underline; }
  .muted { color: #666; }
  .pad { padding: 8px; }
  .empty { padding: 8px; color: #666; }
</style>
