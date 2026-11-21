<script lang="ts">
  /**
   * "Delete your account" (docs/ACCOUNT-DELETION.md). Not a DialogHost dialog: it loads the preview first,
   * links the projects that block it, and keeps the password field open on a wrong password. Same look.
   */
  import { onMount, tick } from 'svelte'
  import type { AccountDeletionPreview } from '@ligature/shared'
  import { api } from './api.ts'
  import { errorCode, errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'
  import { accountDeleted } from './session.svelte.ts'
  import { CANNOT_UNDO, selfDeletionView } from './accountDeletion.ts'

  interface Props { onclose: () => void }
  let { onclose }: Props = $props()

  let preview = $state<AccountDeletionPreview | null>(null)
  let loadError = $state<string | null>(null)
  let view = $derived(preview ? selfDeletionView(preview) : null)
  let password = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let field = $state<HTMLInputElement | undefined>(undefined)
  let closeBtn = $state<HTMLButtonElement | undefined>(undefined)

  async function load() {
    try {
      preview = await api.deletionPreview()
      loadError = null
    } catch (e) {
      loadError = errorMessage(e)
    }
    await tick()
    const first = field ?? closeBtn
    first?.focus()
  }

  onMount(() => { void load() })

  async function submit(e: Event) {
    e.preventDefault()
    if (busy || password === '' || view?.state !== 'ready') return
    busy = true
    error = null
    try {
      await api.deleteMe(password)
      toast('Your account was deleted.')
      accountDeleted()
    } catch (err) {
      const code = errorCode(err)
      if (code === 'owns-shared-projects' || code === 'last-admin') {
        // Something changed since the preview (e.g. someone joined a project): show the new reason.
        password = ''
        await load()
        return
      }
      error = errorMessage(err)
      field?.select()
    } finally {
      busy = false
    }
  }

  function close() {
    if (!busy) onclose()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="presentation" onclick={e => { if (e.target === e.currentTarget) close() }}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
  <form onsubmit={submit}>
    <div class="body">
      <h2 id="delete-account-title">Delete your account</h2>
      {#if loadError}
        <p class="problem" role="alert">{loadError}</p>
      {:else if !view}
        <p class="message muted">Checking what would be deleted…</p>
      {:else if view.state === 'blocked'}
        <p class="message">{view.text}</p>
        {#if view.projects.length > 0}
          <ul class="projects">
            {#each view.projects as p (p.id)}<li><a href="#/project/{encodeURIComponent(p.id)}">{p.name}</a></li>{/each}
          </ul>
        {/if}
      {:else}
        <p class="message">{view.deletedText}</p>
        {#if view.deleted.length > 0}
          <ul class="projects">
            {#each view.deleted as p (p.id)}<li>{p.name}</li>{/each}
          </ul>
        {/if}
        {#each view.notes as n (n)}<p class="message">{n}</p>{/each}
        <p class="message final">{CANNOT_UNDO}</p>
        <label>
          Your password
          <input bind:this={field} bind:value={password} type="password" autocomplete="current-password" />
        </label>
        {#if error}<p class="problem" role="alert">{error}</p>{/if}
      {/if}
    </div>
    <div class="buttons">
      {#if view?.state === 'ready' && !loadError}
        <button type="button" onclick={close} disabled={busy}>Cancel</button>
        <button type="submit" class="danger solid" disabled={busy || password === ''}>{busy ? 'Deleting…' : 'Delete my account'}</button>
      {:else}
        <button bind:this={closeBtn} type="button" onclick={close}>Close</button>
      {/if}
    </div>
  </form>
  </div>
</div>

<style>
  /* The look of DialogHost.svelte. */
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--ink) 28%, transparent);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 200;
  }
  .dialog {
    background: var(--sheet);
    border: 1px solid var(--rule-strong);
    width: min(480px, 92vw);
    box-shadow: var(--shadow);
  }
  .body { padding: 20px 22px 18px; }
  h2 { margin: 0 0 10px; font-size: 18px; line-height: 1.25; }
  .message { margin: 0 0 8px; color: var(--ink-2); line-height: 1.5; }
  .final { font-weight: 600; color: var(--red); }
  .projects {
    max-height: 168px;
    overflow-y: auto;
    margin: 0 0 10px;
    padding: 4px 0;
    list-style: none;
    border: 1px solid var(--rule-soft);
    background: var(--paper);
  }
  .projects li { padding: 3px 12px; font-family: var(--font-doc); color: var(--ink); }
  label { display: block; margin: 14px 0 0; font-weight: 500; color: var(--ink-2); }
  input { display: block; width: 100%; margin-top: 5px; }
  .problem { color: var(--red); margin: 6px 0 0; font-size: 12.5px; }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 22px;
    background: var(--paper);
    border-top: 1px solid var(--rule);
  }
</style>
