<script lang="ts">
  import { parseLog, type LogInfo } from './logParse.ts'

  interface Props {
    info: LogInfo | null
    onJump?: (file: string, line: number) => void
  }

  let { info, onJump }: Props = $props()

  let lines = $derived(info ? parseLog(info.log) : [])
  let errorCount = $derived(lines.filter(l => l.error).length)
  let showFull = $state(false)
</script>

<div class="log">
  {#if !info}
    <div class="empty">No build yet.</div>
  {:else}
    <div class="summary">
      <span class="status status-{info.status}">{info.status}</span>
      {#if info.durationMs !== null}<span>{(info.durationMs / 1000).toFixed(1)} s</span>{/if}
      {#if info.source}<span class="muted">{info.source}</span>{/if}
      <span class="muted">{errorCount} file:line error{errorCount === 1 ? '' : 's'}</span>
      <label class="toggle"><input type="checkbox" bind:checked={showFull} /> full log</label>
    </div>
    <div class="lines">
      {#each lines as l, i (i)}
        {#if l.error}
          <button class="line err" type="button" title="Go to {l.error.file}:{l.error.line}"
            onclick={() => l.error && onJump?.(l.error.file, l.error.line)}>{l.text}</button>
        {:else if showFull}
          <div class="line">{l.text || ' '}</div>
        {/if}
      {/each}
      {#if !showFull && errorCount === 0}
        <div class="muted pad">No file:line errors. Tick "full log" to see everything.</div>
      {/if}
    </div>
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
  .toggle { margin-left: auto; }
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
