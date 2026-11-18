<script lang="ts">
  import { devLogin, logout, session } from '../lib/session.svelte.ts'
  import { go } from '../lib/router.svelte.ts'

  const USERS = ['alice', 'bob', 'carol'] as const
  let busy = $state(false)
  let error = $state<string | null>(null)

  async function login(username: string) {
    busy = true
    error = null
    try {
      await devLogin(username)
      go('/projects')
    } catch (e) {
      error = `Login failed: ${(e as Error).message}`
    } finally {
      busy = false
    }
  }
</script>

<main class="page">
  <h1>Ligature</h1>
  <p class="muted">Development login (no password). alice = owner, bob = editor, carol = viewer.</p>
  {#if session.me}
    <p>Logged in as <strong>{session.me.displayName}</strong> ({session.me.username}).
      <a href="#/projects">Go to projects</a></p>
  {/if}
  <div class="buttons">
    {#each USERS as u (u)}
      <button type="button" disabled={busy} onclick={() => login(u)}>Log in as {u}</button>
    {/each}
    {#if session.me}<button type="button" onclick={logout}>Log out</button>{/if}
  </div>
  {#if error}<p class="error">{error}</p>{/if}
</main>

<style>
  .page { max-width: 560px; margin: 48px auto; padding: 0 16px; }
  .buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  .muted { color: #666; }
  .error { color: #b00020; }
</style>
