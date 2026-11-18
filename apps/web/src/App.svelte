<script lang="ts">
  import { onMount } from 'svelte'
  import { router } from './lib/router.svelte.ts'
  import { loadMe, session } from './lib/session.svelte.ts'
  import Toasts from './lib/Toasts.svelte'
  import Login from './pages/Login.svelte'
  import Projects from './pages/Projects.svelte'

  // The project page pulls in CodeMirror, Yjs and the collab client: load it only when needed.
  const loadProject = () => import('./pages/Project.svelte')

  onMount(() => {
    void loadMe()
  })

  let route = $derived(router.route)
</script>

{#if !session.checked}
  <p class="loading">Loading…</p>
{:else if route.name === 'login' || !session.me}
  <Login />
{:else if route.name === 'projects'}
  <Projects />
{:else if route.name === 'project'}
  {#await loadProject()}
    <p class="loading">Loading…</p>
  {:then { default: Project }}
    {#key route.id}
      <Project id={route.id} me={session.me} />
    {/key}
  {:catch err}
    <p class="loading">Could not load the editor: {String(err)}</p>
  {/await}
{:else}
  <main class="loading">
    <p>Page not found.</p>
    <a href="#/projects">Projects</a>
  </main>
{/if}

<Toasts />

<style>
  .loading { margin: 48px auto; max-width: 560px; color: #666; }
</style>
