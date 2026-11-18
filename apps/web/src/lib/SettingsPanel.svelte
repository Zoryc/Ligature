<script lang="ts">
  import { can, ENGINES, type Engine, type ProjectDetail, type UpdateProjectRequest } from '@ligature/shared'
  import { api } from './api.ts'
  import { mainFileCandidates } from './treeOps.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'

  interface Props {
    detail: ProjectDetail
    /** The server's updated project (also arrives via project-changed). */
    onUpdated: (d: ProjectDetail) => void
  }
  let { detail, onUpdated }: Props = $props()

  let isOwner = $derived(detail.role === 'owner')
  let canEdit = $derived(can.edit(detail.role))
  let candidates = $derived(mainFileCandidates(detail.tree))
  let name = $state('')
  let busy = $state(false)

  // Keep the field in step with the server unless the user is typing a change.
  let lastServerName = ''
  $effect(() => {
    if (detail.name !== lastServerName) {
      name = detail.name
      lastServerName = detail.name
    }
  })

  async function save(req: UpdateProjectRequest, done: string) {
    busy = true
    try {
      onUpdated(await api.updateProject(detail.id, req))
      toast(done)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      busy = false
    }
  }

  function saveName(e: Event) {
    e.preventDefault()
    const n = name.trim()
    if (!n || n === detail.name) return
    void save({ name: n }, 'Project renamed.')
  }

  function setEngine(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value as Engine
    if (v !== detail.engine) void save({ engine: v }, `Engine set to ${v}.`)
  }

  function setMain(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value
    if (v && v !== detail.mainFileId) void save({ mainFileId: v }, 'Main file changed.')
  }
</script>

<div class="form">
  <div class="field">
    <span>Project name</span>
    {#if isOwner}
      <form class="row" onsubmit={saveName}>
        <input bind:value={name} maxlength="120" aria-label="Project name" />
        <button type="submit" disabled={busy || !name.trim() || name.trim() === detail.name}>Rename</button>
      </form>
    {:else}
      <span>{detail.name} <span class="muted">(only the owner can rename)</span></span>
    {/if}
  </div>

  <label>Compiler engine
    <select value={detail.engine} disabled={!canEdit || busy} onchange={setEngine}>
      {#each ENGINES as en (en)}<option value={en}>{en}</option>{/each}
    </select>
  </label>

  <label>Main file
    <select value={detail.mainFileId ?? ''} disabled={!canEdit || busy || candidates.length === 0} onchange={setMain}>
      {#if !detail.mainFileId}<option value="" disabled>(none: choose a .tex file)</option>{/if}
      {#each candidates as c (c.id)}<option value={c.id}>{c.path}</option>{/each}
    </select>
    <span class="hint">The file the compiler starts from. Only .tex files can be the main file.</span>
  </label>
  {#if !canEdit}<p class="muted">Viewers cannot change settings.</p>{/if}
</div>

<style>
  .field { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; gap: 6px; }
  .row input { flex: 1; }
</style>
