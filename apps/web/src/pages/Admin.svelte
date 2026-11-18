<script lang="ts">
  import { onMount } from 'svelte'
  import type { AdminUpdateUserRequest, AdminUser, RegistrationMode } from '@ligature/shared'
  import { api } from '../lib/api.ts'
  import { loadInstance, session } from '../lib/session.svelte.ts'
  import { errorMessage } from '../lib/errors.ts'
  import { toast } from '../lib/toasts.svelte.ts'
  import { confirmDialog, openDialog } from '../lib/dialogs.svelte.ts'
  import { displayNameProblem, passwordProblem, usernameProblem } from '../lib/validation.ts'
  import { adminUserActions } from '../lib/adminActions.ts'
  import NavBar from '../lib/NavBar.svelte'
  import StorageSection from '../lib/StorageSection.svelte'

  const MODES: { value: RegistrationMode; label: string }[] = [
    { value: 'invite-only', label: 'Invite only: people sign up with a project invite link' },
    { value: 'open', label: 'Open: anyone who can reach this server can sign up' },
    { value: 'closed', label: 'Closed: only administrators create accounts' },
  ]

  let users = $state<AdminUser[] | null>(null)
  let error = $state<string | null>(null)
  let registration = $state<RegistrationMode | null>(null)
  let savedRegistration = $state<RegistrationMode | null>(null)
  let busy = $state(false)

  // create form
  let cUsername = $state('')
  let cDisplay = $state('')
  let cPassword = $state('')
  let cAdmin = $state(false)
  let cTouched = $state(false)
  let cError = $state<string | null>(null)
  let cProblem = $derived(usernameProblem(cUsername) ?? displayNameProblem(cDisplay) ?? passwordProblem(cPassword))

  async function load() {
    try {
      const [u, s] = await Promise.all([api.adminUsers(), api.adminSettings()])
      users = u
      registration = savedRegistration = s.registration
      error = null
    } catch (e) {
      error = errorMessage(e)
    }
  }

  onMount(load)

  async function saveSettings() {
    if (!registration || registration === savedRegistration) return
    busy = true
    try {
      const s = await api.adminUpdateSettings({ registration })
      registration = savedRegistration = s.registration
      toast('Registration setting saved.')
      void loadInstance()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      busy = false
    }
  }

  async function update(u: AdminUser, req: AdminUpdateUserRequest, done: string) {
    try {
      const updated = await api.adminUpdateUser(u.id, req)
      if (users) users = users.map(x => (x.id === updated.id ? updated : x))
      if (updated.id === session.me?.id) session.me = { ...session.me, displayName: updated.displayName, isAdmin: updated.isAdmin }
      toast(done)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function toggleDisabled(u: AdminUser) {
    if (!u.disabled) {
      const ok = await confirmDialog('Disable account',
        `Disable "${u.username}"? They are logged out everywhere immediately and cannot log in until re-enabled.`,
        { confirmLabel: 'Disable', danger: true })
      if (!ok) return
    }
    await update(u, { disabled: !u.disabled }, u.disabled ? `Enabled ${u.username}.` : `Disabled ${u.username}.`)
  }

  async function toggleAdmin(u: AdminUser) {
    const ok = await confirmDialog(u.isAdmin ? 'Remove administrator' : 'Make administrator',
      u.isAdmin ? `Remove administrator rights from "${u.username}"?` : `Give "${u.username}" full administrator rights on this server?`,
      { confirmLabel: u.isAdmin ? 'Remove admin' : 'Make admin', danger: !u.isAdmin })
    if (!ok) return
    await update(u, { isAdmin: !u.isAdmin }, u.isAdmin ? `${u.username} is no longer an administrator.` : `${u.username} is now an administrator.`)
  }

  async function resetPassword(u: AdminUser) {
    const pw = await openDialog({
      title: `Reset password of ${u.username}`,
      message: 'They will be logged out everywhere. Tell them the new password through a safe channel.',
      input: { label: 'New password', type: 'password', validate: v => passwordProblem(v) },
      confirmLabel: 'Set password',
    })
    if (pw === null) return
    await update(u, { password: pw }, `Password of ${u.username} reset.`)
  }

  async function rename(u: AdminUser) {
    const name = await openDialog({
      title: `Display name of ${u.username}`,
      input: { label: 'Display name', value: u.displayName, validate: v => displayNameProblem(v) },
      confirmLabel: 'Save',
    })
    if (name === null || name.trim() === u.displayName) return
    await update(u, { displayName: name.trim() }, 'Display name saved.')
  }

  async function createUser(e: Event) {
    e.preventDefault()
    cTouched = true
    if (cProblem) return
    cError = null
    try {
      const u = await api.adminCreateUser({ username: cUsername.trim().toLowerCase(), displayName: cDisplay.trim(), password: cPassword, isAdmin: cAdmin })
      users = [...(users ?? []), u]
      toast(`Created ${u.username}.`)
      cUsername = cDisplay = cPassword = ''
      cAdmin = false
      cTouched = false
    } catch (err) {
      cError = errorMessage(err)
    }
  }
</script>

<NavBar current="admin" />
<main class="page">
  <h1>Administration</h1>
  {#if !session.me?.isAdmin}
    <p class="error">Only server administrators can see this page.</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if !users}
    <p class="muted">Loading…</p>
  {:else}
    <section class="card">
      <h2>Registration</h2>
      <div class="form">
        {#each MODES as m (m.value)}
          <label class="radio"><input type="radio" name="registration" value={m.value} bind:group={registration} /> {m.label}</label>
        {/each}
        {#if registration === 'open'}
          <p class="warning">Warning: with open registration, <strong>anyone who can reach this server</strong> can create an account
            and use the compiler. Only choose this on a private network or for a short time.</p>
        {/if}
        <div class="row">
          <button type="button" class="primary" disabled={busy || registration === savedRegistration} onclick={saveSettings}>Save</button>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Users</h2>
      <table class="list">
        <thead><tr><th>Username</th><th>Display name</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>
          {#each users as u (u.id)}
            {@const actions = adminUserActions(u.id, session.me.id)}
            <tr class:disabled={u.disabled}>
              <td>{u.username}{#if u.id === session.me.id} <span class="muted">(you)</span>{/if}</td>
              <td>{u.displayName}</td>
              <td>{u.isAdmin ? 'admin' : 'user'}{u.disabled ? ', disabled' : ''}</td>
              <td>{new Date(u.createdAt).toLocaleDateString()}</td>
              <td class="actions">
                {#if actions.includes('rename')}<button type="button" onclick={() => rename(u)}>Rename…</button>{/if}
                {#if actions.includes('reset-password')}
                  <button type="button" onclick={() => resetPassword(u)}>Reset password…</button>
                {:else}
                  <a href="#/account" title="Resetting your own password here would log you out">Change password</a>
                {/if}
                {#if actions.includes('toggle-admin')}
                  <button type="button" onclick={() => toggleAdmin(u)}>{u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
                {/if}
                {#if actions.includes('toggle-disabled')}
                  <button type="button" onclick={() => toggleDisabled(u)}>{u.disabled ? 'Enable' : 'Disable'}</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Create user</h2>
      <form class="form" onsubmit={createUser}>
        <label>Username <input bind:value={cUsername} autocomplete="off" autocapitalize="none" spellcheck="false" /></label>
        <label>Display name <input bind:value={cDisplay} autocomplete="off" /></label>
        <label>Password <input bind:value={cPassword} type="password" autocomplete="new-password" />
          <span class="hint">At least 10 characters. Tell the user through a safe channel.</span></label>
        <label class="radio"><input type="checkbox" bind:checked={cAdmin} /> Administrator</label>
        {#if cTouched && cProblem}<p class="error">{cProblem}</p>{/if}
        <div class="row"><button type="submit" class="primary">Create user</button></div>
        {#if cError}<p class="error" role="alert">{cError}</p>{/if}
      </form>
    </section>

    <StorageSection />
  {/if}
</main>

<style>
  .form label.radio { flex-direction: row; align-items: center; gap: 6px; }
  tr.disabled td { color: #999; }
</style>
