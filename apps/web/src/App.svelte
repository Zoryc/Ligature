<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { go, router } from './lib/router.svelte.ts'
  import { loginPath, PUBLIC_ROUTES, routePath } from './lib/routes.ts'
  import { loadInstance, loadMe, session } from './lib/session.svelte.ts'
  import Toasts from './lib/Toasts.svelte'
  import DialogHost from './lib/DialogHost.svelte'
  import { cancelDialog } from './lib/dialogs.svelte.ts'
  import Login from './pages/Login.svelte'
  import Signup from './pages/Signup.svelte'
  import Invite from './pages/Invite.svelte'
  import Projects from './pages/Projects.svelte'
  import Account from './pages/Account.svelte'
  import Admin from './pages/Admin.svelte'

  // The project page pulls in CodeMirror, Yjs and the collab client: load it only when needed.
  const loadProject = () => import('./pages/Project.svelte')

  onMount(() => {
    void loadInstance()
    void loadMe()
  })

  let route = $derived(router.route)
  let needsLogin = $derived(session.checked && !session.me && !PUBLIC_ROUTES.has(route.name))

  // A dialog belongs to the page that opened it: leaving the page (navigation, project deleted, access
  // lost, session lost) cancels it, so it cannot act on a page or project that is gone.
  let routeKey = $derived(routePath(route))
  $effect(() => {
    void routeKey // the only dependency: untracked below, or opening a dialog would cancel it
    untrack(cancelDialog)
  })

  // Private page without a session: go to the login page, and come back afterwards.
  $effect(() => {
    if (needsLogin) go(loginPath(routePath(route)))
  })
</script>

{#if !session.checked || needsLogin}
  <p class="loading">Loading…</p>
{:else if route.name === 'login'}
  <Login next={route.next} />
{:else if route.name === 'signup'}
  {#key route.invite}<Signup invite={route.invite} setup={route.setup} />{/key}
{:else if route.name === 'invite'}
  {#key route.token}<Invite token={route.token} />{/key}
{:else if !session.me}
  <p class="loading">Loading…</p>
{:else if route.name === 'projects'}
  <Projects />
{:else if route.name === 'account'}
  <Account />
{:else if route.name === 'admin'}
  <Admin tab={route.tab} />
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
<DialogHost />

<style>
  .loading { margin: 48px auto; max-width: 560px; color: #666; }
</style>
