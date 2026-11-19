<script lang="ts">
  import { tick } from 'svelte'
  import { dialogState } from './dialogs.svelte.ts'

  let d = $derived(dialogState.current)
  let value = $state('')
  let typed = $state('')
  let field = $state<HTMLInputElement | HTMLSelectElement | undefined>(undefined)
  let confirmBtn = $state<HTMLButtonElement | undefined>(undefined)

  // Reset the fields whenever a new dialog opens, then focus the first control.
  $effect(() => {
    const cur = d
    if (!cur) return
    value = cur.input?.value ?? cur.select?.value ?? cur.select?.options.find(o => !o.disabled)?.value ?? ''
    typed = ''
    void tick().then(() => {
      if (field) {
        field.focus()
        if (field instanceof HTMLInputElement) field.select()
      } else confirmBtn?.focus()
    })
  })

  let problem = $derived(d?.input?.validate ? d.input.validate(value) : null)
  let blocked = $derived(!!d && ((d.requireText !== undefined && typed !== d.requireText) || problem !== null
    || (d.select !== undefined && value === '')))

  function submit(e: Event) {
    e.preventDefault()
    if (!d || blocked) return
    d.resolve(d.input || d.select ? value : '')
  }

  function cancel() {
    d?.resolve(null)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && d) {
      e.preventDefault()
      cancel()
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if d}
  <div class="backdrop" role="presentation" onclick={e => { if (e.target === e.currentTarget) cancel() }}>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <form onsubmit={submit}>
      <div class="body">
        <h2 id="dialog-title">{d.title}</h2>
        {#if d.message}<p class="message">{d.message}</p>{/if}
        {#if d.input}
          <label>
            {d.input.label}
            <input bind:this={field} bind:value type={d.input.type ?? 'text'} autocomplete="off" />
          </label>
          {#if problem && value !== (d.input.value ?? '')}<p class="problem">{problem}</p>{/if}
        {/if}
        {#if d.select}
          <label>
            {d.select.label}
            <select bind:this={field} bind:value>
              {#each d.select.options as o (o.value)}
                <option value={o.value} disabled={o.disabled}>{o.label}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if d.requireText !== undefined}
          <label>
            <span>Type <strong class="require">{d.requireText}</strong> to confirm</span>
            <input bind:value={typed} autocomplete="off" />
          </label>
        {/if}
      </div>
      <div class="buttons">
        <button type="button" onclick={cancel}>Cancel</button>
        <button bind:this={confirmBtn} type="submit" class={d.danger ? 'danger solid' : 'primary'} disabled={blocked}>
          {d.confirmLabel ?? 'OK'}
        </button>
      </div>
    </form>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--ink) 28%, transparent);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 200;
  }
  .dialog {
    background: var(--sheet);
    border: 1px solid var(--rule-strong);
    width: min(440px, 92vw);
    box-shadow: var(--shadow);
  }
  .body { padding: 20px 22px 18px; }
  h2 { margin: 0 0 10px; font-size: 18px; line-height: 1.25; }
  .message { margin: 0 0 4px; white-space: pre-line; color: var(--ink-2); line-height: 1.5; }
  label { display: block; margin: 14px 0 0; font-weight: 500; color: var(--ink-2); }
  input, select { display: block; width: 100%; margin-top: 5px; }
  .require { font-family: var(--font-mono); font-weight: 600; color: var(--ink); }
  .problem { color: var(--red); margin: 6px 0 0; font-size: 12.5px; }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 22px;
    background: var(--paper);
    border-top: 1px solid var(--rule);
  }
</style>
