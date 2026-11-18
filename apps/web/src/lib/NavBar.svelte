<script lang="ts">
  import { logout, session } from './session.svelte.ts'

  interface Props { current: 'projects' | 'account' | 'admin' | 'other' }
  let { current }: Props = $props()
</script>

<nav class="nav">
  <strong class="brand">Ligature</strong>
  <a href="#/projects" class:active={current === 'projects'}>Projects</a>
  <a href="#/account" class:active={current === 'account'}>Account</a>
  {#if session.me?.isAdmin}<a href="#/admin" class:active={current === 'admin'}>Admin</a>{/if}
  <span class="spacer"></span>
  {#if session.me}<span class="muted">{session.me.displayName} ({session.me.username})</span>{/if}
  <button type="button" onclick={logout}>Log out</button>
</nav>

<style>
  .nav {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 16px;
    border-bottom: 1px solid #ccc;
    background: #f6f6f6;
    flex-wrap: wrap;
  }
  .brand { margin-right: 8px; }
  .active { font-weight: 600; text-decoration: none; color: #222; }
  .spacer { flex: 1; }
</style>
