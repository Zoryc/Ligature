<script lang="ts">
  import type { TreeEntry } from '@ligature/shared'
  import { api, rawFileUrl, uploadFile } from './api.ts'
  import { treeRows, type TreeRow } from './tree.ts'
  import {
    entryPath, folderLabel, formatBytes, moveTargets, nameProblem, planUploads, targetFolder, type UploadPlanItem,
  } from './treeOps.ts'
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
  }

  let { projectId, tree, rootId, mainFileId, canEdit, openId, onOpen, onChanged, onSetMain }: Props = $props()

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
      ? `Delete the folder "${path}"${inside ? ` and the ${inside} item${inside === 1 ? '' : 's'} inside it` : ''}? Collaborators lose it too.`
      : `Delete "${path}"? Collaborators lose it too.`
    if (!(await confirmDialog('Delete', message, { confirmLabel: 'Delete', danger: true }))) return
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
  <div class="toolbar">
    {#if canEdit}
      <button type="button" title="New file in {currentFolderLabel}" onclick={() => newEntry('text')}>+ File</button>
      <button type="button" title="New folder in {currentFolderLabel}" onclick={() => newEntry('folder')}>+ Folder</button>
      <button type="button" title="Upload into {currentFolderLabel} (or drop files onto a folder)" onclick={pickFiles}>Upload</button>
      <input bind:this={fileInput} type="file" multiple hidden onchange={onPicked} />
    {/if}
  </div>
  {#if selected && selected.parentId !== null}
    <div class="toolbar selection">
      <span class="sel-name" title={entryPath(tree, selected.id) ?? ''}>{selected.name}</span>
      {#if selected.kind !== 'folder'}<button type="button" onclick={() => download(selected!)}>Download</button>{/if}
      {#if canEdit}
        {#if selected.kind === 'text' && selected.name.toLowerCase().endsWith('.tex') && selected.id !== mainFileId}
          <button type="button" onclick={() => onSetMain(selected!.id)}>Set as main</button>
        {/if}
        <button type="button" onclick={() => rename(selected!)}>Rename</button>
        <button type="button" onclick={() => move(selected!)}>Move</button>
        <button type="button" class="del" onclick={() => remove(selected!)}>Delete</button>
      {/if}
    </div>
  {/if}
  {#if canEdit}<div class="target muted">New files go to <strong>{currentFolderLabel}</strong></div>{/if}

  <ul class="tree">
    {#each visible as r (r.entry.id)}
      <li style="padding-left: {4 + r.depth * 14}px" class:drop={inDropFolder(r)}
        ondragover={e => dragOver(e, r.entry.id)} ondrop={e => drop(e, r.entry.id)}>
        <button type="button" class="row {r.entry.kind}" class:selected={r.entry.id === selectedId} class:open={r.entry.id === openId}
          title={r.entry.kind === 'binary' ? `${r.path} (${formatBytes(r.entry.size ?? 0)})` : r.path}
          onclick={() => clickRow(r.entry)}>
          {#if r.entry.kind === 'folder'}
            {collapsed.has(r.entry.id) ? '▸' : '▾'} {r.entry.name}/
          {:else}
            {r.entry.name}{#if r.entry.id === mainFileId}<span class="main" title="Main file"> (main)</span>{/if}
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
</div>

<style>
  .tree-pane {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    outline: none;
  }
  .tree-pane.drop-root { background: #eef4ff; }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px;
    border-bottom: 1px solid #eee;
  }
  .toolbar button { padding: 2px 6px; font-size: 12px; }
  .toolbar.selection { background: #f7f7fb; align-items: center; }
  .sel-name {
    width: 100%;
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .del { color: #b00020; }
  .target { font-size: 11px; padding: 2px 8px; }
  .tree {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    font-size: 13px;
    flex: 1;
  }
  li.drop { background: #dbe7ff; }
  .row {
    display: block;
    width: 100%;
    text-align: left;
    border: 0;
    background: none;
    padding: 3px 6px;
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row:hover { background: #eef; }
  .folder { font-weight: 600; }
  .binary { color: #555; font-style: italic; }
  .selected { outline: 1px dotted #2a5bd7; outline-offset: -1px; }
  .open { background: #dde4ff; }
  .main { color: #888; font-size: 11px; font-style: normal; }
  .empty { padding: 8px; color: #666; }
  .uploads {
    list-style: none;
    margin: 0;
    padding: 6px;
    border-top: 1px solid #eee;
    font-size: 12px;
  }
  .uploads li { display: flex; gap: 6px; align-items: center; }
  .uploads .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .uploads progress { width: 80px; }
</style>
