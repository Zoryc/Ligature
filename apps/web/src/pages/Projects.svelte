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
  import Avatar from '../lib/Avatar.svelte'
  import { personName } from '../lib/people.ts'

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
  <div class="title">
    <h1>Projects</h1>
    {#if projects && projects.length > 0}
      <span class="count">{projects.length} project{projects.length === 1 ? '' : 's'}</span>
    {/if}
  </div>

  <section class="start">
    <form class="new" onsubmit={create}>
      <input bind:value={newName} placeholder="New project name" maxlength="120" aria-label="New project name" />
      <button type="submit" class="primary" disabled={creating || !newName.trim()}>
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        {creating ? 'Creating…' : 'Create project'}
      </button>
    </form>

    <details class="import">
      <summary class="button">
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" fill="none" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 14v6h16v-6" /></svg>
        Import .zip
      </summary>
      <form class="form import-body" onsubmit={startImport}>
        <p class="hint">Creates a new project from a zip archive (up to {MAX_IMPORT_BYTES / 1048576} MB). Build files such as
          .aux and .log are left out.</p>
        <div class="row">
          <input bind:this={zipInput} type="file" accept=".zip,application/zip" onchange={pickZip} aria-label="Zip file"
            disabled={importHandle !== null} />
        </div>
        {#if zipFile}
          <div class="row">
            <input class="grow" bind:value={importName} maxlength="120" aria-label="Project name" placeholder="Project name"
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
  </section>

  {#if error}
    <p class="error">{error}</p>
  {:else if !projects}
    <p class="muted">Loading…</p>
  {:else if projects.length === 0}
    <p class="empty muted">You are not a member of any project yet. Create one above, or open an invite link.</p>
  {:else}
    <table class="list projects">
      <thead><tr><th>Name</th><th>Your role</th><th>Owner</th><th>Updated</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>
        {#each projects as p (p.id)}
          <tr>
            <td class="name"><a href="#/project/{encodeURIComponent(p.id)}">{p.name}</a></td>
            <td><span class="tag" class:own={p.role === 'owner'}>{p.role}</span></td>
            <td>
              <span class="person">
                <Avatar id={p.role === 'owner' && session.me ? session.me.id : p.ownerName} name={personName(p.ownerName)} size={20} />
                <span>{personName(p.ownerName)}</span>
              </span>
            </td>
            <td class="when">{when(p.updatedAt)}</td>
            <td class="end">
              {#if p.role === 'owner'}
                <button type="button" class="small quiet del" onclick={() => remove(p)}>Delete…</button>
              {:else}
                <button type="button" class="small quiet" onclick={() => leave(p)}>Leave…</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</main>

<style>
  .title { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
  .title h1 { margin: 0; }
  .count { color: var(--ink-4); }

  .start {
    position: relative;
    margin: 0 0 24px;
    padding: 14px 16px;
    background: var(--sheet);
    border: 1px solid var(--rule);
  }
  .new { display: flex; gap: 8px; padding-right: 128px; }
  .new input { flex: 1; min-width: 0; max-width: 420px; }
  .import summary {
    position: absolute;
    top: 14px;
    right: 16px;
    min-height: 30px;
    list-style: none;
  }
  .import summary::-webkit-details-marker { display: none; }
  .import[open] summary { background: var(--paper-2); border-color: var(--ink-4); }
  .import-body {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--rule-soft);
    gap: 10px;
  }
  .import-body .hint { margin: 0; font-size: 12px; color: var(--ink-4); }
  .import-body .grow { flex: 1; min-width: 180px; max-width: 420px; }
  .import-body .error { margin: 0; }
  .import progress { width: 160px; }
  @media (max-width: 560px) {
    .new { padding-right: 0; }
    .import summary { position: static; margin-top: 10px; }
  }

  .empty { padding: 28px 20px; text-align: center; border: 1px dashed var(--rule-strong); }

  .projects th:last-child, .end { width: 1%; white-space: nowrap; text-align: right; }
  .projects tbody tr:hover { background: var(--sheet-hover); }
  .projects td { padding-top: 10px; padding-bottom: 10px; }
  .name a {
    font: 600 15px/1.3 var(--font-doc);
    color: var(--ink);
    text-decoration: none;
  }
  .name a:hover { color: var(--teal); text-decoration: underline; text-decoration-thickness: 1px; }
  .tag.own { border-color: var(--teal-edge); color: var(--teal); }
  .person { display: inline-flex; align-items: center; gap: 8px; color: var(--ink-2); }
  .when { color: var(--ink-4); white-space: nowrap; }
  .end button { color: var(--ink-3); }
  .end button.del:hover:not(:disabled) { color: var(--red); background: var(--red-tint); }
</style>
