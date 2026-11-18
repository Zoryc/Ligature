<script lang="ts">
  import type { TreeEntry } from '@ligature/shared'
  import type { TreeRow } from './tree.ts'

  interface Props {
    rows: TreeRow[]
    selectedId: string | null
    mainFileId: string | null
    onOpen: (entry: TreeEntry) => void
  }

  let { rows, selectedId, mainFileId, onOpen }: Props = $props()

  let collapsed = $state(new Set<string>())

  function toggle(id: string) {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    collapsed = next
  }

  // Hide rows under a collapsed folder.
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
</script>

<ul class="tree">
  {#each visible as r (r.entry.id)}
    <li style="padding-left: {8 + r.depth * 14}px">
      {#if r.entry.kind === 'folder'}
        <button type="button" class="row folder" onclick={() => toggle(r.entry.id)}>
          {collapsed.has(r.entry.id) ? '▸' : '▾'} {r.entry.name}/
        </button>
      {:else if r.entry.kind === 'text'}
        <button type="button" class="row file" class:selected={r.entry.id === selectedId} onclick={() => onOpen(r.entry)}>
          {r.entry.name}{#if r.entry.id === mainFileId}<span class="main" title="Main file"> (main)</span>{/if}
        </button>
      {:else}
        <span class="row binary" title="Binary file (not editable)">{r.entry.name}</span>
      {/if}
    </li>
  {:else}
    <li class="empty">No files.</li>
  {/each}
</ul>

<style>
  .tree {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    font-size: 13px;
  }
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
  .selected { background: #dde4ff; }
  .binary { color: #888; cursor: default; }
  .main { color: #888; font-size: 11px; }
  .empty { padding: 8px; color: #666; }
</style>
