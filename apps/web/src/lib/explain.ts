/**
 * Plain-language explanations of common LaTeX problems, with a one-click fix where one is safe:
 * loading a missing package. Shown under the problem's line in the editor (Folio design).
 */

export interface QuickFix {
  kind: 'usepackage'
  pkg: string
  /** Button text, e.g. "Add \usepackage{siunitx}". */
  label: string
}

export interface Explanation {
  /** One or two sentences: what it means and what to do. */
  text: string
  fix?: QuickFix
}

/** Commands that need a package (the common ones; LaTeX itself never tells you which). */
const COMMAND_PACKAGES: Record<string, string> = {
  SI: 'siunitx', si: 'siunitx', qty: 'siunitx', unit: 'siunitx', num: 'siunitx', ang: 'siunitx', qtyrange: 'siunitx',
  includegraphics: 'graphicx', graphicspath: 'graphicx', rotatebox: 'graphicx', scalebox: 'graphicx', resizebox: 'graphicx',
  url: 'url',
  href: 'hyperref', autoref: 'hyperref', hypersetup: 'hyperref', nameref: 'hyperref', phantomsection: 'hyperref',
  cref: 'cleveref', Cref: 'cleveref', crefrange: 'cleveref',
  textcolor: 'xcolor', color: 'xcolor', colorbox: 'xcolor', definecolor: 'xcolor', rowcolor: 'xcolor',
  mathbb: 'amssymb', mathfrak: 'amssymb', varnothing: 'amssymb', leqslant: 'amssymb', geqslant: 'amssymb',
  therefore: 'amssymb', because: 'amssymb', square: 'amssymb', blacksquare: 'amssymb',
  text: 'amsmath', eqref: 'amsmath', dfrac: 'amsmath', tfrac: 'amsmath', binom: 'amsmath', operatorname: 'amsmath',
  DeclareMathOperator: 'amsmath', intertext: 'amsmath', boxed: 'amsmath', iint: 'amsmath', iiint: 'amsmath',
  numberwithin: 'amsmath', tag: 'amsmath', xrightarrow: 'amsmath', xleftarrow: 'amsmath', overset: 'amsmath', underset: 'amsmath',
  mathscr: 'mathrsfs',
  bm: 'bm',
  toprule: 'booktabs', midrule: 'booktabs', bottomrule: 'booktabs', cmidrule: 'booktabs', addlinespace: 'booktabs',
  multirow: 'multirow',
  lipsum: 'lipsum',
  blindtext: 'blindtext',
  todo: 'todonotes', listoftodos: 'todonotes',
  subcaption: 'subcaption', subcaptionbox: 'subcaption',
  captionsetup: 'caption',
  lstinline: 'listings', lstset: 'listings', lstinputlisting: 'listings',
  mintinline: 'minted', inputminted: 'minted',
  SetKwFunction: 'algorithm2e',
  geometry: 'geometry', newgeometry: 'geometry',
  setmainfont: 'fontspec', setsansfont: 'fontspec', setmonofont: 'fontspec', fontspec: 'fontspec',
  tikz: 'tikz', usetikzlibrary: 'tikz',
  ce: 'mhchem',
  printbibliography: 'biblatex', addbibresource: 'biblatex', textcite: 'biblatex', parencite: 'biblatex', autocite: 'biblatex',
  citet: 'natbib', citep: 'natbib', citeauthor: 'natbib', citeyear: 'natbib',
  enquote: 'csquotes',
  ul: 'soul', hl: 'soul', st: 'soul',
  uline: 'ulem', sout: 'ulem',
  doublespacing: 'setspace', onehalfspacing: 'setspace', singlespacing: 'setspace',
  fancyhead: 'fancyhdr', fancyfoot: 'fancyhdr', fancyhf: 'fancyhdr',
  titleformat: 'titlesec', titlespacing: 'titlesec',
  checkmark: 'amssymb',
  degree: 'gensymb', celsius: 'gensymb',
  euro: 'eurosym',
  FloatBarrier: 'placeins',
  newcolumntype: 'array',
  arraybackslash: 'array',
  justifying: 'ragged2e', RaggedRight: 'ragged2e',
  makecell: 'makecell',
  tabularx: 'tabularx',
  ding: 'pifont',
  nicefrac: 'nicefrac',
  xspace: 'xspace',
  ifthenelse: 'ifthen',
  sisetup: 'siunitx',
}

/** Environments that need a package. */
const ENVIRONMENT_PACKAGES: Record<string, string> = {
  align: 'amsmath', 'align*': 'amsmath', gather: 'amsmath', 'gather*': 'amsmath', multline: 'amsmath', 'multline*': 'amsmath',
  flalign: 'amsmath', split: 'amsmath', aligned: 'amsmath', cases: 'amsmath', pmatrix: 'amsmath', bmatrix: 'amsmath',
  vmatrix: 'amsmath', Bmatrix: 'amsmath', Vmatrix: 'amsmath', matrix: 'amsmath', smallmatrix: 'amsmath', subequations: 'amsmath',
  proof: 'amsthm',
  tikzpicture: 'tikz',
  axis: 'pgfplots',
  lstlisting: 'listings',
  minted: 'minted',
  algorithm: 'algorithm', algorithmic: 'algorithmic',
  subfigure: 'subcaption', subtable: 'subcaption',
  tabularx: 'tabularx',
  longtable: 'longtable',
  landscape: 'pdflscape',
  multicols: 'multicol', 'multicols*': 'multicol',
  wrapfigure: 'wrapfig',
  comment: 'comment',
  spacing: 'setspace', doublespace: 'setspace', onehalfspace: 'setspace',
  tcolorbox: 'tcolorbox',
  mdframed: 'mdframed',
  framed: 'framed',
  appendices: 'appendix',
  CJK: 'CJK',
}

function usepackage(pkg: string): QuickFix {
  return { kind: 'usepackage', pkg, label: `Add \\usepackage{${pkg}}` }
}

/** Explain one diagnostic; null when we have nothing more useful to say than its message. */
export function explain(d: { message: string; kind?: string; severity?: string }, mainFileName = 'the main file'): Explanation | null {
  const m = d.message
  let r: RegExpExecArray | null

  if ((r = /^Undefined control sequence (\\[A-Za-z@]+)/.exec(m))) {
    const cs = r[1] ?? ''
    const pkg = COMMAND_PACKAGES[cs.slice(1)]
    if (pkg) {
      return { text: `${cs} comes from the ${pkg} package, and the preamble in ${mainFileName} does not load it.`, fix: usepackage(pkg) }
    }
    return { text: `LaTeX does not know ${cs}. Check the spelling, or load the package that defines it (with \\usepackage in the preamble).` }
  }
  if (/^Undefined control sequence/.test(m)) {
    return { text: 'LaTeX met a command it does not know on this line. Check the spelling, or load the package that defines it.' }
  }
  if ((r = /^Environment (\S+) undefined/.exec(m))) {
    const env = r[1] ?? ''
    const pkg = ENVIRONMENT_PACKAGES[env]
    if (pkg) return { text: `The ${env} environment comes from the ${pkg} package, and the preamble in ${mainFileName} does not load it.`, fix: usepackage(pkg) }
    return { text: `LaTeX does not know the ${env} environment. Check the spelling in \\begin{${env}}, or load the package that defines it.` }
  }
  if ((r = /^File `([^']+)\.sty' not found/.exec(m))) {
    return { text: `The package ${r[1]} is not installed on this server, or its name is misspelled. If it is your own .sty file, upload it to the project.` }
  }
  if ((r = /^File `([^']+)' not found/.exec(m))) {
    return { text: `${r[1]} is not in the project. Upload it, or check the path (paths are relative to the main file's folder).` }
  }
  if (/^Missing \$ inserted/.test(m)) {
    return { text: 'A math-only symbol (such as _, ^ or \\alpha) is used outside math. Put it between $ … $, or escape it (\\_) if you meant the character.' }
  }
  if (/^Missing \} inserted|^Extra \}, or forgotten/.test(m)) {
    return { text: 'The braces { } on this line do not pair up. Look for a missing or an extra brace.' }
  }
  if ((r = /^Paragraph ended before (\\\S+) was complete/.exec(m))) {
    return { text: `The argument of ${r[1]} runs into a blank line, usually because a closing brace } is missing.` }
  }
  if (/^Misplaced alignment tab character &/.test(m)) {
    return { text: '& only works inside a table or an aligned environment. Write \\& for an ampersand in text.' }
  }
  if ((r = /^\\begin\{(\S+)\} on input line \d+ ended by \\end\{(\S+)\}/.exec(m))) {
    return { text: `\\begin{${r[1]}} is closed by \\end{${r[2]}}. Check that every \\begin has its matching \\end, in order.` }
  }
  if ((r = /^Reference `([^']+)' on page \d+ undefined/.exec(m))) {
    return { text: `No \\label{${r[1]}} exists, or it is new and needs one more compile. Check the label's spelling.` }
  }
  if ((r = /^Citation `([^']+)' on page \d+ undefined/.exec(m))) {
    return { text: `The key ${r[1]} is not in the bibliography (.bib) file, or the bibliography has not been built yet. Check the key's spelling.` }
  }
  if ((r = /^Label `([^']+)' multiply defined/.exec(m))) {
    return { text: `Two \\label{${r[1]}} exist; references will point to the last one. Rename one of them.` }
  }
  if ((r = /^Overfull \\hbox \(([\d.]+)pt too wide\)/.exec(m))) {
    return { text: `A line sticks ${Number(r[1]).toFixed(1)} pt into the margin, often a long word, URL or formula LaTeX cannot break. Rephrase, or allow a break (\\-).` }
  }
  if (/^Underfull \\hbox/.test(m)) {
    return { text: 'A line is stretched more than LaTeX likes (often caused by \\\\ or \\newline after a paragraph). Usually harmless.' }
  }
  if (/^Emergency stop/.test(m) && /no legal \\end found/.test(m)) {
    return { text: 'The document ended without \\end{document}.' }
  }
  if (/^Too many \}'s/.test(m)) {
    return { text: 'There is a closing brace } without an opening one on this line.' }
  }
  if (/^Font shape .* undefined/.test(m)) {
    return { text: 'This font has no such shape (e.g. bold small caps); LaTeX used the closest one instead. Usually harmless.' }
  }
  return null
}

/**
 * Where to add `\usepackage{pkg}` in a preamble: after the last \usepackage line before \begin{document}
 * (or after \documentclass). null when the package is already loaded or there is no \begin{document}.
 */
export function usepackageInsertion(text: string, pkg: string): { at: number; insert: string } | null {
  const begin = /^[^%\n]*\\begin\s*\{document\}/m.exec(text)
  if (!begin) return null
  const preamble = text.slice(0, begin.index)
  const loaded = /^[^%\n]*\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/gm
  let last: RegExpExecArray | null = null
  for (let r = loaded.exec(preamble); r; r = loaded.exec(preamble)) {
    if ((r[1] ?? '').split(',').map(s => s.trim()).includes(pkg)) return null
    last = r
  }
  const anchor = last ?? /^[^%\n]*\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/m.exec(preamble)
  const line = `\\usepackage{${pkg}}`
  if (!anchor) return { at: begin.index, insert: `${line}\n` }
  const end = text.indexOf('\n', anchor.index + anchor[0].length)
  return end === -1 ? { at: text.length, insert: `\n${line}` } : { at: end + 1, insert: `${line}\n` }
}
