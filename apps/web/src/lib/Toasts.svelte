<script lang="ts">
  import { dismiss, runAction, toasts } from './toasts.svelte.ts'
</script>

<div class="toasts" aria-live="polite">
  {#each toasts as t (t.id)}
    {#if t.action}
      <div class="toast {t.kind} with-action" role="status">
        <span class="text">{t.text}</span>
        <button type="button" class="action" onclick={() => runAction(t.id)}>{t.action.label}</button>
        <button type="button" class="close" title="Dismiss" aria-label="Dismiss" onclick={() => dismiss(t.id)}>
          <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
    {:else}
      <button type="button" class="toast {t.kind}" onclick={() => dismiss(t.id)}>{t.text}</button>
    {/if}
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    z-index: 100;
    max-width: min(480px, 92vw);
  }
  .toast {
    display: block;
    min-height: 0;
    border: 0;
    border-left: 3px solid var(--teal-edge);
    padding: 10px 14px 10px 12px;
    background: var(--ink);
    color: var(--paper);
    font: 400 13px/1.45 var(--font-ui);
    text-align: left;
    white-space: normal;
    cursor: pointer;
    box-shadow: var(--shadow);
  }
  button.toast:hover:not(:disabled) { background: var(--ink-2); }
  .toast.error { border-left-color: var(--red); }
  .with-action {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-right: 8px;
    cursor: default;
  }
  .with-action .text { flex: 1; }
  .with-action button {
    min-height: 26px;
    border: 1px solid color-mix(in srgb, var(--paper) 35%, transparent);
    background: transparent;
    color: var(--paper);
    padding: 0 10px;
  }
  .with-action button:hover:not(:disabled) { background: var(--ink-2); border-color: var(--paper); }
  .with-action .action { font-weight: 600; text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--teal-edge); }
  .with-action .close { border-color: transparent; padding: 0 5px; color: color-mix(in srgb, var(--paper) 75%, transparent); }
  .with-action .close:hover:not(:disabled) { color: var(--paper); border-color: transparent; }
</style>
