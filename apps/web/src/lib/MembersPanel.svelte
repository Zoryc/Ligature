<script lang="ts">
  import { onMount } from 'svelte'
  import type { CreatedInvite, Invite, Me, Member, Role } from '@ligature/shared'
  import { api } from './api.ts'
  import { inviteUrl } from './routes.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'
  import { confirmDialog } from './dialogs.svelte.ts'
  import { go } from './router.svelte.ts'
  import Avatar from './Avatar.svelte'

  interface Props { projectId: string; projectName: string; me: Me; role: Role }
  let { projectId, projectName, me, role }: Props = $props()

  const EXPIRY = [
    { hours: 24, label: '1 day' },
    { hours: 168, label: '7 days' },
    { hours: 720, label: '30 days' },
  ]
  const RANK: Record<Role, number> = { owner: 0, editor: 1, viewer: 2 }

  let members = $state<Member[] | null>(null)
  let invites = $state<Invite[] | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)

  let invRole = $state<'editor' | 'viewer'>('editor')
  let invHours = $state(168)
  let invMaxUses = $state('')
  let created = $state<CreatedInvite | null>(null)
  let copied = $state(false)

  let isOwner = $derived(role === 'owner')
  let sorted = $derived((members ?? []).slice().sort((a, b) => RANK[a.role] - RANK[b.role] || a.displayName.localeCompare(b.displayName)))
  let maxUsesProblem = $derived(invMaxUses.trim() === '' ? null
    : /^[0-9]+$/.test(invMaxUses.trim()) && Number(invMaxUses) >= 1 && Number(invMaxUses) <= 1000 ? null : 'Enter 1–1000, or leave empty for unlimited.')

  /** Reload the lists (called by the project page on members-changed). */
  export async function reload(): Promise<void> {
    try {
      const [m, i] = await Promise.all([api.members(projectId), isOwner ? api.invites(projectId) : Promise.resolve(null)])
      members = m
      invites = i
      error = null
    } catch (e) {
      error = errorMessage(e)
    }
  }

  onMount(reload)

  // The role can change while the panel is open (transfer): reload the owner-only parts.
  let lastRole: Role | null = null
  $effect(() => {
    if (lastRole !== null && lastRole !== role) void reload()
    lastRole = role
  })

  async function act(what: string, fn: () => Promise<unknown>, done?: string) {
    busy = true
    try {
      await fn()
      if (done) toast(done)
    } catch (e) {
      toast(`${what}: ${errorMessage(e)}`, 'error')
    } finally {
      busy = false
      await reload()
    }
  }

  function setRole(m: Member, e: Event) {
    const r = (e.currentTarget as HTMLSelectElement).value as 'editor' | 'viewer'
    if (r !== m.role) void act('Could not change the role', () => api.setMemberRole(projectId, m.userId, r), `${m.displayName} is now ${r}.`)
  }

  async function removeMember(m: Member) {
    if (!(await confirmDialog('Remove member', `Remove ${m.displayName} (${m.username}) from "${projectName}"? They lose access immediately.`,
      { confirmLabel: 'Remove', danger: true }))) return
    await act('Could not remove', () => api.removeMember(projectId, m.userId), `${m.displayName} was removed.`)
  }

  async function transfer(m: Member) {
    if (!(await confirmDialog('Transfer ownership',
      `Make ${m.displayName} (${m.username}) the owner of "${projectName}"? You become an editor and can no longer manage members.`,
      { confirmLabel: 'Transfer ownership', danger: true }))) return
    await act('Could not transfer ownership', () => api.transfer(projectId, m.userId), `${m.displayName} is now the owner.`)
  }

  async function leave() {
    if (!(await confirmDialog('Leave project', `Leave "${projectName}"? You will need a new invite to come back.`,
      { confirmLabel: 'Leave', danger: true }))) return
    try {
      await api.removeMember(projectId, me.id)
      toast(`You left "${projectName}".`)
      go('/projects')
    } catch (e) {
      toast(`Could not leave: ${errorMessage(e)}`, 'error')
    }
  }

  async function createInvite(e: Event) {
    e.preventDefault()
    if (maxUsesProblem) return
    busy = true
    try {
      const max = invMaxUses.trim() === '' ? null : Number(invMaxUses)
      created = await api.createInvite(projectId, { role: invRole, expiresInHours: invHours, maxUses: max })
      copied = false
    } catch (err) {
      toast(`Could not create the invite: ${errorMessage(err)}`, 'error')
    } finally {
      busy = false
      await reload()
    }
  }

  let createdUrl = $derived(created ? inviteUrl(location.origin, created.token) : '')

  async function copy(ev: Event) {
    const field = (ev.currentTarget as HTMLElement).parentElement?.querySelector('input')
    try {
      await navigator.clipboard.writeText(createdUrl)
      copied = true
    } catch {
      // Clipboard API unavailable (e.g. not a secure context): select the text for Ctrl+C.
      field?.select()
      toast('Press Ctrl+C to copy the selected link.')
    }
  }

  async function revoke(i: Invite) {
    if (!(await confirmDialog('Revoke invite', 'Revoke this invite link? Nobody can use it any more.', { confirmLabel: 'Revoke', danger: true }))) return
    if (created?.id === i.id) created = null
    await act('Could not revoke', () => api.revokeInvite(projectId, i.id), 'Invite revoked.')
  }

  const fmt = (ts: number) => new Date(ts).toLocaleString()
</script>

<div class="members-panel">
  {#if error}<p class="error banner">{error}</p>{/if}

  <section>
    <header class="sec-head">
      <h3>Members</h3>
      {#if members}<span class="count">{members.length}</span>{/if}
    </header>
    {#if !members}
      <p class="muted pad">Loading…</p>
    {:else}
      <ul class="members">
        {#each sorted as m (m.userId)}
          <li>
            <Avatar id={m.userId} name={m.displayName} size={26} />
            <span class="who">
              <span class="name">{m.displayName}</span>
              <span class="muted">{m.username}{m.userId === me.id ? ' · you' : ''}</span>
            </span>
            {#if isOwner && m.role !== 'owner'}
              <select class="role-select" value={m.role} disabled={busy} onchange={e => setRole(m, e)} aria-label="Role of {m.username}">
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <span class="row-actions">
                <button type="button" class="small quiet" disabled={busy} onclick={() => transfer(m)}>Make owner</button>
                <button type="button" class="small quiet del" disabled={busy} onclick={() => removeMember(m)}>Remove</button>
              </span>
            {:else}
              <span class="tag" class:owner={m.role === 'owner'}>{m.role}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if !isOwner}
    <section class="foot">
      <p class="muted">Only the owner can manage members and invites.</p>
      <button type="button" class="danger" onclick={leave}>Leave project…</button>
    </section>
  {:else}
    <section class="alt">
      <header class="sec-head">
        <h3>Invite people</h3>
      </header>
      <p class="sec-sub">Anyone with the link can join this project with the chosen role.</p>
      <form class="invite-form" onsubmit={createInvite}>
        <label class="field"><span class="label">Role</span>
          <select bind:value={invRole}><option value="editor">editor</option><option value="viewer">viewer</option></select>
        </label>
        <label class="field"><span class="label">Expires after</span>
          <select bind:value={invHours}>{#each EXPIRY as x (x.hours)}<option value={x.hours}>{x.label}</option>{/each}</select>
        </label>
        <label class="field"><span class="label">Max uses</span>
          <input bind:value={invMaxUses} placeholder="unlimited" size="8" inputmode="numeric" />
        </label>
        {#if maxUsesProblem}<p class="error pad">{maxUsesProblem}</p>{/if}
        <div class="submit-row"><button type="submit" class="primary" disabled={busy || !!maxUsesProblem}>Create invite link</button></div>
      </form>
      {#if created}
        <div class="created">
          <p>New {created.role} invite. Copy the link now; it is shown only once.</p>
          <div class="link-row">
            <input readonly value={createdUrl} aria-label="Invite link" onfocus={e => e.currentTarget.select()} />
            <button type="button" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
      {/if}
    </section>

    <section>
      <header class="sec-head">
        <h3>Active invites</h3>
        {#if invites && invites.length > 0}<span class="count">{invites.length}</span>{/if}
      </header>
      {#if !invites}
        <p class="muted pad">Loading…</p>
      {:else if invites.length === 0}
        <p class="muted pad">No active invite links.</p>
      {:else}
        <ul class="invites">
          {#each invites as i (i.id)}
            <li>
              <span class="tag">{i.role}</span>
              <span class="inv">
                <span>by {i.createdBy}</span>
                <span class="muted">expires {fmt(i.expiresAt)}; used {i.uses}{i.maxUses !== null ? ` of ${i.maxUses}` : ''}</span>
              </span>
              <button type="button" class="small" disabled={busy} onclick={() => revoke(i)}>Revoke</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .members-panel { font-size: 13px; }
  section { border-bottom: 1px solid var(--rule); }
  section:last-child { border-bottom: 0; }
  section.alt, section.foot { background: var(--paper); }
  .sec-head { display: flex; align-items: baseline; gap: 10px; padding: 16px 20px 8px; }
  h3 { margin: 0; font: 600 17px/1.25 var(--font-doc); color: var(--ink); }
  .count { font-size: 12px; color: var(--ink-4); font-variant-numeric: tabular-nums; }
  .sec-sub { margin: -4px 20px 10px; color: var(--ink-3); font-size: 12.5px; }
  .pad { margin: 0; padding: 4px 20px 16px; }
  .banner { margin: 0; padding: 10px 20px; background: var(--red-tint); border-bottom: 1px solid var(--red-rule); }

  ul { list-style: none; margin: 0; padding: 0; }

  .members li {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 10px;
    padding: 9px 20px;
    border-top: 1px solid var(--rule-soft);
  }
  .who { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .who .name { font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who .muted { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag.owner { border-color: var(--teal-edge); color: var(--teal); }
  .role-select { min-height: 26px; padding-top: 2px; padding-bottom: 2px; font-size: 12.5px; }
  .row-actions { grid-column: 2 / 4; display: flex; gap: 2px; margin: 4px 0 0 -8px; }
  .row-actions button { color: var(--ink-3); }
  .row-actions button:hover:not(:disabled) { color: var(--ink); }
  .row-actions button.del:hover:not(:disabled) { color: var(--red); background: var(--red-tint); }

  .invite-form { display: flex; flex-direction: column; border-top: 1px solid var(--rule-soft); }
  .field {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    padding: 8px 20px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .label { font-weight: 600; color: var(--ink-2); }
  .field select, .field input { justify-self: start; min-width: 140px; }
  .invite-form .error { padding: 8px 20px 0; }
  .submit-row { padding: 12px 20px 16px; padding-left: 152px; }

  .created { margin: 0 20px 16px; padding: 10px 12px; background: var(--teal-tint); border-left: 2px solid var(--teal); }
  .created p { margin: 0 0 8px; color: var(--ink-2); }
  .link-row { display: flex; gap: 6px; }
  .link-row input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 12px; }

  .invites li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 10px;
    padding: 9px 20px;
    border-top: 1px solid var(--rule-soft);
  }
  .inv { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .inv .muted { font-size: 12px; }

  .foot { padding: 16px 20px; }
  .foot p { margin: 0 0 10px; }
</style>
