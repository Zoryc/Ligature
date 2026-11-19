<script lang="ts">
  import { onMount } from 'svelte'
  import type { InvitePreview } from '@ligature/shared'
  import { api } from '../lib/api.ts'
  import { session } from '../lib/session.svelte.ts'
  import { go } from '../lib/router.svelte.ts'
  import { loginPath, signupPath } from '../lib/routes.ts'
  import { errorMessage } from '../lib/errors.ts'
  import { toast } from '../lib/toasts.svelte.ts'
  import Logo from '../lib/Logo.svelte'

  interface Props { token: string }
  let { token }: Props = $props()

  let preview = $state<InvitePreview | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)

  let signupClosed = $derived(session.instance?.registration === 'closed' && session.instance.hasUsers)

  onMount(async () => {
    try {
      preview = await api.previewInvite(token)
    } catch (e) {
      error = errorMessage(e)
    }
  })

  async function accept() {
    busy = true
    error = null
    try {
      const r = await api.acceptInvite(token)
      toast(preview ? `You joined "${preview.projectName}".` : 'Invite accepted.')
      go(`/project/${encodeURIComponent(r.projectId)}`)
    } catch (e) {
      error = errorMessage(e)
    } finally {
      busy = false
    }
  }
</script>

<main class="auth">
  <div class="brand"><Logo size={30} /></div>

  <section class="sheet">
    <h1>Project invite</h1>
    {#if error}
      <p class="error" role="alert">{error}</p>
      <p><a href="#/projects">Go to your projects</a></p>
    {:else if !preview}
      <p class="muted">Checking the invite…</p>
    {:else}
      <div class="project">
        <span class="name">{preview.projectName}</span>
        <span class="tag">{preview.role}</span>
      </div>
      <p><strong>{preview.invitedBy}</strong> invited you to join this project as <strong>{preview.role}</strong>.</p>
      <p class="muted small">The link expires {new Date(preview.expiresAt).toLocaleString()}.</p>
      {#if session.me}
        <p class="note">You are logged in as <strong>{session.me.displayName}</strong> ({session.me.username}).</p>
        <div class="stack">
          <button type="button" class="primary submit" disabled={busy} onclick={accept}>{busy ? 'Joining…' : 'Accept and open the project'}</button>
          <a class="later" href="#/projects">Not now</a>
        </div>
      {:else}
        <p class="note">Log in or create an account to accept.</p>
        <div class="stack">
          <button type="button" class="primary submit" onclick={() => go(loginPath(`/invite/${encodeURIComponent(token)}`))}>Log in</button>
          {#if !signupClosed}
            <button type="button" class="submit" onclick={() => go(signupPath(token))}>Create an account</button>
          {/if}
        </div>
      {/if}
    {/if}
  </section>
</main>

<style>
  .auth { max-width: 400px; margin: 10vh auto 64px; padding: 0 20px; }
  .brand { display: flex; justify-content: center; margin-bottom: 22px; }
  .sheet { background: var(--sheet); border: 1px solid var(--rule); padding: 28px 32px 30px; }
  h1 { font-size: 22px; margin: 0 0 18px; }
  .sheet > p { margin: 0 0 12px; }
  .project {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin: 0 0 16px;
    padding: 12px 14px;
    background: var(--paper);
    border-left: 2px solid var(--teal);
  }
  .project .name { font: 600 18px/1.25 var(--font-doc); color: var(--ink); overflow-wrap: anywhere; }
  .small { font-size: 12px; }
  .note { color: var(--ink-3); }
  .stack { display: flex; flex-direction: column; align-items: stretch; gap: 8px; margin-top: 18px; }
  .submit { width: 100%; min-height: 34px; font-size: 13px; }
  .later { align-self: center; margin-top: 4px; }
</style>
