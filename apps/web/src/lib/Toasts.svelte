<script lang="ts">
  import { dismiss, toasts } from './toasts.svelte.ts'
</script>

<div class="toasts" aria-live="polite">
  {#each toasts as t (t.id)}
    <button type="button" class="toast {t.kind}" onclick={() => dismiss(t.id)}>{t.text}</button>
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
</style>
