<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { mountMergeView, type MergeHandle } from './mergeView.ts'
  import { RECOVERY_TITLE, recoveryMessage } from './recovery.ts'
  import { errorMessage } from './errors.ts'

  interface Props {
    path: string
    /** This tab's text, with the edits the server never received. */
    localText: string
    /** The server's current text (null when it could not be loaded). */
    serverText: string | null
    error: string | null
    onCopy: () => void
    onOpenCurrent: () => void
  }

  let { path, localText, serverText, error, onCopy, onOpenCurrent }: Props = $props()

  let host = $state<HTMLDivElement | undefined>(undefined)
  let copyBtn = $state<HTMLButtonElement | undefined>(undefined)
  let viewError = $state<string | null>(null)
  let loading = $state(true)
  let merge: MergeHandle | null = null
  let seq = 0

  $effect(() => {
    if (!host) return
    const el = host
    const my = ++seq
    const a = localText
    const b = serverText ?? ''
    const p = path
    loading = true
    viewError = null
    void mountMergeView(el, p, a, b).then(m => {
      if (my !== seq) return m.destroy()
      merge?.destroy()
      merge = m
    }, e => {
      if (my === seq) viewError = `Could not show the comparison: ${errorMessage(e)}`
    }).finally(() => { if (my === seq) loading = false })
    return () => {
      seq++
      merge?.destroy()
      merge = null
    }
  })

  void tick().then(() => copyBtn?.focus())

  onDestroy(() => {
    merge?.destroy()
    merge = null
  })
</script>

<div class="backdrop" role="presentation">
  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="recovery-title" aria-describedby="recovery-text">
    <h2 id="recovery-title">{RECOVERY_TITLE}</h2>
    <p id="recovery-text">{recoveryMessage(path)}</p>
    {#if error}<p class="error">{error}</p>{/if}
    {#if viewError}<p class="error">{viewError}</p>{/if}
    <div class="sides">
      <div class="side-title">Your text (not saved)</div>
      <div class="side-title">Current version on the server{serverText === null ? ' (unavailable)' : ''}</div>
    </div>
    {#if loading}<p class="muted pad">Loading…</p>{/if}
    <div class="merge" bind:this={host}></div>
    <div class="buttons">
      <button type="button" bind:this={copyBtn} onclick={onCopy}>Copy my text</button>
      <button type="button" class="primary" onclick={onOpenCurrent}>Open the current version</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 6vh;
    z-index: 150;
  }
  .dialog {
    background: white;
    border-radius: 4px;
    padding: 16px 20px;
    width: min(1100px, 94vw);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }
  h2 { margin: 0 0 8px; font-size: 16px; }
  p { margin: 0 0 8px; }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border: 1px solid #ddd;
    border-bottom: 0;
    font-size: 12px;
    font-weight: 600;
    background: #fafafa;
  }
  .side-title { padding: 4px 10px; }
  .side-title + .side-title { border-left: 1px solid #ddd; }
  .pad { padding: 4px 10px; }
  .merge {
    flex: 1;
    min-height: 120px;
    overflow: auto;
    border: 1px solid #ddd;
    font-size: 13px;
  }
  .merge :global(.cm-editor) { height: auto; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
