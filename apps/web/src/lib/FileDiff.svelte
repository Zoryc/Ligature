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
    <button type="button" class="small" onclick={onClose}>
      <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      Close
    </button>
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
    background: var(--sheet);
    font-size: 13px;
  }
  .head {
    display: flex;
    gap: 10px;
    align-items: center;
    min-height: 36px;
    padding: 4px 8px 4px 16px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper-2);
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 500 12.5px/1.3 var(--font-mono);
    color: var(--ink);
  }
  .head .muted { font-size: 12px; white-space: nowrap; }
  .spacer { flex: 1; }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-3);
  }
  .side-title { padding: 6px 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .side-title + .side-title { border-left: 1px solid var(--rule); }
  .side-title .muted { font-weight: 400; font-family: var(--font-mono); }
  .pad { padding: 8px 16px; margin: 0; }
  .merge { flex: 1; min-height: 0; overflow: auto; font-size: 13px; }
  .merge :global(.cm-mergeView) { min-height: 100%; }
  .merge :global(.cm-editor) { height: auto; }
  .binary {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    padding: 16px;
    overflow: auto;
  }
  .bin-side { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .thumb {
    max-width: 100%;
    max-height: 320px;
    border: 1px solid var(--rule);
    background: repeating-conic-gradient(var(--paper-2) 0 25%, var(--sheet) 0 50%) 0 0 / 16px 16px;
  }
  .change {
    display: inline-flex;
    align-items: center;
    flex: none;
    height: 18px;
    padding: 0 5px;
    border: 1px solid var(--rule-strong);
    background: var(--paper);
    color: var(--ink-3);
    font: 600 10px/1 var(--font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .change-added { background: var(--green-tint); border-color: var(--green); color: var(--green); }
  .change-removed { background: var(--red-tint); border-color: var(--red-rule); color: var(--red); }
  .change-modified, .change-renamed { background: var(--amber-tint); border-color: var(--amber-rule); color: var(--amber); }
</style>
