<script lang="ts">
  /**
   * Search in all files, and Replace all (docs/RENAME-AND-REPLACE.md §5): the Search tab of the project sidebar.
   * It searches the tab's texts of the source files (search.ts); Replace all is run by the project page.
   */
  import { onDestroy } from 'svelte'
  import { replaceLabel, sameSearch, searchFiles, summaryText, type SearchOptions, type SearchSummary } from './search.ts'

  interface Props {
    /** The source files with their current texts: the main file first, then in the tree's order. */
    files: () => { id: string; path: string; text: string }[]
    /** Bumped when the texts change (loaded, replaced): the search runs again. */
    version: number
    canEdit: boolean
    query: string
    matchCase: boolean
    wholeWord: boolean
    replacement: string
    /** A result was clicked: open its file and select the match. */
    onOpen: (fileId: string, line: number, column: number, length: number) => void
    /** Replace all, in the files with results; resolves when done (or refused). */
    onReplace: (query: string, opts: SearchOptions, replacement: string, fileIds: string[]) => Promise<void>
  }

  let {
    files, version, canEdit, query = $bindable(), matchCase = $bindable(), wholeWord = $bindable(),
    replacement = $bindable(), onOpen, onReplace,
  }: Props = $props()

  let input = $state<HTMLInputElement | undefined>(undefined)
  let summary = $state.raw<SearchSummary | null>(null)
  /** The query and options the results are for (they may lag the fields by the debounce). */
  let searched = $state('')
  let searchedOpts = $state.raw<SearchOptions>({ matchCase: false, wholeWord: false })
  /** The results shown are for what the fields say now: Replace all would do what its label says. */
  const current = $derived(sameSearch({ query: searched, opts: searchedOpts }, { query, opts: { matchCase, wholeWord } }))
  let replacing = $state(false)
  let paths = $state.raw(new Map<string, string>())
  let timer: ReturnType<typeof setTimeout> | null = null

  function run() {
    const list = files()
    paths = new Map(list.map(f => [f.id, f.path]))
    searched = query
    searchedOpts = { matchCase, wholeWord }
    summary = query ? searchFiles(list, query, searchedOpts) : null
  }

  // As you type, debounced 150 ms; and again when the texts change.
  $effect(() => {
    void query
    void matchCase
    void wholeWord
    void version
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      run()
    }, 150)
  })

  onDestroy(() => {
    if (timer) clearTimeout(timer)
  })

  /** Focus the query field (Ctrl+Shift+F) and select it. */
  export function focus(): void {
    input?.focus()
    input?.select()
  }

  async function replaceAll() {
    const s = summary
    // Not while the results lag a change of the query or of a toggle: the file list would be for another search.
    if (!s || !s.total || replacing || !current) return
    const q = searched
    const opts = { ...searchedOpts }
    replacing = true
    try {
      await onReplace(q, opts, replacement, s.files.map(f => f.fileId))
    } finally {
      replacing = false
    }
  }
</script>

<div class="search">
  <div class="fields">
    <div class="query">
      <input bind:this={input} type="search" bind:value={query} placeholder="Search in all files" aria-label="Search in all files"
        spellcheck="false" onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); run() } }} />
      <button type="button" class="toggle" class:on={matchCase} aria-pressed={matchCase} title="Match case"
        onclick={() => { matchCase = !matchCase }}>Aa</button>
      <button type="button" class="toggle" class:on={wholeWord} aria-pressed={wholeWord}
        title="Whole word: not preceded or followed by a letter, digit or _" onclick={() => { wholeWord = !wholeWord }}>ab</button>
    </div>
    {#if canEdit}
      <input type="text" bind:value={replacement} placeholder="Replace with" aria-label="Replace with" spellcheck="false" />
      {#if summary && summary.total > 0}
        <button type="button" class="primary small replace" disabled={replacing || !current} onclick={replaceAll}
          title={replacement ? `Replace every result with “${replacement}”; Ctrl+Z in the editor undoes it` : 'Delete every result; Ctrl+Z in the editor undoes it'}>
          {replacing ? 'Replacing…' : replaceLabel(summary)}
        </button>
      {/if}
    {/if}
  </div>

  {#if summary}
    <p class="summary" role="status">{summaryText(summary)}</p>
    <ol class="groups">
      {#each summary.files as f (f.fileId)}
        <li>
          <div class="file" title={paths.get(f.fileId) ?? ''}>
            <span class="path">{paths.get(f.fileId) ?? 'a file'}</span><span class="count">{f.count}</span>
          </div>
          <ol class="results">
            {#each f.results as r (r.from)}
              <li>
                <button type="button" class="result" onclick={() => onOpen(f.fileId, r.line, r.column, r.to - r.from)}>
                  <span class="ln">{r.line}</span>
                  <span class="text">{r.before}<mark>{r.match}</mark>{r.after}</span>
                </button>
              </li>
            {/each}
          </ol>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="note">Search the source files of this project (.tex, .bib, .sty, .cls). The text is matched as typed.</p>
  {/if}
</div>

<style>
  .search { display: flex; flex-direction: column; min-height: 100%; }
  .fields { display: flex; flex-direction: column; gap: 6px; padding: 10px 10px 8px; border-bottom: 1px solid var(--rule-soft); }
  .query { display: flex; gap: 4px; }
  .query input { flex: 1; min-width: 0; }
  input { font-family: var(--font-mono); font-size: 12.5px; }
  .toggle {
    flex: none;
    width: 30px;
    padding: 0;
    font: 500 12px/1 var(--font-mono);
    color: var(--ink-3);
    background: var(--sheet);
  }
  .toggle.on { background: var(--teal-tint); border-color: var(--teal-edge); color: var(--teal-dark); }
  .replace { align-self: flex-start; }
  .summary { margin: 8px 12px 4px; font-size: 12px; color: var(--ink-3); }
  .note { margin: 10px 16px; font: 400 12.5px/1.45 var(--font-ui); color: var(--ink-4); }
  ol { list-style: none; margin: 0; padding: 0; }
  .groups { padding-bottom: 12px; }
  .file {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 3px;
    font: 500 12px/1.3 var(--font-mono);
    color: var(--ink);
  }
  .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { flex: none; font: 500 11px/1 var(--font-ui); color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .result {
    display: flex;
    justify-content: flex-start;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    min-height: 24px;
    padding: 2px 12px 2px 14px;
    border: 0;
    background: none;
    text-align: left;
    font: 400 12px/1.4 var(--font-mono);
    color: var(--ink-2);
  }
  .result:hover:not(:disabled) { background: var(--paper-2); }
  .ln { flex: 0 0 30px; color: var(--ink-4); text-align: right; font-variant-numeric: tabular-nums; }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
  mark { background: var(--amber-tint); outline: 1px solid var(--amber-rule); color: var(--ink); }
</style>
