<script lang="ts">
  import { onMount } from 'svelte'
  import type { ProjectSummary } from '@ligature/shared'
  import { api } from '../lib/api.ts'
  import { logout, session } from '../lib/session.svelte.ts'

  let projects = $state<ProjectSummary[] | null>(null)
  let error = $state<string | null>(null)

  onMount(async () => {
    try {
      projects = await api.projects()
    } catch (e) {
      error = `Could not load projects: ${(e as Error).message}`
    }
  })
</script>

<main class="page">
  <header>
    <h1>Projects</h1>
    <span class="muted">{session.me?.displayName}</span>
    <button type="button" onclick={logout}>Log out</button>
  </header>
  {#if error}
    <p class="error">{error}</p>
  {:else if !projects}
    <p class="muted">Loading…</p>
  {:else if projects.length === 0}
    <p class="muted">You are not a member of any project yet.</p>
  {:else}
    <ul>
      {#each projects as p (p.id)}
        <li><a href="#/project/{p.id}">{p.name}</a> <span class="muted">({p.role})</span></li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  .page { max-width: 720px; margin: 32px auto; padding: 0 16px; }
  header { display: flex; align-items: center; gap: 12px; }
  header h1 { margin-right: auto; }
  li { margin: 6px 0; }
  .muted { color: #666; }
  .error { color: #b00020; }
</style>
