<script lang="ts">
  import { onMount } from 'svelte'
  import type { ProjectSummary } from '@ligature/shared'
  import { api, importZip, type UploadHandle } from '../lib/api.ts'
  import type { ImportResponse } from '@ligature/shared'
  import { defaultProjectName, MAX_IMPORT_BYTES, rememberImportReport } from '../lib/zipImport.ts'
  import { session } from '../lib/session.svelte.ts'
  import { go } from '../lib/router.svelte.ts'
  import { errorMessage } from '../lib/errors.ts'
  import { toast } from '../lib/toasts.svelte.ts'
  import { confirmDialog } from '../lib/dialogs.svelte.ts'
  import NavBar from '../lib/NavBar.svelte'

  let projects = $state<ProjectSummary[] | null>(null)
  let error = $state<string | null>(null)
  let newName = $state('')
  let creating = $state(false)

  // Import .zip
  let zipInput = $state<HTMLInputElement | undefined>(undefined)
  let zipFile = $state<File | null>(null)
  let importName = $state('')
  let importProgress = $state<{ loaded: number; total: number } | null>(null)
  let importHandle = $state.raw<UploadHandle<ImportResponse> | null>(null)
  let importError = $state<string | null>(null)

  async function load() {
    try {
      projects = await api.projects()
      error = null
    } catch (e) {
      error = `Could not load projects: ${errorMessage(e)}`
    }
  }

  onMount(load)

  async function create(e: Event) {
    e.preventDefault()
    const name = newName.trim()
    if (!name || creating) return
    creating = true
    try {
      const p = await api.createProject(name)
      newName = ''
      go(`/project/${encodeURIComponent(p.id)}`)
    } catch (err) {
      toast(`Could not create the project: ${errorMessage(err)}`, 'error')
    } finally {
      creating = false
    }
  }

  function pickZip(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null
    importError = null
    zipFile = f
    if (f) importName = defaultProjectName(f.name)
  }

  function resetImport() {
    zipFile = null
    importName = ''
    importProgress = null
    importHandle = null
    if (zipInput) zipInput.value = ''
  }

  async function startImport(e: Event) {
    e.preventDefault()
    const f = zipFile
    const name = importName.trim()
    if (!f || !name || importHandle) return
    if (f.size > MAX_IMPORT_BYTES) {
      importError = `The archive is larger than ${MAX_IMPORT_BYTES / 1048576} MB.`
      return
    }
    importError = null
    importProgress = { loaded: 0, total: f.size }
    const h = importZip(name, f, (loaded, total) => { importProgress = { loaded, total } })
    importHandle = h
    try {
      const r = await h.promise
      rememberImportReport(r.project.id, r.report)
      resetImport()
      go(`/project/${encodeURIComponent(r.project.id)}`)
    } catch (err) {
      importError = `Could not import "${f.name}": ${errorMessage(err)}`
      importProgress = null
      importHandle = null
    }
  }

  function cancelImport() {
    importHandle?.abort()
  }

  async function remove(p: ProjectSummary) {
    const ok = await confirmDialog('Delete project',
      `This deletes "${p.name}" for every member. Its files and history are no longer accessible.`,
      { requireText: p.name, confirmLabel: 'Delete project', danger: true })
    if (!ok) return
    try {
      await api.deleteProject(p.id)
      toast(`Deleted "${p.name}".`)
    } catch (err) {
      toast(`Could not delete: ${errorMessage(err)}`, 'error')
    }
    await load()
  }

  async function leave(p: ProjectSummary) {
    const me = session.me
    if (!me) return
    const ok = await confirmDialog('Leave project', `Leave "${p.name}"? You will need a new invite to come back.`,
      { confirmLabel: 'Leave', danger: true })
    if (!ok) return
    try {
      await api.removeMember(p.id, me.id)
      toast(`You left "${p.name}".`)
    } catch (err) {
      toast(`Could not leave: ${errorMessage(err)}`, 'error')
    }
    await load()
  }

  function when(ts: number): string {
    return ts ? new Date(ts).toLocaleString() : '–'
  }
</script>

<NavBar current="projects" />
<main class="page">
  <h1>Projects</h1>

  <form class="form" onsubmit={create}>
    <div class="row">
      <input bind:value={newName} placeholder="New project name" maxlength="120" aria-label="New project name" />
      <button type="submit" class="primary" disabled={creating || !newName.trim()}>{creating ? 'Creating…' : 'Create project'}</button>
    </div>
  </form>

  <details class="import">
    <summary>Import .zip</summary>
    <form class="form" onsubmit={startImport}>
      <p class="hint">Creates a new project from a zip archive (up to {MAX_IMPORT_BYTES / 1048576} MB). Build files such as
        .aux and .log are left out.</p>
      <div class="row">
        <input bind:this={zipInput} type="file" accept=".zip,application/zip" onchange={pickZip} aria-label="Zip file"
          disabled={importHandle !== null} />
      </div>
      {#if zipFile}
        <div class="row">
          <input bind:value={importName} maxlength="120" aria-label="Project name" placeholder="Project name"
            disabled={importHandle !== null} />
          {#if importHandle}
            <progress max={importProgress?.total || 1} value={importProgress?.loaded ?? 0}></progress>
            <button type="button" onclick={cancelImport}>Cancel</button>
          {:else}
            <button type="submit" class="primary" disabled={!importName.trim()}>Import</button>
          {/if}
        </div>
      {/if}
      {#if importError}<p class="error">{importError}</p>{/if}
    </form>
  </details>

  {#if error}
    <p class="error">{error}</p>
  {:else if !projects}
    <p class="muted">Loading…</p>
  {:else if projects.length === 0}
    <p class="muted">You are not a member of any project yet. Create one above, or open an invite link.</p>
  {:else}
    <table class="list">
      <thead><tr><th>Name</th><th>Your role</th><th>Owner</th><th>Updated</th><th></th></tr></thead>
      <tbody>
        {#each projects as p (p.id)}
          <tr>
            <td><a href="#/project/{encodeURIComponent(p.id)}">{p.name}</a></td>
            <td>{p.role}</td>
            <td>{p.ownerName}</td>
            <td>{when(p.updatedAt)}</td>
            <td class="actions">
              {#if p.role === 'owner'}
                <button type="button" onclick={() => remove(p)}>Delete…</button>
              {:else}
                <button type="button" onclick={() => leave(p)}>Leave…</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</main>

<style>
  .import { margin: 12px 0 20px; }
  .import summary { cursor: pointer; color: #2a5bd7; }
  .import .form { margin-top: 8px; }
  .import progress { width: 160px; }
</style>
