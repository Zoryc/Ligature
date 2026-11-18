<script lang="ts">
  import { onDestroy } from 'svelte'
  import { fetchText, rawFileUrl, versionFileUrl } from './api.ts'
  import { changeWord, type ChangeRow, type SideSource } from './history.ts'
  import { readOnlyExtensions as extensions } from './mergeView.ts'
  import { isInlineImage } from './treeOps.ts'
  import { errorMessage } from './errors.ts'

  interface Props {
    projectId: string
    row: ChangeRow
    left: SideSource
    right: SideSource
    leftTitle: string
    rightTitle: string
    onClose: () => void
  }

  let { projectId, row, left, right, leftTitle, rightTitle, onClose }: Props = $props()

  let host = $state<HTMLDivElement | undefined>(undefined)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let identical = $state(false)
  let merge: { destroy(): void } | null = null
  let seq = 0

  function urlOf(s: SideSource, inline = false): string | null {
    if (s.type === 'version') return versionFileUrl(projectId, s.versionId, s.path, inline)
    if (s.type === 'live') return rawFileUrl(projectId, s.fileId, inline)
    return null
  }

  function nameOf(s: SideSource): string {
    if (s.type === 'none') return ''
    return s.path.slice(s.path.lastIndexOf('/') + 1)
  }

  let isImage = $derived(isInlineImage(row.path))

  async function loadText(s: SideSource): Promise<string> {
    const url = urlOf(s)
    return url ? fetchText(url) : ''
  }

  // (Re)build the merge view whenever the compared files change.
  $effect(() => {
    if (row.kind !== 'text' || !host) return
    const el = host
    const my = ++seq
    const l = left
    const r = right
    const path = row.path
    loading = true
    error = null
    identical = false
    void (async () => {
      try {
        const [a, b, mod] = await Promise.all([loadText(l), loadText(r), import('@codemirror/merge')])
        if (my !== seq) return
        merge?.destroy()
        el.replaceChildren()
        identical = a === b
        merge = new mod.MergeView({
          a: { doc: a, extensions: extensions(path) },
          b: { doc: b, extensions: extensions(path) },
          parent: el,
          gutter: true,
          highlightChanges: true,
          collapseUnchanged: { margin: 3, minSize: 6 },
        })
      } catch (e) {
        if (my === seq) error = `Could not load the file: ${errorMessage(e)}`
      } finally {
        if (my === seq) loading = false
      }
    })()
    return () => {
      seq++
      merge?.destroy()
      merge = null
    }
  })

  onDestroy(() => {
    merge?.destroy()
    merge = null
  })
</script>

<div class="file-diff">
  <div class="head">
    <strong class="path" title={row.path}>{row.path}</strong>
    <span class="change change-{row.change}">{changeWord(row.file)}</span>
    {#if row.detail}<span class="muted">{row.detail}</span>{/if}
    <span class="spacer"></span>
    <button type="button" onclick={onClose}>Close</button>
  </div>
  <div class="sides">
    <div class="side-title">{leftTitle}{#if left.type !== 'none' && left.path !== row.path}<span class="muted"> ({left.path})</span>{/if}</div>
    <div class="side-title">{rightTitle}{#if right.type !== 'none' && right.path !== row.path}<span class="muted"> ({right.path})</span>{/if}</div>
  </div>
  {#if row.kind === 'text'}
    {#if error}<p class="error pad">{error}</p>{/if}
    {#if loading}<p class="muted pad">Loading…</p>{/if}
    {#if identical && !loading && !error}<p class="muted pad">The content is the same on both sides.</p>{/if}
    <div class="merge" bind:this={host}></div>
  {:else}
    <div class="binary">
      {#each [{ s: left, t: leftTitle }, { s: right, t: rightTitle }] as side, i (i)}
        <div class="bin-side">
          {#if side.s.type === 'none'}
            <p class="muted">Not present.</p>
          {:else}
            {#if isImage}
              <img class="thumb" src={urlOf(side.s, true)} alt="{side.t}: {nameOf(side.s)}" />
            {:else}
              <p class="muted">Binary file{row.change === 'unchanged' ? '' : ' (changed)'}.</p>
            {/if}
            <a href={urlOf(side.s)} download={nameOf(side.s)}>Download</a>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .file-diff {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: white;
  }
  .head {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid #ddd;
    background: #fafafa;
  }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border-bottom: 1px solid #eee;
    font-size: 12px;
    font-weight: 600;
  }
  .side-title { padding: 4px 10px; }
  .side-title + .side-title { border-left: 1px solid #eee; }
  .pad { padding: 4px 10px; margin: 0; }
  .merge { flex: 1; min-height: 0; overflow: auto; font-size: 13px; }
  .merge :global(.cm-mergeView) { min-height: 100%; }
  .merge :global(.cm-editor) { height: auto; }
  .binary {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 12px;
    overflow: auto;
  }
  .bin-side { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .thumb {
    max-width: 100%;
    max-height: 320px;
    border: 1px solid #ddd;
    background: repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0 / 16px 16px;
  }
  .change { font-size: 12px; padding: 0 6px; border-radius: 8px; background: #eee; }
  .change-added { background: #e3f4e6; color: #1b7f3b; }
  .change-removed { background: #fde7ea; color: #b00020; }
  .change-modified, .change-renamed { background: #fff1d6; color: #8a5300; }
</style>
