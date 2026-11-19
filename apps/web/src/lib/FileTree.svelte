<script lang="ts">
  import { tick } from 'svelte'
  import type { TreeEntry } from '@ligature/shared'
  import { api, rawFileUrl, uploadFile } from './api.ts'
  import { treeRows, type TreeRow } from './tree.ts'
  import {
    entryPath, folderLabel, formatBytes, moveTargets, nameProblem, planUploads, targetFolder, type UploadPlanItem,
  } from './treeOps.ts'
  import { ancestorIds, trashButtonLabel } from './trash.ts'
  import { confirmDialog, openDialog, promptDialog } from './dialogs.svelte.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'

  /** Server limit for one upload (docs/M1.md §4). */
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

  interface Props {
    projectId: string
    tree: TreeEntry[]
    rootId: string
    mainFileId: string | null
    canEdit: boolean
    /** The file shown in the editor/preview pane. */
    openId: string | null
    /** Click on a file: text opens in the editor, images preview, other binaries download. */
    onOpen: (entry: TreeEntry) => void
    /** After a change made here (the meta event also triggers a refresh; this one is immediate). */
    onChanged: () => void
    onSetMain: (fileId: string) => void
    /** Number of entries in the trash (null while unknown). */
    trashCount: number | null
    trashOpen: boolean
    onToggleTrash: () => void
    /** An item to show and highlight for a moment (e.g. just restored from the trash). */
    highlightId: string | null
  }

  let {
    projectId, tree, rootId, mainFileId, canEdit, openId, onOpen, onChanged, onSetMain, trashCount, trashOpen, onToggleTrash,
    highlightId,
  }: Props = $props()
  let listEl = $state<HTMLUListElement | undefined>(undefined)

  // Make the highlighted item visible: expand it and its folders, select it and scroll to it.
  $effect(() => {
    const id = highlightId
    if (!id || !tree.some(e => e.id === id)) return
    // Its folders, and the item itself when it is a folder (its contents came back with it).
    const up = [id, ...ancestorIds(tree, id)]
    if (up.some(a => collapsed.has(a))) {
      const next = new Set(collapsed)
      for (const a of up) next.delete(a)
      collapsed = next
    }
    selectedId = id
    void tick().then(() => listEl?.querySelector('.flash')?.scrollIntoView({ block: 'nearest' }))
  })

  let collapsed = $state(new Set<string>())
  let selectedId = $state<string | null>(null)
  /** Folder highlighted while files are dragged over the tree. */
  let dropFolder = $state<string | null>(null)
  let fileInput = $state<HTMLInputElement | undefined>(undefined)

  interface UploadRow { key: number; name: string; loaded: number; total: number; done: boolean; error?: string }
  let uploads = $state<UploadRow[]>([])
  let uploadKey = 0
  let uploading = $state(false)

  let rows = $derived(treeRows(tree, rootId))
  // A selection that no longer exists (deleted, or not refetched yet) simply counts as none.
  let selected = $derived(selectedId ? tree.find(e => e.id === selectedId) ?? null : null)
  /** Where "new file / new folder / upload" go. */
  let currentFolder = $derived(targetFolder(tree, rootId, selected?.id))
  let currentFolderLabel = $derived(folderLabel(entryPath(tree, currentFolder) ?? ''))

  let visible = $derived.by(() => {
    const out: TreeRow[] = []
    let hideBelow: number | null = null
    for (const r of rows) {
      if (hideBelow !== null) {
        if (r.depth > hideBelow) continue
        hideBelow = null
      }
      out.push(r)
      if (r.entry.kind === 'folder' && collapsed.has(r.entry.id)) hideBelow = r.depth
    }
    return out
  })

  function toggle(id: string) {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    collapsed = next
  }

  function clickRow(e: TreeEntry) {
    selectedId = e.id
    if (e.kind === 'folder') toggle(e.id)
    else onOpen(e)
  }

  function expand(folderId: string) {
    if (!collapsed.has(folderId)) return
    const next = new Set(collapsed)
    next.delete(folderId)
    collapsed = next
  }

  // ---------- operations ----------

  async function run<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const r = await fn()
      onChanged()
      return r
    } catch (e) {
      toast(`${what}: ${errorMessage(e)}`, 'error', 6000)
      onChanged()
      return undefined
    }
  }

  async function newEntry(kind: 'text' | 'folder') {
    const parentId = currentFolder
    const name = await promptDialog(kind === 'folder' ? 'New folder' : 'New file', kind === 'folder' ? `Name (in ${currentFolderLabel})` : `Name, e.g. chapter1.tex (in ${currentFolderLabel})`,
      '', { validate: v => nameProblem(tree, parentId, v), confirmLabel: 'Create' })
    if (name === null) return
    const created = await run(`Could not create "${name}"`, () => api.createFile(projectId, { parentId, name, kind }))
    if (!created) return
    expand(parentId)
    selectedId = created.id
    if (created.kind === 'text') onOpen(created)
  }

  async function rename(e: TreeEntry) {
    if (e.parentId === null) return
    const parentId = e.parentId
    const name = await promptDialog(`Rename ${e.kind === 'folder' ? 'folder' : 'file'}`, 'New name', e.name,
      { validate: v => (v === e.name ? null : nameProblem(tree, parentId, v, e.id)), confirmLabel: 'Rename' })
    if (name === null || name === e.name) return
    await run(`Could not rename "${e.name}"`, () => api.updateFile(projectId, e.id, { name }))
  }

  async function move(e: TreeEntry) {
    const options = moveTargets(tree, e.id).map(o => ({
      value: o.id, label: o.reason ? `${o.label}  (${o.reason})` : o.label, disabled: o.disabled,
    }))
    if (!options.some(o => !o.disabled)) {
      toast('There is no other folder to move this to.', 'error')
      return
    }
    const target = await openDialog({
      title: `Move "${e.name}"`, select: { label: 'Into folder', options }, confirmLabel: 'Move',
    })
    if (target === null) return
    const ok = await run(`Could not move "${e.name}"`, () => api.updateFile(projectId, e.id, { parentId: target }))
    if (ok) expand(target)
  }

  async function remove(e: TreeEntry) {
    const path = entryPath(tree, e.id) ?? e.name
    const inside = e.kind === 'folder' ? countInside(e.id) : 0
    const message = e.kind === 'folder'
      ? `Move the folder "${path}"${inside ? ` and the ${inside} item${inside === 1 ? '' : 's'} inside it` : ''} to the trash? `
        + 'Collaborators lose it too. It can be restored from the trash.'
      : `Move "${path}" to the trash? Collaborators lose it too. It can be restored from the trash.`
    if (!(await confirmDialog('Move to trash', message, { confirmLabel: 'Move to trash', danger: true }))) return
    await run(`Could not delete "${e.name}"`, () => api.deleteFile(projectId, e.id))
  }

  function countInside(folderId: string): number {
    let n = 0
    const walk = (id: string, depth: number) => {
      if (depth > 40) return
      for (const c of tree) if (c.parentId === id) { n++; if (c.kind === 'folder') walk(c.id, depth + 1) }
    }
    walk(folderId, 0)
    return n
  }

  function download(e: TreeEntry) {
    const a = document.createElement('a')
    a.href = rawFileUrl(projectId, e.id)
    a.download = e.name
    document.body.append(a)
    a.click()
    a.remove()
  }

  // ---------- uploads ----------

  function pickFiles() {
    fileInput?.click()
  }

  function onPicked(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement
    const files = [...(input.files ?? [])]
    input.value = ''
    void startUploads(currentFolder, files)
  }

  async function startUploads(folderId: string, files: File[]) {
    if (!canEdit || files.length === 0) return
    if (uploading) {
      toast('Wait for the current upload to finish.', 'error')
      return
    }
    const plan = planUploads(tree, folderId, files, MAX_UPLOAD_BYTES)
    const skipped = plan.filter((p): p is Extract<UploadPlanItem, { action: 'skip' }> => p.action === 'skip')
    if (skipped.length) toast(`Not uploaded: ${skipped.map(s => `${s.name} (${s.reason})`).join(', ')}`, 'error', 8000)
    const replacing = plan.filter(p => p.action === 'replace')
    let allowReplace = false
    if (replacing.length) {
      allowReplace = await confirmDialog('Replace existing files?',
        `These files already exist in ${folderLabel(entryPath(tree, folderId) ?? '')}:\n${replacing.map(p => p.name).join('\n')}\n\n`
        + 'Replace them? Text files are updated in place, so collaborators keep editing the new content.',
        { confirmLabel: 'Replace' })
    }
    const todo = files.filter((_, i) => {
      const p = plan[i]!
      return p.action === 'create' || (p.action === 'replace' && allowReplace)
    })
    if (todo.length === 0) return
    expand(folderId)
    uploading = true
    const batch: UploadRow[] = todo.map(f => ({ key: ++uploadKey, name: f.name, loaded: 0, total: f.size, done: false }))
    uploads = [...uploads.filter(u => !u.done || u.error), ...batch]
    try {
      for (const [i, f] of todo.entries()) {
        const key = batch[i]!.key
        const patch = (p: Partial<UploadRow>) => { uploads = uploads.map(u => (u.key === key ? { ...u, ...p } : u)) }
        try {
          await uploadFile(projectId, folderId, f, f.name, (loaded, total) => patch({ loaded, total })).promise
          patch({ done: true, loaded: f.size })
        } catch (e) {
          patch({ done: true, error: errorMessage(e) })
          toast(`Upload of "${f.name}" failed: ${errorMessage(e)}`, 'error', 6000)
        }
      }
    } finally {
      uploading = false
      onChanged()
      // Successful rows disappear after a moment; failed ones stay until the next upload.
      setTimeout(() => { uploads = uploads.filter(u => !u.done || u.error) }, 2500)
    }
  }

  // ---------- drag and drop (files from the OS) ----------

  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
  }

  function dragOver(e: DragEvent, entryId: string | null) {
    if (!canEdit || !hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    dropFolder = targetFolder(tree, rootId, entryId)
  }

  function dragLeave(e: DragEvent) {
    const to = e.relatedTarget as Node | null
    if (!to || !(e.currentTarget as Node).contains(to)) dropFolder = null
  }

  function drop(e: DragEvent, entryId: string | null) {
    if (!canEdit || !hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    const folder = targetFolder(tree, rootId, entryId)
    dropFolder = null
    void startUploads(folder, [...(e.dataTransfer?.files ?? [])])
  }

  /** Is this row the drop target (the folder itself, or a file directly in it)? */
  function inDropFolder(r: TreeRow): boolean {
    return dropFolder !== null && (r.entry.id === dropFolder || (r.entry.kind !== 'folder' && r.entry.parentId === dropFolder))
  }
</script>

<div class="tree-pane" role="tree" tabindex="-1"
  class:drop-root={dropFolder === rootId}
  ondragover={e => dragOver(e, null)} ondragleave={dragLeave} ondrop={e => drop(e, null)}>
  {#if canEdit}
    <div class="toolbar">
      <button type="button" class="quiet small" title="New file in {currentFolderLabel}" onclick={() => newEntry('text')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" aria-hidden="true"><path d="M13 3H6v18h12V8z" /><path d="M13 3v5h5M12 11v6M9 14h6" /></svg>
        File
      </button>
      <button type="button" class="quiet small" title="New folder in {currentFolderLabel}" onclick={() => newEntry('folder')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" aria-hidden="true"><path d="M3 6h7l2 2h9v12H3z" /><path d="M12 11v6M9 14h6" /></svg>
        Folder
      </button>
      <button type="button" class="quiet small" title="Upload into {currentFolderLabel} (or drop files onto a folder)" onclick={pickFiles}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
        Upload
      </button>
      <input bind:this={fileInput} type="file" multiple hidden onchange={onPicked} />
    </div>
  {/if}
  {#if selected && selected.parentId !== null}
    <div class="toolbar selection">
      <span class="sel-name" title={entryPath(tree, selected.id) ?? ''}>{selected.name}</span>
      {#if selected.kind !== 'folder'}<button type="button" class="small" onclick={() => download(selected!)}>Download</button>{/if}
      {#if canEdit}
        {#if selected.kind === 'text' && selected.name.toLowerCase().endsWith('.tex') && selected.id !== mainFileId}
          <button type="button" class="small" onclick={() => onSetMain(selected!.id)}>Set as main</button>
        {/if}
        <button type="button" class="small" onclick={() => rename(selected!)}>Rename</button>
        <button type="button" class="small" onclick={() => move(selected!)}>Move</button>
        <button type="button" class="small danger" title="Move to trash" onclick={() => remove(selected!)}>Delete</button>
      {/if}
    </div>
  {/if}
  {#if canEdit}<div class="target">New files go to <strong>{currentFolderLabel}</strong></div>{/if}

  <ul class="tree" bind:this={listEl}>
    {#each visible as r (r.entry.id)}
      <li class:drop={inDropFolder(r)}
        ondragover={e => dragOver(e, r.entry.id)} ondrop={e => drop(e, r.entry.id)}>
        <button type="button" class="row {r.entry.kind}" class:selected={r.entry.id === selectedId} class:open={r.entry.id === openId}
          class:flash={r.entry.id === highlightId} style="padding-left: {10 + r.depth * 16}px"
          title={r.entry.kind === 'binary' ? `${r.path} (${formatBytes(r.entry.size ?? 0)})` : r.path}
          onclick={() => clickRow(r.entry)}>
          {#if r.entry.kind === 'folder'}
            <span class="twisty" aria-hidden="true">{collapsed.has(r.entry.id) ? '▸' : '▾'}</span>
            <svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><path d="M3 6h7l2 2h9v12H3z" /></svg>
            <span class="name">{r.entry.name}</span>
          {:else}
            <span class="twisty" aria-hidden="true"></span>
            {#if r.entry.kind === 'binary'}
              <svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><rect x="4" y="4" width="16" height="16" /><path d="M4 16l5-5 4 4 3-3 4 4" /></svg>
            {:else}
              <svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true"><path d="M13 3H6v18h12V8z" /><path d="M13 3v5h5M9 13h6M9 17h6" /></svg>
            {/if}
            <span class="name">{r.entry.name}</span>
            {#if r.entry.id === mainFileId}<span class="main" title="Main file: the compiler starts here">Main</span>{/if}
          {/if}
        </button>
      </li>
    {:else}
      <li class="empty">No files.{#if canEdit} Create one, or drop files here.{/if}</li>
    {/each}
  </ul>

  {#if uploads.length}
    <ul class="uploads">
      {#each uploads as u (u.key)}
        <li class:failed={!!u.error}>
          <span class="name">{u.name}</span>
          {#if u.error}<span class="error">failed</span>
          {:else if u.done}<span class="ok">done</span>
          {:else}<progress max={u.total || 1} value={u.loaded}></progress>{/if}
        </li>
      {/each}
    </ul>
  {/if}

  <div class="trash-bar">
    <button type="button" class="trash-btn" class:active={trashOpen} aria-pressed={trashOpen} onclick={onToggleTrash}
      title="Deleted files and folders, which can be restored">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" /></svg>
      {trashButtonLabel(trashCount ?? 0)}
    </button>
  </div>
</div>

<style>
  .tree-pane {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    outline: none;
  }
  .tree-pane.drop-root { background: var(--teal-tint); }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 6px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .toolbar.selection {
    gap: 4px;
    padding: 8px 10px;
    background: var(--paper-2);
    border-bottom: 1px solid var(--rule);
    align-items: center;
  }
  .sel-name {
    width: 100%;
    font: 500 12px/1.3 var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-bottom: 2px;
  }
  .target { font-size: 11.5px; padding: 6px 12px 2px; color: var(--ink-4); }
  .target strong { font-weight: 500; color: var(--ink-3); font-family: var(--font-mono); }
  .tree {
    list-style: none;
    margin: 0;
    padding: 4px 0 8px;
    flex: 1;
  }
  li.drop { background: var(--teal-tint); }
  .row {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 28px;
    text-align: left;
    border: 0;
    border-left: 2px solid transparent;
    background: none;
    padding: 0 10px;
    font: 400 13px/1.2 var(--font-ui);
    color: var(--ink);
    cursor: pointer;
  }
  .row:hover:not(:disabled) { background: var(--paper-2); }
  .twisty { flex: 0 0 10px; color: var(--ink-4); font-size: 10px; text-align: center; }
  .icon { color: var(--ink-3); }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folder .name { font-weight: 500; }
  .binary .name { color: var(--ink-2); }
  .selected { box-shadow: inset 0 0 0 1px var(--rule-strong); }
  .open { background: var(--teal-tint); border-left-color: var(--teal); }
  .open:hover:not(:disabled) { background: var(--teal-tint); }
  .open .icon { color: var(--teal); }
  .main {
    margin-left: auto;
    padding: 2px 5px;
    border: 1px solid var(--rule-strong);
    color: var(--ink-3);
    font: 600 9.5px/1 var(--font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .empty { padding: 10px 14px; color: var(--ink-4); }
  .uploads {
    list-style: none;
    margin: 0;
    padding: 8px 10px;
    border-top: 1px solid var(--rule-soft);
    font-size: 12px;
  }
  .uploads li { display: flex; gap: 6px; align-items: center; min-height: 22px; }
  .uploads .name { flex: 1; }
  .uploads progress { width: 80px; }
  .flash { animation: tree-flash 3s ease-out; }
  @keyframes tree-flash {
    0%, 40% { background: #F3E3A6; }
    100% { background: transparent; }
  }
  .trash-bar {
    position: sticky;
    bottom: 0;
    border-top: 1px solid var(--rule);
    background: var(--paper);
  }
  .trash-btn {
    width: 100%;
    justify-content: flex-start;
    min-height: 34px;
    padding: 0 12px;
    border: 0;
    background: transparent;
    font-weight: 400;
    color: var(--ink-3);
  }
  .trash-btn.active { background: var(--paper-2); color: var(--ink); }
</style>
