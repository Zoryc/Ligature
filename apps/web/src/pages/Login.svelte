<script lang="ts">
  import { onMount } from 'svelte'
  import { devLogin, loadInstance, login, logout, session } from '../lib/session.svelte.ts'
  import { go } from '../lib/router.svelte.ts'
  import { signupPath } from '../lib/routes.ts'
  import { errorMessage } from '../lib/errors.ts'

  interface Props { next: string | null }
  let { next }: Props = $props()

  const DEV_USERS = ['alice', 'bob', 'carol'] as const
  let username = $state('')
  let password = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)

  let instance = $derived(session.instance)
  /** If we came here from an invite, signing up should carry the invite token along. */
  let inviteToken = $derived(next?.startsWith('/invite/') ? decodeURIComponent(next.slice('/invite/'.length)) : null)

  // The registration mode may have changed since the app loaded.
  onMount(() => { void loadInstance() })

  function done() {
    go(next ?? '/projects')
  }

  async function submit(e: Event) {
    e.preventDefault()
    if (busy) return
    busy = true
    error = null
    try {
      await login(username.trim(), password)
      password = ''
      done()
    } catch (err) {
      error = errorMessage(err)
    } finally {
      busy = false
    }
  }

  async function quick(u: string) {
    busy = true
    error = null
    try {
      await devLogin(u)
      done()
    } catch (err) {
      error = `Dev login failed: ${errorMessage(err)}`
    } finally {
      busy = false
    }
  }
</script>

<main class="page narrow">
  <h1>Log in to Ligature</h1>

  {#if instance && !instance.hasUsers}
    <p class="warning">This server has no accounts yet. <a href="#/signup">Create the first account</a>; it becomes the administrator.</p>
  {/if}

  {#if session.me}
    <p>You are logged in as <strong>{session.me.displayName}</strong> ({session.me.username}).
      <button type="button" class="link" onclick={done}>Continue</button> or
      <button type="button" class="link" onclick={logout}>log out</button>.</p>
  {/if}

  <form class="form" onsubmit={submit}>
    <label>Username <input bind:value={username} autocomplete="username" autocapitalize="none" spellcheck="false" required /></label>
    <label>Password <input bind:value={password} type="password" autocomplete="current-password" required /></label>
    <div class="row">
      <button type="submit" class="primary" disabled={busy || !username.trim() || !password}>{busy ? 'Logging in…' : 'Log in'}</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </form>

  {#if instance}
    {#if instance.registration === 'open' || inviteToken}
      <p>No account yet? <a href="#{signupPath(inviteToken)}">Sign up</a></p>
    {:else if instance.registration === 'invite-only' && instance.hasUsers}
      <p class="muted">To create an account, open an invite link you received from a project owner.</p>
    {:else if instance.hasUsers}
      <p class="muted">Registration is closed. Ask an administrator for an account.</p>
    {/if}
  {/if}

  {#if instance?.devLogin}
    <section class="card">
      <h2>Development quick login</h2>
      <p class="muted">Seeded users (no password needed here): alice = owner and admin, bob = editor, carol = viewer.</p>
      <div class="actions">
        {#each DEV_USERS as u (u)}
          <button type="button" disabled={busy} onclick={() => quick(u)}>Log in as {u}</button>
        {/each}
      </div>
    </section>
  {/if}
</main>
