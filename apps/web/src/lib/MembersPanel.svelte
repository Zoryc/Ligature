<script lang="ts">
  import { onMount } from 'svelte'
  import type { CreatedInvite, Invite, Me, Member, Role } from '@ligature/shared'
  import { api } from './api.ts'
  import { inviteUrl } from './routes.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'
  import { confirmDialog } from './dialogs.svelte.ts'
  import { go } from './router.svelte.ts'

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

{#if error}<p class="error">{error}</p>{/if}

<h3>Members</h3>
{#if !members}
  <p class="muted">Loading…</p>
{:else}
  <ul class="members">
    {#each sorted as m (m.userId)}
      <li>
        <span class="who">{m.displayName} <span class="muted">({m.username}){m.userId === me.id ? ', you' : ''}</span></span>
        {#if isOwner && m.role !== 'owner'}
          <span class="actions">
            <select value={m.role} disabled={busy} onchange={e => setRole(m, e)} aria-label="Role of {m.username}">
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
            </select>
            <button type="button" disabled={busy} onclick={() => transfer(m)}>Make owner</button>
            <button type="button" disabled={busy} onclick={() => removeMember(m)}>Remove</button>
          </span>
        {:else}
          <span class="role">{m.role}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

{#if !isOwner}
  <p class="muted">Only the owner can manage members and invites.</p>
  <button type="button" onclick={leave}>Leave project…</button>
{:else}
  <h3>Invite people</h3>
  <form class="form" onsubmit={createInvite}>
    <div class="row">
      <label>Role
        <select bind:value={invRole}><option value="editor">editor</option><option value="viewer">viewer</option></select>
      </label>
      <label>Expires after
        <select bind:value={invHours}>{#each EXPIRY as x (x.hours)}<option value={x.hours}>{x.label}</option>{/each}</select>
      </label>
      <label>Max uses
        <input bind:value={invMaxUses} placeholder="unlimited" size="8" inputmode="numeric" />
      </label>
    </div>
    {#if maxUsesProblem}<p class="error">{maxUsesProblem}</p>{/if}
    <div class="row"><button type="submit" class="primary" disabled={busy || !!maxUsesProblem}>Create invite link</button></div>
  </form>
  {#if created}
    <div class="created">
      <p>New {created.role} invite. Copy the link now; it is shown only once.</p>
      <div class="row">
        <input readonly value={createdUrl} aria-label="Invite link" onfocus={e => e.currentTarget.select()} />
        <button type="button" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  {/if}

  <h3>Active invites</h3>
  {#if !invites}
    <p class="muted">Loading…</p>
  {:else if invites.length === 0}
    <p class="muted">No active invite links.</p>
  {:else}
    <ul class="invites">
      {#each invites as i (i.id)}
        <li>
          <span>{i.role}, by {i.createdBy}<br /><span class="muted">expires {fmt(i.expiresAt)}; used {i.uses}{i.maxUses !== null ? ` of ${i.maxUses}` : ''}</span></span>
          <button type="button" disabled={busy} onclick={() => revoke(i)}>Revoke</button>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  h3 { font-size: 14px; margin: 14px 0 6px; }
  .members, .invites { list-style: none; margin: 0; padding: 0; }
  .members li, .invites li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    border-bottom: 1px solid #eee;
    flex-wrap: wrap;
  }
  .actions { display: flex; gap: 4px; }
  .actions button, .invites button { padding: 2px 6px; font-size: 12px; }
  .role { font-size: 12px; color: #444; }
  .form label { font-size: 12px; }
  .created { background: #f0f6ff; border: 1px solid #c9dcff; padding: 8px; border-radius: 3px; margin-top: 8px; }
  .created p { margin: 0 0 6px; }
  .created input { flex: 1; min-width: 0; }
</style>
