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
  import AuditLog from '../lib/AuditLog.svelte'
  import Avatar from '../lib/Avatar.svelte'
  import { go } from '../lib/router.svelte.ts'
  import { adminPath, ADMIN_TABS, type AdminTab } from '../lib/routes.ts'

  interface Props { tab: AdminTab }
  let { tab }: Props = $props()

  const TAB_LABELS: Record<AdminTab, string> = { users: 'Users', storage: 'Storage', audit: 'Audit log' }

  /** Arrow keys, Home and End move between the tabs (each tab is a link to its route). */
  function tabKey(e: KeyboardEvent) {
    const i = ADMIN_TABS.indexOf(tab)
    const to = e.key === 'ArrowRight' ? (i + 1) % ADMIN_TABS.length
      : e.key === 'ArrowLeft' ? (i - 1 + ADMIN_TABS.length) % ADMIN_TABS.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? ADMIN_TABS.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    const next = ADMIN_TABS[to]!
    document.getElementById(`admin-tab-${next}`)?.focus()
    go(adminPath(next))
  }

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

  /** The running Ligature version: shown to admins only (GET /api/admin/about). */
  let version = $state<string | null>(null)

  onMount(() => {
    void load()
    api.adminAbout().then(a => { version = a.version }, () => { version = null })
  })

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
<main class="page" class:wide={tab === 'audit'}>
  <h1>Administration</h1>
  {#if !session.me?.isAdmin}
    <p class="error">Only server administrators can see this page.</p>
  {:else}
    <div class="tabs" role="tablist" aria-label="Administration">
      {#each ADMIN_TABS as t (t)}
        <a id="admin-tab-{t}" role="tab" href="#{adminPath(t)}" aria-selected={tab === t} aria-controls="admin-panel"
          tabindex={tab === t ? 0 : -1} onkeydown={tabKey}>{TAB_LABELS[t]}</a>
      {/each}
    </div>
    <div id="admin-panel" role="tabpanel" aria-labelledby="admin-tab-{tab}">
      {#if tab === 'storage'}
        <StorageSection />
      {:else if tab === 'audit'}
        <AuditLog />
      {:else if error}
        <p class="error">{error}</p>
      {:else if !users}
        <p class="muted">Loading…</p>
      {:else}
        <section class="card">
          <h2>Registration</h2>
          <p class="sub">Who can create an account on this server.</p>
          <div class="form">
            <div class="modes" role="radiogroup" aria-label="Registration">
              {#each MODES as m (m.value)}
                {@const cut = m.label.indexOf(': ')}
                <label class="mode" class:on={registration === m.value}>
                  <input type="radio" name="registration" value={m.value} bind:group={registration} />
                  <span><strong>{m.label.slice(0, cut)}</strong><span class="desc">{m.label.slice(cut + 2)}</span></span>
                </label>
              {/each}
            </div>
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
          <div class="table-wrap">
            <table class="list users">
              <thead><tr><th>Username</th><th>Display name</th><th>Status</th><th>Created</th><th><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {#each users as u (u.id)}
                  {@const actions = adminUserActions(u.id, session.me.id)}
                  <tr class:disabled={u.disabled}>
                    <td>
                      <span class="person">
                        <Avatar id={u.id} name={u.displayName} size={20} />
                        <span class="mono">{u.username}</span>{#if u.id === session.me.id}<span class="muted">(you)</span>{/if}
                      </span>
                    </td>
                    <td>{u.displayName}</td>
                    <td class="status">
                      <span class="tag" class:admin={u.isAdmin}>{u.isAdmin ? 'admin' : 'user'}</span>
                      {#if u.disabled}<span class="tag off">disabled</span>{/if}
                    </td>
                    <td class="when">{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td class="end">
                      <span class="btns">
                        {#if actions.includes('rename')}<button type="button" class="small" onclick={() => rename(u)}>Rename…</button>{/if}
                        {#if actions.includes('reset-password')}
                          <button type="button" class="small" onclick={() => resetPassword(u)}>Reset password…</button>
                        {:else}
                          <a href="#/account" title="Resetting your own password here would log you out">Change password</a>
                        {/if}
                        {#if actions.includes('toggle-admin')}
                          <button type="button" class="small" onclick={() => toggleAdmin(u)}>{u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
                        {/if}
                        {#if actions.includes('toggle-disabled')}
                          <button type="button" class="small" class:danger={!u.disabled} onclick={() => toggleDisabled(u)}>{u.disabled ? 'Enable' : 'Disable'}</button>
                        {/if}
                      </span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <h2>Create user</h2>
          <p class="sub">Passwords need at least 10 characters. Tell the user through a safe channel.</p>
          <form class="form create" onsubmit={createUser}>
            <label class="field"><span class="label">Username</span>
              <span class="control"><input bind:value={cUsername} autocomplete="off" autocapitalize="none" spellcheck="false" /></span></label>
            <label class="field"><span class="label">Display name</span>
              <span class="control"><input bind:value={cDisplay} autocomplete="off" /></span></label>
            <label class="field"><span class="label">Password</span>
              <span class="control"><input bind:value={cPassword} type="password" autocomplete="new-password" /></span></label>
            <div class="field">
              <span class="label">Role</span>
              <span class="control"><label class="check"><input type="checkbox" bind:checked={cAdmin} /> Administrator</label></span>
            </div>
            <div class="field">
              <span class="label"></span>
              <div class="control">
                {#if cTouched && cProblem}<p class="error">{cProblem}</p>{/if}
                <div class="row"><button type="submit" class="primary">Create user</button></div>
                {#if cError}<p class="error" role="alert">{cError}</p>{/if}
              </div>
            </div>
          </form>
        </section>
      {/if}
    </div>
    {#if version}
      <p class="about">Ligature {version}</p>
    {/if}
  {/if}
</main>

<style>
  main.wide { max-width: 1160px; }
  .about { margin: 28px 0 0; font-size: 12px; color: var(--ink-4); font-variant-numeric: tabular-nums; }

  /* Tabs: the Folio tab strip (uppercase labels, a teal rule on the selected one). */
  .tabs { display: flex; margin: 0 0 4px; border-bottom: 1px solid var(--rule); }
  .tabs a {
    margin-bottom: -1px;
    padding: 10px 16px 9px;
    border: 1px solid transparent;
    border-top-width: 2px;
    font: 600 10.5px/1 var(--font-ui);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    text-decoration: none;
    color: var(--ink-3);
  }
  .tabs a:hover { color: var(--ink); background: var(--sheet-hover); }
  .tabs a[aria-selected='true'] {
    border-color: var(--rule);
    border-top-color: var(--teal);
    border-bottom-color: var(--paper);
    background: var(--paper);
    color: var(--ink);
  }

  .card h2 { margin-bottom: 2px; }
  .sub { margin: 0 0 14px; color: var(--ink-4); font-size: 12.5px; }

  /* Registration */
  .modes { display: flex; flex-direction: column; border: 1px solid var(--rule-soft); }
  .form label.mode {
    flex-direction: row;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    font-weight: 400;
    cursor: pointer;
    border-bottom: 1px solid var(--rule-soft);
  }
  .form label.mode:last-child { border-bottom: 0; }
  .form label.mode:hover { background: var(--sheet-hover); }
  .form label.mode.on { background: var(--teal-tint); }
  .mode input { margin-top: 2px; }
  .mode strong { display: block; font-weight: 600; color: var(--ink); }
  .mode .desc { display: block; margin-top: 2px; color: var(--ink-3); }

  /* Users */
  .table-wrap { overflow-x: auto; }
  .person { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  .status { white-space: nowrap; }
  .tag.admin { border-color: var(--teal-edge); color: var(--teal); }
  .tag.off { border-color: var(--red-rule); color: var(--red); background: var(--red-tint); }
  .when { color: var(--ink-4); white-space: nowrap; }
  .users th:last-child, .end { width: 1%; text-align: right; }
  .btns { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .btns a { padding: 0 8px; font-size: 12px; }
  tr.disabled td { color: var(--ink-4); }
  tr.disabled { background: var(--paper); }

  /* Create user */
  .form.create { gap: 0; border-top: 1px solid var(--rule-soft); }
  .form .field {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr);
    align-items: start;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--rule-soft);
    font-weight: 400;
  }
  .form .field:last-child { border-bottom: 0; padding-bottom: 0; }
  .label { padding-top: 7px; font-weight: 600; color: var(--ink-2); }
  .control { display: flex; flex-direction: column; gap: 8px; max-width: 360px; }
  .control input:not([type='checkbox']) { width: 100%; }
  .control .error { margin: 0; }
  .form label.check { flex-direction: row; align-items: center; gap: 8px; min-height: 30px; font-weight: 400; color: var(--ink); }
  @media (max-width: 560px) {
    .form .field { grid-template-columns: 1fr; gap: 6px; }
    .label { padding-top: 0; }
  }
</style>
