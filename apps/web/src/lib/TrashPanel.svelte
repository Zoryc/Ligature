<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { TrashEntry, TreeEntry } from '@ligature/shared'
  import { api } from './api.ts'
  import { entryPath, folderLabel } from './treeOps.ts'
  import { restoredText, restoreTargets, sortTrash, trashRow } from './trash.ts'
  import { confirmDialog, openDialog } from './dialogs.svelte.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'

  interface Props {
    projectId: string
    /** null while loading */
    entries: TrashEntry[] | null
    loadError: string | null
    tree: TreeEntry[]
    canEdit: boolean
    isOwner: boolean
    /** After a restore: the restored item (to highlight it in the tree). */
    onRestored: (entry: TreeEntry) => void
    /** After any change made here (the trash-changed event also triggers a refresh; this one is immediate). */
    onChanged: () => void
  }

  let { projectId, entries, loadError, tree, canEdit, isOwner, onRestored, onChanged }: Props = $props()

  let now = $state(Date.now())
  const clock = setInterval(() => { now = Date.now() }, 30_000)
  onDestroy(() => clearInterval(clock))

  let busy = $state<string | null>(null)
  let sorted = $derived(entries ? sortTrash(entries) : [])

  async function act(id: string, fn: () => Promise<void>) {
    if (busy) return
    busy = id
    try {
      await fn()
    } finally {
      busy = null
      onChanged()
    }
  }

  function restore(e: TrashEntry, parentId?: string) {
    return act(e.id, async () => {
      try {
        const r = await api.restore(projectId, e.id, parentId ? { parentId } : {})
        // The tree we have is from before the restore; the parent folder is live, so its path is known.
        const where = r.parentId ? folderLabel(entryPath(tree, r.parentId) ?? '') : '/'
        toast(restoredText(e.name, r, where))
        onRestored(r)
      } catch (err) {
        toast(`Could not restore "${e.name}": ${errorMessage(err)}`, 'error', 6000)
      }
    })
  }

  async function restoreTo(e: TrashEntry) {
    const options = restoreTargets(tree).map(t => ({ value: t.id, label: t.label }))
    const target = await openDialog({
      title: `Restore "${e.name}" to…`,
      message: 'If the name is already taken there, " (restored)" is added to it.',
      select: { label: 'Folder', options },
      confirmLabel: 'Restore',
    })
    if (target !== null) await restore(e, target)
  }

  async function purge(e: TrashEntry) {
    const what = e.kind !== 'folder' ? `"${e.originalPath}"`
      : e.fileCount === 0 ? `the empty folder "${e.originalPath}"`
        : `the folder "${e.originalPath}" and the ${e.fileCount} file${e.fileCount === 1 ? '' : 's'} in it`
    const ok = await confirmDialog('Delete forever', `Delete ${what} forever? This cannot be undone.`,
      { confirmLabel: 'Delete forever', danger: true })
    if (!ok) return
    await act(e.id, async () => {
      try {
        await api.purge(projectId, e.id)
        toast(`Deleted "${e.name}" forever.`)
      } catch (err) {
        toast(`Could not delete "${e.name}": ${errorMessage(err)}`, 'error', 6000)
      }
    })
  }

  async function emptyAll() {
    const n = sorted.length
    const ok = await confirmDialog('Empty trash', `Delete ${n === 1 ? 'the item' : `all ${n} items`} in the trash forever? This cannot be undone.`,
      { confirmLabel: 'Empty trash', danger: true })
    if (!ok) return
    await act('*', async () => {
      try {
        await api.emptyTrash(projectId)
        toast('The trash was emptied.')
      } catch (err) {
        toast(`Could not empty the trash: ${errorMessage(err)}`, 'error', 6000)
      }
    })
  }
</script>

<div class="trash">
  <p class="muted hint">
    Deleted files and folders stay here until they are deleted forever (automatically after a while).
    {#if !canEdit}You can look, but only editors and the owner can restore or delete.{/if}
  </p>
  {#if loadError}
    <p class="error">{loadError}</p>
  {:else if !entries}
    <p class="muted">Loading…</p>
  {:else if sorted.length === 0}
    <p class="muted">The trash is empty.</p>
  {:else}
    {#if isOwner}
      <div class="top"><button type="button" class="danger" disabled={busy !== null} onclick={emptyAll}>Empty trash</button></div>
    {/if}
    <ul class="entries">
      {#each sorted as e (e.id)}
        {@const row = trashRow(e, now)}
        <li class:busy={busy === e.id}>
          <div class="name" title={e.originalPath}><strong>{row.label}</strong> <span class="muted">in {row.from}</span></div>
          <div class="meta muted">Deleted {row.deleted} · {row.size}</div>
          <div class="meta" class:soon={row.expiresSoon} title="Expires {new Date(e.expiresAt).toLocaleString()}">{row.expiry}</div>
          {#if canEdit}
            <div class="buttons">
              <button type="button" class="primary" disabled={busy !== null} onclick={() => restore(e)}>Restore</button>
              <button type="button" disabled={busy !== null} onclick={() => restoreTo(e)}>Restore to…</button>
              <button type="button" class="del" disabled={busy !== null} onclick={() => purge(e)}>Delete forever</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .hint { font-size: 12px; margin-top: 0; }
  .top { display: flex; justify-content: flex-end; margin-bottom: 8px; }
  .entries { list-style: none; margin: 0; padding: 0; }
  .entries li {
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 8px;
  }
  .entries li.busy { opacity: 0.6; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: 12px; margin-top: 2px; }
  .soon { color: #a15c00; }
  .buttons { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .buttons button { font-size: 12px; padding: 2px 8px; }
  .del { color: #b00020; }
</style>
