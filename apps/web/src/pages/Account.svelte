<script lang="ts">
  import { api } from '../lib/api.ts'
  import { session } from '../lib/session.svelte.ts'
  import { errorMessage } from '../lib/errors.ts'
  import { toast } from '../lib/toasts.svelte.ts'
  import { displayNameProblem, passwordProblem } from '../lib/validation.ts'
  import NavBar from '../lib/NavBar.svelte'
  import Avatar from '../lib/Avatar.svelte'
  import DeleteAccountDialog from '../lib/DeleteAccountDialog.svelte'

  let deleting = $state(false)

  let displayName = $state(session.me?.displayName ?? '')
  let nameBusy = $state(false)
  let nameError = $state<string | null>(null)

  let current = $state('')
  let next = $state('')
  let repeat = $state('')
  let pwBusy = $state(false)
  let pwError = $state<string | null>(null)
  let pwTouched = $state(false)
  let pwProblem = $derived(current === '' ? 'Enter your current password.' : passwordProblem(next, repeat))

  async function saveName(e: Event) {
    e.preventDefault()
    nameError = displayNameProblem(displayName)
    if (nameError || nameBusy) return
    nameBusy = true
    try {
      session.me = await api.updateMe(displayName.trim())
      displayName = session.me.displayName
      toast('Display name saved.')
    } catch (err) {
      nameError = errorMessage(err)
    } finally {
      nameBusy = false
    }
  }

  async function changePassword(e: Event) {
    e.preventDefault()
    pwTouched = true
    if (pwProblem || pwBusy) return
    pwBusy = true
    pwError = null
    try {
      await api.changePassword(current, next)
      current = next = repeat = ''
      pwTouched = false
      toast('Password changed. Your other sessions were logged out.')
    } catch (err) {
      pwError = errorMessage(err, { 'invalid-credentials': 'The current password is wrong.' })
    } finally {
      pwBusy = false
    }
  }
</script>

<NavBar current="account" />
<main class="page account">
  <h1>Account</h1>
  {#if session.me}
    <div class="profile">
      <Avatar id={session.me.id} name={session.me.displayName} size={40} />
      <div class="who">
        <span class="name">{session.me.displayName}</span>
        <span class="muted">Username: <strong class="mono">{session.me.username}</strong></span>
      </div>
      {#if session.me.isAdmin}<span class="tag admin">Server administrator</span>{/if}
    </div>

    <section class="card">
      <h2>Display name</h2>
      <p class="sub">The name other project members see.</p>
      <form class="form" onsubmit={saveName}>
        <div class="field">
          <span class="label">Display name</span>
          <div class="control">
            <div class="row">
              <input class="grow" bind:value={displayName} maxlength="64" aria-label="Display name" />
              <button type="submit" class="primary" disabled={nameBusy || displayName.trim() === session.me.displayName}>Save</button>
            </div>
            {#if nameError}<p class="error">{nameError}</p>{/if}
          </div>
        </div>
      </form>
    </section>

    <section class="card">
      <h2>Change password</h2>
      <p class="sub">At least 10 characters. Your other sessions will be logged out.</p>
      <form class="form" onsubmit={changePassword}>
        <label class="field"><span class="label">Current password</span>
          <span class="control"><input bind:value={current} type="password" autocomplete="current-password" /></span></label>
        <label class="field"><span class="label">New password</span>
          <span class="control"><input bind:value={next} type="password" autocomplete="new-password" /></span></label>
        <label class="field"><span class="label">Repeat new password</span>
          <span class="control"><input bind:value={repeat} type="password" autocomplete="new-password" /></span></label>
        <div class="field">
          <span class="label"></span>
          <div class="control">
            {#if pwTouched && pwProblem}<p class="error">{pwProblem}</p>{/if}
            <div class="row"><button type="submit" class="primary" disabled={pwBusy}>{pwBusy ? 'Saving…' : 'Change password'}</button></div>
            {#if pwError}<p class="error" role="alert">{pwError}</p>{/if}
          </div>
        </div>
      </form>
    </section>

    <section class="card danger-zone">
      <h2>Delete account</h2>
      <p class="sub">Deletes your account and the projects only you are a member of, immediately. Projects you share
        with other people stay with them: transfer the ones you own first.</p>
      <div class="row"><button type="button" class="danger" onclick={() => { deleting = true }}>Delete account…</button></div>
    </section>
    {#if deleting}<DeleteAccountDialog onclose={() => { deleting = false }} />{/if}
  {/if}
</main>

<style>
  .account { max-width: 720px; }
  .profile {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 0 0 8px;
    padding: 14px 20px;
    background: var(--sheet);
    border: 1px solid var(--rule);
  }
  .who { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .who .name { font: 600 17px/1.2 var(--font-doc); color: var(--ink); }
  .who strong { color: var(--ink-2); font-weight: 500; }
  .tag.admin { border-color: var(--teal-edge); color: var(--teal); }
  .card h2 { margin-bottom: 2px; }
  .sub { margin: 0 0 14px; color: var(--ink-4); font-size: 12.5px; }
  .card .form { gap: 0; border-top: 1px solid var(--rule-soft); }
  .field {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr);
    align-items: start;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--rule-soft);
  }
  .field:last-child { border-bottom: 0; padding-bottom: 0; }
  .label { padding-top: 7px; font-weight: 600; color: var(--ink-2); }
  .control { display: flex; flex-direction: column; gap: 8px; max-width: 360px; }
  .control input { width: 100%; }
  .control .row input.grow { flex: 1; min-width: 0; width: auto; }
  .control .error { margin: 0; }
  /* Folio danger style: the card's rule turns red, the button is outlined in red. */
  .danger-zone { border-color: var(--red-rule); }
  .danger-zone .row { display: flex; padding-top: 12px; border-top: 1px solid var(--rule-soft); }
  @media (max-width: 560px) {
    .field { grid-template-columns: 1fr; gap: 6px; }
    .label { padding-top: 0; }
  }
</style>
