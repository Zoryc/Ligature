<script lang="ts">
  import { dismiss, runAction, toasts } from './toasts.svelte.ts'
</script>

<div class="toasts" aria-live="polite">
  {#each toasts as t (t.id)}
    {#if t.action}
      <div class="toast {t.kind} with-action" role="status">
        <span class="text">{t.text}</span>
        <button type="button" class="action" onclick={() => runAction(t.id)}>{t.action.label}</button>
        <button type="button" class="close" title="Dismiss" aria-label="Dismiss" onclick={() => dismiss(t.id)}>×</button>
      </div>
    {:else}
      <button type="button" class="toast {t.kind}" onclick={() => dismiss(t.id)}>{t.text}</button>
    {/if}
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 12px;
    bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 100;
    max-width: min(480px, 92vw);
  }
  .toast {
    border: 0;
    border-radius: 4px;
    padding: 8px 12px;
    background: #333;
    color: white;
    font: inherit;
    text-align: left;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  }
  .toast.error { background: #b00020; }
  .with-action {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: default;
  }
  .with-action .text { flex: 1; }
  .with-action button {
    border: 1px solid #888;
    background: transparent;
    color: white;
    padding: 2px 10px;
  }
  .with-action button:hover:not(:disabled) { background: #555; }
  .with-action .action { font-weight: 600; border-color: #9db3e8; color: #cfdcff; }
  .with-action .close { border: 0; padding: 0 4px; font-size: 16px; }
</style>
