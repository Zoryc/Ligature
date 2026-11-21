/**
 * Shared shapes of LaTeX autocomplete (docs/AUTOCOMPLETE.md): the built-in word lists (completionData.ts),
 * the project index (projectIndex.ts) and the CodeMirror completion source (latexCompletion.ts) agree on these.
 */

/** One argument of a command or environment, in order. */
export interface ArgSpec {
  /** `{…}` (required) or `[…]` (optional). Optional arguments are not inserted by default. */
  kind: 'required' | 'optional'
  /** Shown in the placeholder, e.g. "numerator". */
  name: string
}

/** A command the editor can suggest after `\`. */
export interface CommandInfo {
  /** Without the backslash: "frac", "section", "alpha". */
  name: string
  args: ArgSpec[]
  /** Package that defines it; absent for LaTeX itself. Shown as a hint ("amsmath"). */
  pkg?: string
  /** Short description shown next to the suggestion ("fraction", "Greek letter α"). */
  detail?: string
  /** Only meaningful in math mode (suggested there first; still allowed elsewhere). */
  math?: boolean
}

/** An environment the editor can suggest after `\begin{`. */
export interface EnvironmentInfo {
  name: string
  /** Arguments after `\begin{name}`, e.g. tabular's column spec, figure's optional placement. */
  args: ArgSpec[]
  pkg?: string
  detail?: string
  /** What goes on the first line inside, e.g. "\\item " for itemize; default: an empty line. */
  body?: string
  math?: boolean
}

/** From the project's own files (projectIndex.ts). */
export interface LabelEntry {
  name: string
  fileId: string
  /** 1-based line of the \label. */
  line: number
  /** What it labels, when known: the heading title or the environment name ("figure", "equation"). */
  context?: string
}

export interface BibEntry {
  key: string
  fileId: string
  /** 1-based line of the entry's `@type{` (go to definition). */
  line: number
  /** Entry type without @: "article", "book". */
  type: string
  title?: string
  author?: string
  year?: string
}

/** A command or environment the project defines itself (\newcommand, \DeclareMathOperator, \newenvironment, ...). */
export interface UserDefinition {
  kind: 'command' | 'environment'
  /** Without the backslash. */
  name: string
  /** Number of arguments (the first optional when `optionalDefault` is set, like \newcommand{\x}[2][d]{...}). */
  argCount: number
  optionalDefault?: boolean
  fileId: string
  line: number
}
