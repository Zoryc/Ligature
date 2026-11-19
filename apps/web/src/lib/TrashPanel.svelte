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
  <div class="intro">
    <p class="hint">
      Deleted files and folders stay here until they are deleted forever (automatically after a while).
      {#if !canEdit}You can look, but only editors and the owner can restore or delete.{/if}
    </p>
    {#if isOwner && entries && sorted.length > 0 && !loadError}
      <button type="button" class="danger small" disabled={busy !== null} onclick={emptyAll}>Empty trash</button>
    {/if}
  </div>
  {#if loadError}
    <p class="error pad">{loadError}</p>
  {:else if !entries}
    <p class="muted pad">Loading…</p>
  {:else if sorted.length === 0}
    <p class="muted pad empty">The trash is empty.</p>
  {:else}
    <ul class="entries">
      {#each sorted as e (e.id)}
        {@const row = trashRow(e, now)}
        <li class:busy={busy === e.id}>
          <div class="name" title={e.originalPath}>
            {#if e.kind === 'folder'}
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" fill="none" aria-hidden="true"><path d="M3 6h7l2 2h9v11H3z" /></svg>
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" fill="none" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4" /></svg>
            {/if}
            <strong>{row.label}</strong> <span class="muted">in <span class="from">{row.from}</span></span>
          </div>
          <div class="meta muted">Deleted {row.deleted} · {row.size}</div>
          <div class="meta expiry" class:soon={row.expiresSoon} title="Expires {new Date(e.expiresAt).toLocaleString()}">{row.expiry}</div>
          {#if canEdit}
            <div class="buttons">
              <button type="button" class="small primary" disabled={busy !== null} onclick={() => restore(e)}>Restore</button>
              <button type="button" class="small" disabled={busy !== null} onclick={() => restoreTo(e)}>Restore to…</button>
              <span class="spacer"></span>
              <button type="button" class="small quiet del" disabled={busy !== null} onclick={() => purge(e)}>Delete forever</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .trash { font-size: 13px; }
  .intro {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 12px 20px;
    background: var(--paper);
    border-bottom: 1px solid var(--rule);
  }
  .hint { flex: 1; margin: 0; font-size: 12px; color: var(--ink-3); line-height: 1.45; }
  .intro button { flex: none; }
  .pad { margin: 0; padding: 14px 20px; }
  .empty { padding: 28px 20px; text-align: center; }
  .entries { list-style: none; margin: 0; padding: 0; }
  .entries li { padding: 11px 20px 12px; border-bottom: 1px solid var(--rule-soft); }
  .entries li:hover { background: var(--sheet-hover); }
  .entries li.busy { opacity: 0.6; }
  .name {
    display: flex;
    align-items: center;
    gap: 7px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name svg { flex: none; color: var(--ink-4); }
  .name strong { font: 500 12.5px/1.3 var(--font-mono); color: var(--ink); overflow: hidden; text-overflow: ellipsis; }
  .from { font-family: var(--font-mono); font-size: 12px; }
  .meta { font-size: 12px; margin-top: 3px; padding-left: 21px; }
  .expiry { color: var(--ink-3); }
  .soon { color: var(--amber); font-weight: 500; }
  .buttons { display: flex; align-items: center; gap: 6px; margin-top: 9px; padding-left: 21px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .del { color: var(--red); }
  .del:hover:not(:disabled) { background: var(--red-tint); }
</style>
