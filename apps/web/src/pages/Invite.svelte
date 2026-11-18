<script lang="ts">
  import { onMount } from 'svelte'
  import type { InvitePreview } from '@ligature/shared'
  import { api } from '../lib/api.ts'
  import { session } from '../lib/session.svelte.ts'
  import { go } from '../lib/router.svelte.ts'
  import { loginPath, signupPath } from '../lib/routes.ts'
  import { errorMessage } from '../lib/errors.ts'
  import { toast } from '../lib/toasts.svelte.ts'

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

<main class="page narrow">
  <h1>Project invite</h1>
  {#if error}
    <p class="error" role="alert">{error}</p>
    <p><a href="#/projects">Go to your projects</a></p>
  {:else if !preview}
    <p class="muted">Checking the invite…</p>
  {:else}
    <p><strong>{preview.invitedBy}</strong> invited you to join <strong>{preview.projectName}</strong> as <strong>{preview.role}</strong>.</p>
    <p class="muted">The link expires {new Date(preview.expiresAt).toLocaleString()}.</p>
    {#if session.me}
      <p>You are logged in as <strong>{session.me.displayName}</strong> ({session.me.username}).</p>
      <div class="actions">
        <button type="button" class="primary" disabled={busy} onclick={accept}>{busy ? 'Joining…' : 'Accept and open the project'}</button>
        <a href="#/projects">Not now</a>
      </div>
    {:else}
      <p>Log in or create an account to accept.</p>
      <div class="actions">
        <button type="button" class="primary" onclick={() => go(loginPath(`/invite/${encodeURIComponent(token)}`))}>Log in</button>
        {#if !signupClosed}
          <button type="button" onclick={() => go(signupPath(token))}>Create an account</button>
        {/if}
      </div>
    {/if}
  {/if}
</main>
