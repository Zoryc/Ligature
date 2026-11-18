<script lang="ts">
  import { api } from '../lib/api.ts'
  import { session } from '../lib/session.svelte.ts'
  import { errorMessage } from '../lib/errors.ts'
  import { toast } from '../lib/toasts.svelte.ts'
  import { displayNameProblem, passwordProblem } from '../lib/validation.ts'
  import NavBar from '../lib/NavBar.svelte'

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
<main class="page">
  <h1>Account</h1>
  {#if session.me}
    <p>Username: <strong>{session.me.username}</strong>{#if session.me.isAdmin} <span class="muted">(server administrator)</span>{/if}</p>

    <section class="card">
      <h2>Display name</h2>
      <form class="form" onsubmit={saveName}>
        <div class="row">
          <input bind:value={displayName} maxlength="64" aria-label="Display name" />
          <button type="submit" class="primary" disabled={nameBusy || displayName.trim() === session.me.displayName}>Save</button>
        </div>
        {#if nameError}<p class="error">{nameError}</p>{/if}
      </form>
    </section>

    <section class="card">
      <h2>Change password</h2>
      <form class="form" onsubmit={changePassword}>
        <label>Current password <input bind:value={current} type="password" autocomplete="current-password" /></label>
        <label>New password <input bind:value={next} type="password" autocomplete="new-password" />
          <span class="hint">At least 10 characters. Your other sessions will be logged out.</span></label>
        <label>Repeat new password <input bind:value={repeat} type="password" autocomplete="new-password" /></label>
        {#if pwTouched && pwProblem}<p class="error">{pwProblem}</p>{/if}
        <div class="row"><button type="submit" class="primary" disabled={pwBusy}>{pwBusy ? 'Saving…' : 'Change password'}</button></div>
        {#if pwError}<p class="error" role="alert">{pwError}</p>{/if}
      </form>
    </section>
  {/if}
</main>
