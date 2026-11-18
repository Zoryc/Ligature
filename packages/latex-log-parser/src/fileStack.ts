/** The stack of files TeX is reading, tracked from `(name` and `)` in the log. */
import { fileNameAt } from './paths.ts'

/** Deeper than any real document; garbage logs cannot grow the stack without bound. */
const MAX_DEPTH = 2000

interface Frame {
  /** null: a parenthesis that does not open a file (e.g. "(Font)") */
  name: string | null
  /** project-relative path, or null when not a project file */
  project: string | null
}

export interface Location { path?: string; line?: number }

export class FileStack {
  private frames: Frame[] = []
  /** The first project file seen (the main file): the fallback when the stack holds no project file. */
  private main: string | null = null

  private readonly toProject: (name: string) => string | null

  constructor(toProject: (name: string) => string | null) {
    this.toProject = toProject
  }

  /** A new TeX (or BibTeX) run starts: forget the stack, keep the main file. */
  reset(): void {
    this.frames = []
  }

  /** Track every `(` and `)` of a log line that is not part of a recognised message. */
  feed(line: string): void {
    // Next `(` and `)` at or after i; each is searched again only once passed, so a line is scanned in linear time.
    let open = line.indexOf('(')
    let close = line.indexOf(')')
    let i = 0
    while (open >= 0 || close >= 0) {
      if (close >= 0 && (open < 0 || close < open)) {
        this.frames.pop()
        i = close + 1
      } else {
        const f = fileNameAt(line, open)
        if (f) {
          const project = this.toProject(f.name)
          if (project !== null) this.main ??= project
          this.push({ name: f.name, project })
          i = f.end
        } else {
          this.push({ name: null, project: null })
          i = open + 1
        }
      }
      if (open >= 0 && open < i) open = line.indexOf('(', i)
      if (close >= 0 && close < i) close = line.indexOf(')', i)
    }
  }

  private push(f: Frame): void {
    if (this.frames.length < MAX_DEPTH) this.frames.push(f)
  }

  /** The innermost file being read. */
  private topFile(): Frame | undefined {
    for (let k = this.frames.length - 1; k >= 0; k--) if (this.frames[k]!.name !== null) return this.frames[k]
    return undefined
  }

  private nearestProject(): string | null {
    for (let k = this.frames.length - 1; k >= 0; k--) {
      const p = this.frames[k]!.project
      if (p !== null) return p
    }
    return this.main
  }

  /**
   * Where a message that refers to "the current file" (and maybe a line in it) belongs: the innermost file if it
   * is a project file; otherwise the nearest project file below it, without the line (which was in another file).
   */
  current(line?: number): Location {
    const top = this.topFile()
    if (top && top.project !== null) return line === undefined ? { path: top.project } : { path: top.project, line }
    const p = this.nearestProject()
    return p === null ? {} : { path: p }
  }

  /** Location for an explicit `file:line` from the log. */
  at(name: string, line: number | undefined): Location {
    const project = this.toProject(name)
    if (project !== null) {
      this.main ??= project
      return line === undefined ? { path: project } : { path: project, line }
    }
    const p = this.nearestProject()
    return p === null ? {} : { path: p }
  }

  /** Project-relative path of a file name, or null. */
  project(name: string): string | null {
    return this.toProject(name)
  }
}
