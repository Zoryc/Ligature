<script lang="ts" module>
  import type { Engine } from '@ligature/shared'

  export const ENGINE_LABELS: Record<Engine, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' }
  export function engineLabel(e: string): string {
    return (ENGINE_LABELS as Record<string, string>)[e] ?? e
  }
</script>

<script lang="ts">
  import { onDestroy } from 'svelte'
  import { can, ENGINES, type Me, type ProjectDetail, type SettingChange, type UpdateProjectRequest } from '@ligature/shared'
  import { api, exportZipUrl } from './api.ts'
  import { mainFileCandidates } from './treeOps.ts'
  import { errorMessage } from './errors.ts'
  import { toast } from './toasts.svelte.ts'
  import { agoText } from './trash.ts'
  import { confirmDialog } from './dialogs.svelte.ts'
  import { FONT_SIZES, prefs, setPref } from './prefs.svelte.ts'
  import Avatar from './Avatar.svelte'

  interface Props {
    detail: ProjectDetail
    me: Me
    /** The server's updated project (also arrives via project-changed). */
    onUpdated: (d: ProjectDetail) => void
    autoCompile: boolean
    onAutoCompile: (on: boolean) => void
    compiling: boolean
    onRecompile: () => void
    /** The owner deleted the project. */
    onDeleted: () => void
  }
  let { detail, me, onUpdated, autoCompile, onAutoCompile, compiling, onRecompile, onDeleted }: Props = $props()

  let isOwner = $derived(detail.role === 'owner')
  let canEdit = $derived(can.edit(detail.role))
  let candidates = $derived(mainFileCandidates(detail.tree))
  let name = $state('')
  let busy = $state(false)
  /** "✓ Saved" next to the personal setting just changed. */
  let saved = $state<string | null>(null)
  let savedTimer: ReturnType<typeof setTimeout> | null = null
  /** Re-render the "5 min ago" texts now and then. */
  let now = $state(Date.now())
  const clock = setInterval(() => { now = Date.now() }, 30_000)
  onDestroy(() => {
    clearInterval(clock)
    if (savedTimer) clearTimeout(savedTimer)
  })

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
      now = Date.now()
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
    if (v !== detail.engine) void save({ engine: v }, `Compiler set to ${engineLabel(v)}. It is used from the next build.`)
  }

  function setMain(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value
    if (v && v !== detail.mainFileId) void save({ mainFileId: v }, 'Main file changed.')
  }

  function personal(what: string, apply: () => void) {
    apply()
    saved = what
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { saved = null }, 2000)
  }

  async function deleteProject() {
    const ok = await confirmDialog('Delete project',
      `Delete “${detail.name}” for all members? It disappears from everyone’s project list. An administrator can still recover it until it is purged.`,
      { confirmLabel: 'Delete project', danger: true })
    if (!ok) return
    try {
      await api.deleteProject(detail.id)
      onDeleted()
    } catch (e) {
      toast(`Could not delete the project: ${errorMessage(e)}`, 'error')
    }
  }

  function whoText(c: SettingChange): string {
    return c.byUserId === me.id ? 'you' : c.by || 'a former member'
  }
</script>

{#snippet changed(c: SettingChange | undefined, label: (was: string) => string)}
  {#if c}
    <p class="changed">
      {#if c.byUserId}<Avatar id={c.byUserId} name={c.by || '?'} size={16} />{/if}
      <span>Changed by <strong>{whoText(c)}</strong> · {agoText(c.at, now)}{#if c.was} · was {label(c.was)}{/if}</span>
    </p>
  {/if}
{/snippet}

{#snippet toggle(on: boolean, disabled: boolean, label: string, flip: () => void)}
  <button type="button" class="switch" role="switch" aria-checked={on} aria-label={label} {disabled} onclick={flip}>
    <span class="track" class:on><span class="knob"></span></span>
    <span class="state">{on ? 'On' : 'Off'}</span>
  </button>
{/snippet}

<div class="settings">
  <section aria-labelledby="set-shared">
    <header class="sec-head">
      <div>
        <h3 id="set-shared">Shared with the project</h3>
        <p>Everyone in this project uses these. Changes reach all members at once.</p>
      </div>
      <span class="tag">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.4c1.8.8 3 2.8 3 5.6" /></svg>
        Shared
      </span>
    </header>

    <div class="row">
      <label class="label" for="set-engine">Compiler</label>
      <div class="control">
        <div class="line">
          <select id="set-engine" value={detail.engine} disabled={!canEdit || busy} onchange={setEngine}>
            {#each ENGINES as en (en)}<option value={en}>{engineLabel(en)}</option>{/each}
          </select>
          {#if canEdit}
            <button type="button" disabled={compiling} onclick={onRecompile}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>
              {compiling ? 'Compiling…' : 'Recompile now'}
            </button>
          {/if}
        </div>
        <p class="hint">Used from the next build. pdfLaTeX is the fastest; XeLaTeX and LuaLaTeX can use the system fonts.</p>
        {@render changed(detail.changes.engine, engineLabel)}
      </div>
    </div>

    <div class="row">
      <label class="label" for="set-main">Main file</label>
      <div class="control">
        <select id="set-main" class="mono" value={detail.mainFileId ?? ''} disabled={!canEdit || busy || candidates.length === 0} onchange={setMain}>
          {#if !detail.mainFileId}<option value="" disabled>(none: choose a .tex file)</option>{/if}
          {#each candidates as c (c.id)}<option value={c.id}>{c.path}</option>{/each}
        </select>
        <p class="hint">The file the compiler starts from. Only .tex files can be the main file.</p>
        {@render changed(detail.changes.mainFile, w => w)}
      </div>
    </div>

    <div class="row">
      <label class="label" for="set-name">Project name</label>
      <div class="control">
        {#if isOwner}
          <form class="joined" onsubmit={saveName}>
            <input id="set-name" bind:value={name} maxlength="120" />
            <button type="submit" disabled={busy || !name.trim() || name.trim() === detail.name}>Save</button>
          </form>
          <p class="hint">Press Save to rename. Only the owner can rename.</p>
        {:else}
          <input id="set-name" value={detail.name} disabled />
          <p class="hint">Only the owner can rename the project.</p>
        {/if}
        {@render changed(detail.changes.name, w => `“${w}”`)}
      </div>
    </div>

    {#if !canEdit}
      <p class="note">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true"><rect x="5" y="11" width="14" height="10" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        You are a viewer: the compiler and the main file are read-only for you.
      </p>
    {/if}
  </section>

  <section class="mine" aria-labelledby="set-you">
    <header class="sec-head">
      <div>
        <h3 id="set-you">Only for you</h3>
        <p>Your own preferences, kept in this browser. Nobody else sees them or is affected.</p>
      </div>
      <span class="tag">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" /></svg>
        You
      </span>
    </header>

    <div class="row">
      <span class="label" id="set-auto">Auto-compile</span>
      <div class="control">
        <div class="line">
          {@render toggle(autoCompile && canEdit, !canEdit, 'Auto-compile', () => personal('auto', () => onAutoCompile(!autoCompile)))}
          {#if saved === 'auto'}<span class="saved">✓ Saved</span>{/if}
        </div>
        <p class="hint">
          {canEdit ? 'Compiles 2.5 s after you stop typing, in this project. Ctrl+S always compiles.' : 'Viewers cannot compile.'}
        </p>
      </div>
    </div>

    <div class="row">
      <label class="label" for="set-font">Editor font size</label>
      <div class="control">
        <div class="line">
          <select id="set-font" class="narrow" value={prefs.fontSize}
            onchange={e => { const v = Number(e.currentTarget.value); personal('font', () => setPref('fontSize', v)) }}>
            {#each FONT_SIZES as s (s)}<option value={s}>{s} px</option>{/each}
          </select>
          {#if saved === 'font'}<span class="saved">✓ Saved</span>{/if}
        </div>
      </div>
    </div>

    <div class="row">
      <span class="label">Wrap long lines</span>
      <div class="control">
        <div class="line">
          {@render toggle(prefs.wrap, false, 'Wrap long lines', () => personal('wrap', () => setPref('wrap', !prefs.wrap)))}
          <span class="hint inline">Wraps at the editor’s edge; the file is unchanged.</span>
          {#if saved === 'wrap'}<span class="saved">✓ Saved</span>{/if}
        </div>
      </div>
    </div>
  </section>

  <section aria-labelledby="set-actions">
    <header class="sec-head"><div><h3 id="set-actions">Project actions</h3></div></header>
    <div class="row action">
      <a class="button" href={exportZipUrl(detail.id)} download>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></svg>
        Download .zip
      </a>
      <span class="hint">All files, as they are now.</span>
    </div>
    {#if isOwner}
      <div class="row action">
        <button type="button" class="danger" onclick={deleteProject}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
          Delete project…
        </button>
        <span class="hint">Owner only. Removes it for all members; you confirm first.</span>
      </div>
    {/if}
  </section>
</div>

<style>
  .settings { display: flex; flex-direction: column; }
  section { border-bottom: 1px solid var(--rule); background: var(--sheet); }
  section.mine { background: var(--paper); }
  .sec-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--rule-soft);
  }
  h3 { margin: 0; font-size: 18px; line-height: 1.2; }
  .sec-head p { margin: 4px 0 0; color: var(--ink-3); font-size: 12.5px; }
  .tag { gap: 5px; flex: none; }
  .row {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr);
    gap: 12px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .row:last-child { border-bottom: 0; }
  .label { font-weight: 600; color: var(--ink); padding-top: 7px; }
  .control { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  select { min-width: 190px; }
  select.narrow { min-width: 96px; }
  select.mono { font-family: var(--font-mono); font-size: 12.5px; }
  .joined { display: flex; }
  .joined input { flex: 1; min-width: 0; }
  .joined button { border-left: 0; min-height: 30px; }
  .control > input { width: 100%; }
  .hint { margin: 0; font-size: 12px; color: var(--ink-4); }
  .hint.inline { flex: 1; min-width: 140px; }
  .changed { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: var(--ink-3); }
  .changed strong { font-weight: 600; color: var(--ink-2); }
  .note {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 10px 20px;
    font-size: 12.5px;
    color: var(--ink-3);
    background: var(--paper);
    border-top: 1px solid var(--rule-soft);
  }
  .saved { color: var(--green); font-size: 12px; font-weight: 500; }
  .switch {
    border: 0;
    background: transparent;
    padding: 0;
    min-height: 28px;
    gap: 9px;
  }
  .switch:hover:not(:disabled) { background: transparent; }
  .track {
    position: relative;
    display: inline-block;
    width: 34px;
    height: 18px;
    border: 1px solid var(--ink-3);
    background: var(--paper-2);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    background: var(--ink-3);
    transition: left 0.12s ease;
  }
  .track.on { border-color: var(--teal); background: var(--teal); }
  .track.on .knob { left: 18px; background: #FFFFFF; }
  .state { font-weight: 500; color: var(--ink-2); min-width: 22px; text-align: left; }
  .action { grid-template-columns: auto minmax(0, 1fr); align-items: center; }
  .action .button, .action button { justify-self: start; min-width: 132px; justify-content: flex-start; }
</style>
