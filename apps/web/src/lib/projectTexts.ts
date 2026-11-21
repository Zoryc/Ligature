/**
 * One loader for the texts of a project's source files (.tex, .bib, .sty, .cls), shared by the Contents outline
 * and the autocomplete index (docs/AUTOCOMPLETE.md). It loads them when the project opens and again on request
 * (after a tree change or a finished compile), 8 at a time; the file open in the editor uses its live text.
 */

export interface SourceFile {
  id: string
  name: string
}

export interface ProjectTextsOptions {
  /** The file's text from the server (the raw endpoint; the browser revalidates it with its ETag). */
  fetch: (fileId: string) => Promise<string>
  /** A load finished: files whose stored text changed (or appeared), and files no longer there. */
  onLoaded: (changed: string[], removed: string[]) => void
  /** The file open in the editor, whose live text wins over the stored one. */
  live?: () => { fileId: string; text: () => string } | null
  /** Called with true when the first load starts (nothing to show yet) and false when any load ends. */
  onLoading?: (loading: boolean) => void
}

const SOURCE = /\.(tex|ltx|bib|sty|cls)$/i
/** Requests at a time: enough to be quick, few enough not to crowd out the editor's own connection. */
const PARALLEL = 8
/** Beyond this, a project is not a typical LaTeX document; the outline and index stay partial. */
const MAX_FILES = 300

export function isSourceFile(name: string): boolean {
  return SOURCE.test(name)
}

export class ProjectTexts {
  private texts = new Map<string, string>()
  private running = false
  private queued: SourceFile[] | null = null
  private disposed = false
  private loadedOnce = false
  /** Bumped by every remember(): tells whether a text was remembered before or after a fetch of it started. */
  private generation = 0
  /** Texts remembered while a load runs, with their generation; a load must not replace them with older ones. */
  private recent = new Map<string, { text: string; at: number }>()

  constructor(private readonly opts: ProjectTextsOptions) {}

  /** The file's text: live when it is open in the editor, else as last loaded (null: not loaded). */
  text(fileId: string): string | null {
    const live = this.opts.live?.()
    if (live && live.fileId === fileId) return live.text()
    return this.texts.get(fileId) ?? null
  }

  /** Keep a file's latest text (e.g. the editor's text when the file is closed) until the next load. */
  remember(fileId: string, text: string): void {
    if (this.texts.has(fileId)) this.texts.set(fileId, text)
    if (this.running) this.recent.set(fileId, { text, at: ++this.generation })
  }

  /** Ids of the files loaded so far. */
  ids(): string[] {
    return [...this.texts.keys()]
  }

  /** (Re)load the source files among `files`. A call during a load runs once more afterwards, with the latest list. */
  async load(files: readonly SourceFile[]): Promise<void> {
    const list = files.filter(f => isSourceFile(f.name)).slice(0, MAX_FILES)
    if (this.running) {
      this.queued = list
      return
    }
    this.running = true
    if (!this.loadedOnce) this.opts.onLoading?.(true)
    try {
      let next: SourceFile[] | null = list
      while (next && !this.disposed) {
        this.queued = null
        await this.loadOnce(next)
        next = this.queued
      }
    } finally {
      this.running = false
      this.loadedOnce = true
      this.opts.onLoading?.(false)
    }
  }

  dispose(): void {
    this.disposed = true
  }

  private async loadOnce(list: SourceFile[]): Promise<void> {
    const next = new Map<string, string>()
    const fetchedAt = new Map<string, number>()
    for (let i = 0; i < list.length; i += PARALLEL) {
      await Promise.all(list.slice(i, i + PARALLEL).map(async f => {
        try {
          fetchedAt.set(f.id, this.generation)
          next.set(f.id, await this.opts.fetch(f.id))
        } catch {
          // deleted meanwhile, or no access: leave it out
        }
      }))
      if (this.disposed) return
    }
    // A file closed after its fetch started: the editor's text is newer than the fetched one (its last edits
    // may not have reached the server when it answered).
    for (const [id, r] of this.recent) {
      if (next.has(id) && r.at > (fetchedAt.get(id) ?? Infinity)) next.set(id, r.text)
    }
    this.recent.clear()
    const changed = [...next].filter(([id, t]) => this.texts.get(id) !== t).map(([id]) => id)
    const removed = [...this.texts.keys()].filter(id => !next.has(id))
    this.texts = next
    if (changed.length || removed.length) this.opts.onLoaded(changed, removed)
  }
}
