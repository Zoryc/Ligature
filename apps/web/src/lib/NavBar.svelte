<script lang="ts">
  import { logout, session } from './session.svelte.ts'
  import Logo from './Logo.svelte'
  import Avatar from './Avatar.svelte'

  interface Props { current: 'projects' | 'account' | 'admin' | 'other' }
  let { current }: Props = $props()
</script>

<header class="nav">
  <a class="brand" href="#/projects" aria-label="Ligature, all projects"><Logo /></a>
  <nav aria-label="Main">
    <a href="#/projects" class:active={current === 'projects'} aria-current={current === 'projects' ? 'page' : undefined}>Projects</a>
    <a href="#/account" class:active={current === 'account'} aria-current={current === 'account' ? 'page' : undefined}>Account</a>
    {#if session.me?.isAdmin}
      <a href="#/admin" class:active={current === 'admin'} aria-current={current === 'admin' ? 'page' : undefined}>Admin</a>
    {/if}
  </nav>
  <span class="spacer"></span>
  {#if session.me}
    <span class="me">
      <Avatar id={session.me.id} name={session.me.displayName} />
      <span>{session.me.displayName} <span class="muted">@{session.me.username}</span></span>
    </span>
  {/if}
  <button type="button" onclick={logout}>Log out</button>
</header>

<style>
  .nav {
    display: flex;
    align-items: center;
    gap: 24px;
    min-height: 50px;
    padding: 6px 20px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
    flex-wrap: wrap;
  }
  .brand { position: relative; top: -3px; color: var(--ink); text-decoration: none; }
  nav { display: flex; align-self: stretch; gap: 4px; }
  nav a {
    display: inline-flex;
    align-items: center;
    padding: 0 10px;
    color: var(--ink-3);
    text-decoration: none;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    margin-bottom: -7px;
  }
  nav a:hover { color: var(--ink); }
  nav a.active { color: var(--ink); border-bottom-color: var(--teal); }
  .spacer { flex: 1; }
  .me { display: inline-flex; align-items: center; gap: 8px; }
</style>
