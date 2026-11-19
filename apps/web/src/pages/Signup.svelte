<script lang="ts">
  import { onMount } from 'svelte'
  import type { InvitePreview } from '@ligature/shared'
  import { api } from '../lib/api.ts'
  import { loadInstance, session, signup } from '../lib/session.svelte.ts'
  import { go } from '../lib/router.svelte.ts'
  import { loginPath } from '../lib/routes.ts'
  import { errorMessage } from '../lib/errors.ts'
  import { toast } from '../lib/toasts.svelte.ts'
  import { displayNameProblem, passwordProblem, signupMode, usernameProblem } from '../lib/validation.ts'
  import Logo from '../lib/Logo.svelte'

  interface Props { invite: string | null }
  let { invite }: Props = $props()

  let username = $state('')
  let displayName = $state('')
  let password = $state('')
  let confirm = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let touched = $state(false)
  let preview = $state<InvitePreview | null>(null)
  let inviteError = $state<string | null>(null)

  let instance = $derived(session.instance)
  let mode = $derived(instance ? signupMode(instance, invite !== null && inviteError === null) : null)
  let problem = $derived(usernameProblem(username) ?? displayNameProblem(displayName) ?? passwordProblem(password, confirm))

  onMount(async () => {
    void loadInstance() // the registration mode may have changed since the app loaded
    if (!invite) return
    try {
      preview = await api.previewInvite(invite)
    } catch (e) {
      inviteError = errorMessage(e, { 'not-found': 'This invite link is invalid.' })
    }
  })

  async function submit(e: Event) {
    e.preventDefault()
    touched = true
    if (busy || problem) return
    busy = true
    error = null
    try {
      await signup({
        username: username.trim().toLowerCase(), displayName: displayName.trim(), password,
        ...(invite && mode === 'with-invite' ? { inviteToken: invite } : {}),
      })
      if (preview && mode === 'with-invite') toast(`Welcome! You joined "${preview.projectName}" as ${preview.role}.`)
      else if (mode === 'first-user') toast('Welcome! Your account is the server administrator.')
      go('/projects')
    } catch (err) {
      error = errorMessage(err)
    } finally {
      busy = false
    }
  }
</script>

<main class="auth">
  <div class="brand"><Logo size={30} /></div>

  <section class="sheet">
    <h1>Create an account</h1>

    {#if session.me}
      <p class="note">You are already logged in as <strong>{session.me.displayName}</strong>.
        {#if invite}<a href="#/invite/{encodeURIComponent(invite)}">Back to the invite</a>{:else}<a href="#/projects">Go to projects</a>{/if}</p>
    {/if}

    {#if !instance}
      <p class="muted">Loading…</p>
    {:else}
      {#if mode === 'first-user'}
        <p class="warning">This server has no accounts yet. The account you create now becomes the <strong>server administrator</strong>.</p>
      {/if}
      {#if invite}
        {#if inviteError}
          <p class="error">{inviteError}</p>
        {:else if preview}
          <p class="invite">You were invited by <strong>{preview.invitedBy}</strong> to join <strong class="doc">{preview.projectName}</strong> as <strong>{preview.role}</strong>.</p>
        {/if}
      {/if}

      {#if mode === 'closed'}
        <p class="error">Registration is closed on this server. Ask an administrator for an account.</p>
      {:else if mode === 'needs-invite'}
        <p class="error">You need an invite link to sign up on this server. Ask a project owner for one.</p>
      {:else}
        <form class="form" onsubmit={submit}>
          <label>Username
            <input bind:value={username} autocomplete="username" autocapitalize="none" spellcheck="false" />
            <span class="hint">3–32 characters: lowercase letters, digits, dot, dash, underscore.</span>
          </label>
          <label>Display name <input bind:value={displayName} autocomplete="name" /></label>
          <label>Password
            <input bind:value={password} type="password" autocomplete="new-password" />
            <span class="hint">At least 10 characters.</span>
          </label>
          <label>Repeat password <input bind:value={confirm} type="password" autocomplete="new-password" /></label>
          {#if touched && problem}<p class="error">{problem}</p>{/if}
          <button type="submit" class="primary submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
          {#if error}<p class="error" role="alert">{error}</p>{/if}
        </form>
      {/if}
    {/if}
  </section>

  {#if instance?.hasUsers}
    <p class="foot">Already have an account? <a href="#{loginPath(invite ? `/invite/${encodeURIComponent(invite)}` : null)}">Log in</a></p>
  {/if}
</main>

<style>
  .auth { max-width: 400px; margin: 10vh auto 64px; padding: 0 20px; }
  .brand { display: flex; justify-content: center; margin-bottom: 22px; }
  .sheet { background: var(--sheet); border: 1px solid var(--rule); padding: 28px 32px 30px; }
  h1 { font-size: 22px; margin: 0 0 18px; }
  .sheet > p { margin: 0 0 16px; }
  .note { color: var(--ink-3); }
  .invite { padding: 10px 12px; background: var(--paper); border-left: 2px solid var(--teal); }
  .doc { font-family: var(--font-doc); font-weight: 600; font-size: 14px; }
  .submit { width: 100%; min-height: 34px; margin-top: 4px; font-size: 13px; }
  .form .error { margin: 0; }
  .foot { text-align: center; margin: 16px 0 0; color: var(--ink-3); }
</style>
