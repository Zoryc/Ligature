/**
 * Built-in word lists of LaTeX autocomplete (docs/AUTOCOMPLETE.md): commands, environments, packages and
 * classes, plus the command names whose argument the completion source fills from the project (labels,
 * bibliography keys, files). Written for Ligature (MIT), not taken from any other project.
 *
 * Arguments are written in a compact form, `[optional]{required}` in order, parsed once at load: it reads
 * like the LaTeX it describes and keeps the tables short.
 */
import type { ArgSpec, CommandInfo, EnvironmentInfo } from './completionTypes.ts'

/** `'[short title]{title}'` → optional "short title", required "title". Throws on anything else (a typo). */
export function parseArgs(spec: string): ArgSpec[] {
  const out: ArgSpec[] = []
  const re = /\[([^\]]+)\]|\{([^}]+)\}/y
  while (re.lastIndex < spec.length) {
    const at = re.lastIndex
    const m = re.exec(spec)
    if (!m) throw new Error(`bad argument spec at ${at}: ${spec}`)
    out.push(m[1] !== undefined ? { kind: 'optional', name: m[1] } : { kind: 'required', name: m[2]! })
  }
  return out
}

/** [name without backslash, argument spec, short detail] */
type Row = readonly [name: string, args: string, detail: string]

/** A table of commands sharing a package and math flag. */
function cmds(opts: { pkg?: string; math?: boolean }, rows: readonly Row[]): CommandInfo[] {
  return rows.map(([name, args, detail]) => ({
    name,
    args: parseArgs(args),
    ...(opts.pkg ? { pkg: opts.pkg } : {}),
    detail,
    ...(opts.math ? { math: true } : {}),
  }))
}

/** Same shape for a list of symbols: no arguments. */
const syms = (opts: { pkg?: string; math?: boolean }, rows: readonly (readonly [string, string])[]) =>
  cmds(opts, rows.map(([name, detail]) => [name, '', detail] as const))

const greek = (rows: readonly (readonly [string, string])[], pkg?: string) =>
  syms({ pkg, math: true }, rows.map(([name, glyph]) => [name, `Greek letter ${glyph}`] as const))

// ---------------------------------------------------------------------------------------------------------
// Commands

const DOCUMENT = cmds({}, [
  ['documentclass', '[options]{class}', 'document class'],
  ['usepackage', '[options]{package}', 'load a package'],
  ['RequirePackage', '[options]{package}', 'load a package (in .sty/.cls)'],
  ['begin', '{environment}', 'start an environment'],
  ['end', '{environment}', 'end an environment'],
  ['input', '{file}', 'insert a file here'],
  ['include', '{file}', 'insert a file on a new page'],
  ['includeonly', '{files}', 'compile only these \\include files'],
  ['title', '{title}', 'document title'],
  ['author', '{names}', 'document authors'],
  ['date', '{date}', 'document date'],
  ['thanks', '{note}', 'footnote in the title block'],
  ['and', '', 'separates authors'],
  ['maketitle', '', 'print the title block'],
  ['today', '', 'current date'],
  ['tableofcontents', '', 'table of contents'],
  ['listoffigures', '', 'list of figures'],
  ['listoftables', '', 'list of tables'],
  ['appendix', '', 'start the appendices'],
  ['frontmatter', '', 'roman page numbers, unnumbered chapters (book)'],
  ['mainmatter', '', 'arabic page numbers (book)'],
  ['backmatter', '', 'unnumbered chapters (book)'],
  ['newcommand', '{command}[args]{definition}', 'define a command'],
  ['renewcommand', '{command}[args]{definition}', 'redefine a command'],
  ['providecommand', '{command}[args]{definition}', 'define a command unless it exists'],
  ['newenvironment', '{name}[args]{before}{after}', 'define an environment'],
  ['renewenvironment', '{name}[args]{before}{after}', 'redefine an environment'],
  ['newtheorem', '{name}[shared counter]{title}', 'define a theorem-like environment'],
  ['newcounter', '{counter}', 'define a counter'],
  ['setcounter', '{counter}{value}', 'set a counter'],
  ['addtocounter', '{counter}{amount}', 'add to a counter'],
  ['stepcounter', '{counter}', 'increment a counter'],
  ['refstepcounter', '{counter}', 'increment a counter for \\label'],
  ['value', '{counter}', 'value of a counter'],
  ['arabic', '{counter}', 'counter as 1, 2, 3'],
  ['roman', '{counter}', 'counter as i, ii, iii'],
  ['Roman', '{counter}', 'counter as I, II, III'],
  ['alph', '{counter}', 'counter as a, b, c'],
  ['Alph', '{counter}', 'counter as A, B, C'],
  ['newlength', '{length}', 'define a length'],
  ['setlength', '{length}{value}', 'set a length'],
  ['addtolength', '{length}{amount}', 'add to a length'],
  ['pagestyle', '{style}', 'page style (plain, empty, headings)'],
  ['thispagestyle', '{style}', 'style of this page only'],
  ['pagenumbering', '{style}', 'page number style (arabic, roman)'],
  ['linespread', '{factor}', 'line spacing factor'],
  ['bibliography', '{files}', 'BibTeX bibliography files'],
  ['bibliographystyle', '{style}', 'BibTeX style (plain, alpha, ...)'],
  ['bibitem', '[label]{key}', 'entry of thebibliography'],
  ['makeindex', '', 'enable the index'],
  ['index', '{entry}', 'index entry'],
  ['protect', '', 'protect a fragile command'],
  ['ensuremath', '{formula}', 'math, in or out of math mode'],
])

const SECTIONS = cmds({}, [
  ['part', '[short title]{title}', 'part heading'],
  ['chapter', '[short title]{title}', 'chapter heading (book, report)'],
  ['section', '[short title]{title}', 'section heading'],
  ['subsection', '[short title]{title}', 'subsection heading'],
  ['subsubsection', '[short title]{title}', 'subsubsection heading'],
  ['paragraph', '[short title]{title}', 'paragraph heading'],
  ['subparagraph', '[short title]{title}', 'subparagraph heading'],
  ['addcontentsline', '{file}{level}{text}', 'add a line to the table of contents'],
])

const TEXT_STYLE = cmds({}, [
  ['textbf', '{text}', 'bold'],
  ['textit', '{text}', 'italic'],
  ['emph', '{text}', 'emphasis'],
  ['texttt', '{text}', 'typewriter'],
  ['textsf', '{text}', 'sans serif'],
  ['textrm', '{text}', 'roman'],
  ['textsc', '{text}', 'small capitals'],
  ['textsl', '{text}', 'slanted'],
  ['textup', '{text}', 'upright'],
  ['textmd', '{text}', 'medium weight'],
  ['textnormal', '{text}', 'document font'],
  ['underline', '{text}', 'underline'],
  ['textsuperscript', '{text}', 'superscript text'],
  ['textsubscript', '{text}', 'subscript text'],
  ['bfseries', '', 'bold from here on'],
  ['itshape', '', 'italic from here on'],
  ['ttfamily', '', 'typewriter from here on'],
  ['sffamily', '', 'sans serif from here on'],
  ['rmfamily', '', 'roman from here on'],
  ['scshape', '', 'small capitals from here on'],
  ['slshape', '', 'slanted from here on'],
  ['upshape', '', 'upright from here on'],
  ['mdseries', '', 'medium weight from here on'],
  ['normalfont', '', 'document font from here on'],
  ['tiny', '', 'font size: tiny'],
  ['scriptsize', '', 'font size: script'],
  ['footnotesize', '', 'font size: footnote'],
  ['small', '', 'font size: small'],
  ['normalsize', '', 'font size: normal'],
  ['large', '', 'font size: large'],
  ['Large', '', 'font size: larger'],
  ['LARGE', '', 'font size: even larger'],
  ['huge', '', 'font size: huge'],
  ['Huge', '', 'font size: largest'],
])

const BOXES = cmds({}, [
  ['mbox', '{text}', 'box that never breaks'],
  ['makebox', '[width]{text}', 'box of a given width'],
  ['fbox', '{text}', 'framed box'],
  ['framebox', '[width]{text}', 'framed box of a given width'],
  ['parbox', '[position]{width}{text}', 'paragraph box'],
  ['raisebox', '{lift}{text}', 'raise or lower text'],
  ['phantom', '{content}', 'invisible, takes the space'],
  ['hphantom', '{content}', 'invisible, takes the width'],
  ['vphantom', '{content}', 'invisible, takes the height'],
])

const COLOR = cmds({ pkg: 'xcolor' }, [
  ['textcolor', '{color}{text}', 'colored text'],
  ['color', '{color}', 'color from here on'],
  ['colorbox', '{color}{text}', 'box with a background color'],
  ['fcolorbox', '{frame color}{background}{text}', 'framed colored box'],
  ['pagecolor', '{color}', 'page background color'],
  ['definecolor', '{name}{model}{values}', 'define a color (rgb, HTML, ...)'],
  ['colorlet', '{name}{color}', 'name a color expression (red!50)'],
])

const LAYOUT = cmds({}, [
  ['item', '[label]', 'list item'],
  ['centering', '', 'center from here on'],
  ['raggedright', '', 'left-aligned from here on'],
  ['raggedleft', '', 'right-aligned from here on'],
  ['noindent', '', 'no paragraph indent'],
  ['indent', '', 'paragraph indent'],
  ['par', '', 'end the paragraph'],
  ['newline', '', 'line break'],
  ['linebreak', '[priority]', 'line break, justified'],
  ['newpage', '', 'new page'],
  ['clearpage', '', 'new page, after pending floats'],
  ['cleardoublepage', '', 'new right-hand page'],
  ['pagebreak', '[priority]', 'page break'],
  ['nopagebreak', '[priority]', 'avoid a page break'],
  ['vspace', '{length}', 'vertical space'],
  ['hspace', '{length}', 'horizontal space'],
  ['vfill', '', 'stretchable vertical space'],
  ['hfill', '', 'stretchable horizontal space'],
  ['smallskip', '', 'small vertical space'],
  ['medskip', '', 'medium vertical space'],
  ['bigskip', '', 'big vertical space'],
  ['quad', '', 'space of 1em'],
  ['qquad', '', 'space of 2em'],
  ['enspace', '', 'space of 0.5em'],
  ['textwidth', '', 'length: width of the text'],
  ['linewidth', '', 'length: width of the current line'],
  ['columnwidth', '', 'length: width of a column'],
  ['textheight', '', 'length: height of the text'],
  ['paperwidth', '', 'length: paper width'],
  ['paperheight', '', 'length: paper height'],
  ['baselineskip', '', 'length: distance between lines'],
  ['parindent', '', 'length: paragraph indent'],
  ['parskip', '', 'length: space between paragraphs'],
  ['footnote', '[number]{text}', 'footnote'],
  ['footnotemark', '[number]', 'footnote mark only'],
  ['footnotetext', '[number]{text}', 'footnote text only'],
  ['marginpar', '{text}', 'margin note'],
  ['caption', '[short caption]{caption}', 'float caption'],
  ['label', '{key}', 'label for \\ref'],
  ['ref', '{key}', 'reference to a label'],
  ['pageref', '{key}', 'page of a label'],
])

const TABLES = cmds({}, [
  ['hline', '', 'horizontal rule in a table'],
  ['cline', '{columns}', 'partial rule (e.g. 2-3)'],
  ['multicolumn', '{count}{alignment}{text}', 'cell spanning columns'],
  ['tabularnewline', '', 'end a table row'],
])

const TEXT_SYMBOLS = syms({}, [
  ['ldots', 'ellipsis …'],
  ['dots', 'ellipsis …'],
  ['LaTeX', 'LaTeX logo'],
  ['TeX', 'TeX logo'],
  ['textbackslash', 'backslash \\'],
  ['textasciitilde', 'tilde ~'],
  ['textasciicircum', 'circumflex ^'],
  ['textless', 'less-than <'],
  ['textgreater', 'greater-than >'],
  ['textbar', 'vertical bar |'],
  ['textendash', 'en dash –'],
  ['textemdash', 'em dash —'],
  ['textdegree', 'degree °'],
  ['textbullet', 'bullet •'],
  ['copyright', 'copyright ©'],
  ['textregistered', 'registered ®'],
  ['texttrademark', 'trademark ™'],
  ['pounds', 'pound sign £'],
  ['S', 'section sign §'],
  ['P', 'paragraph sign ¶'],
  ['ss', 'German sharp s ß'],
  ['ae', 'ligature æ'],
  ['AE', 'ligature Æ'],
  ['oe', 'ligature œ'],
  ['OE', 'ligature Œ'],
  ['aa', 'ring å'],
  ['AA', 'ring Å'],
])

const GRAPHICX = cmds({ pkg: 'graphicx' }, [
  ['includegraphics', '[options]{file}', 'insert an image or PDF'],
  ['graphicspath', '{folders}', 'where to look for images: {{img/}}'],
  ['rotatebox', '[options]{angle}{content}', 'rotate content'],
  ['scalebox', '{factor}{content}', 'scale content'],
  ['resizebox', '{width}{height}{content}', 'resize content (! keeps ratio)'],
  ['reflectbox', '{content}', 'mirror content'],
])

const HYPERREF = cmds({ pkg: 'hyperref' }, [
  ['href', '{url}{text}', 'link with text'],
  ['url', '{url}', 'link showing the URL'],
  ['nolinkurl', '{url}', 'URL without a link'],
  ['hyperref', '[label]{text}', 'link to a label with text'],
  ['hyperlink', '{target}{text}', 'link to a \\hypertarget'],
  ['hypertarget', '{name}{text}', 'link target'],
  ['hypersetup', '{options}', 'hyperref options'],
  ['autoref', '{key}', 'reference with its type (Figure 1)'],
  ['nameref', '{key}', 'reference by title'],
  ['phantomsection', '', 'anchor for links (before \\addcontentsline)'],
  ['texorpdfstring', '{TeX}{PDF text}', 'different text in PDF bookmarks'],
])

const REFS = [
  ...cmds({ pkg: 'amsmath' }, [['eqref', '{key}', 'equation reference (1)']]),
  ...cmds({ pkg: 'cleveref' }, [
    ['cref', '{keys}', 'reference with its type (fig. 1)'],
    ['Cref', '{keys}', 'reference with its type, capitalised'],
    ['crefrange', '{first}{last}', 'range of references'],
    ['cpageref', '{keys}', 'page reference with "page"'],
    ['Cpageref', '{keys}', 'page reference, capitalised'],
    ['crefname', '{type}{singular}{plural}', 'name used by \\cref'],
  ]),
  ...cmds({ pkg: 'varioref' }, [['vref', '{key}', 'reference with page ("on the next page")']]),
]

/** natbib's two optionals: with one, it is the postnote (\citep[p.~5]{key}). */
const CITATIONS = [
  ...cmds({}, [
    ['cite', '[postnote]{keys}', 'citation'],
    ['nocite', '{keys}', 'list in the bibliography without citing'],
  ]),
  ...cmds({ pkg: 'natbib' }, [
    ['citep', '[prenote][postnote]{keys}', 'parenthetical citation (Smith, 2020)'],
    ['citet', '[prenote][postnote]{keys}', 'textual citation Smith (2020)'],
    ['Citep', '[prenote][postnote]{keys}', 'parenthetical citation, capitalised'],
    ['Citet', '[prenote][postnote]{keys}', 'textual citation, capitalised'],
    ['citealt', '[prenote][postnote]{keys}', 'textual citation without parentheses'],
    ['citealp', '[prenote][postnote]{keys}', 'parenthetical citation without parentheses'],
    ['citeauthor', '{keys}', 'author only (also biblatex)'],
    ['Citeauthor', '{keys}', 'author only, capitalised (also biblatex)'],
    ['citeyear', '{keys}', 'year only (also biblatex)'],
    ['citeyearpar', '{keys}', 'year only, in parentheses'],
  ]),
  ...cmds({ pkg: 'biblatex' }, [
    ['parencite', '[prenote][postnote]{keys}', 'citation in parentheses'],
    ['Parencite', '[prenote][postnote]{keys}', 'citation in parentheses, capitalised'],
    ['textcite', '[prenote][postnote]{keys}', 'citation in running text'],
    ['Textcite', '[prenote][postnote]{keys}', 'citation in running text, capitalised'],
    ['autocite', '[prenote][postnote]{keys}', 'citation in the style\'s default form'],
    ['Autocite', '[prenote][postnote]{keys}', 'default-form citation, capitalised'],
    ['footcite', '[prenote][postnote]{keys}', 'citation in a footnote'],
    ['smartcite', '[prenote][postnote]{keys}', 'footnote in text, plain in footnotes'],
    ['supercite', '{keys}', 'superscript citation'],
    ['fullcite', '{keys}', 'full bibliography entry in the text'],
    ['footfullcite', '{keys}', 'full entry in a footnote'],
    ['citetitle', '{keys}', 'title only'],
    ['addbibresource', '[options]{file}', 'bibliography file (.bib)'],
    ['printbibliography', '[options]', 'print the bibliography'],
  ]),
]

const AMSMATH_TEXT = cmds({ pkg: 'amsmath' }, [
  ['numberwithin', '{counter}{within}', 'number equations per section'],
  ['allowdisplaybreaks', '[level]', 'let displays break across pages'],
  ['DeclareMathOperator', '{command}{text}', 'define an operator like \\sin'],
])

const MATH_STRUCTURES = [
  ...cmds({ math: true }, [
    ['frac', '{numerator}{denominator}', 'fraction'],
    ['sqrt', '[n]{radicand}', 'square or n-th root'],
    ['overline', '{formula}', 'line over'],
    ['overbrace', '{formula}', 'brace over (^{label})'],
    ['underbrace', '{formula}', 'brace under (_{label})'],
    ['stackrel', '{above}{relation}', 'symbol over a relation'],
    ['mathrm', '{text}', 'roman letters'],
    ['mathbf', '{text}', 'bold letters'],
    ['mathit', '{text}', 'italic letters'],
    ['mathsf', '{text}', 'sans-serif letters'],
    ['mathtt', '{text}', 'typewriter letters'],
    ['mathcal', '{letters}', 'calligraphic letters'],
    ['left', '', 'auto-sized left delimiter'],
    ['right', '', 'auto-sized right delimiter'],
    ['middle', '', 'auto-sized middle delimiter'],
    ['big', '', 'bigger delimiter'],
    ['Big', '', 'bigger delimiter (2)'],
    ['bigg', '', 'bigger delimiter (3)'],
    ['Bigg', '', 'biggest delimiter'],
    ['bigl', '', 'bigger left delimiter'],
    ['bigr', '', 'bigger right delimiter'],
    ['Bigl', '', 'bigger left delimiter (2)'],
    ['Bigr', '', 'bigger right delimiter (2)'],
    ['displaystyle', '', 'display-size math'],
    ['textstyle', '', 'inline-size math'],
    ['scriptstyle', '', 'script-size math'],
    ['limits', '', 'limits above and below'],
    ['nolimits', '', 'limits at the side'],
    ['bmod', '', 'binary mod: a mod b'],
    ['pmod', '{modulus}', '(mod m)'],
    ['colon', '', 'colon for f\\colon A \\to B'],
  ]),
  ...cmds({ pkg: 'amsmath', math: true }, [
    ['dfrac', '{numerator}{denominator}', 'display-size fraction'],
    ['tfrac', '{numerator}{denominator}', 'text-size fraction'],
    ['cfrac', '{numerator}{denominator}', 'continued fraction'],
    ['binom', '{n}{k}', 'binomial coefficient'],
    ['dbinom', '{n}{k}', 'display-size binomial'],
    ['tbinom', '{n}{k}', 'text-size binomial'],
    ['text', '{text}', 'text inside math'],
    ['intertext', '{text}', 'text line between aligned rows'],
    ['operatorname', '{name}', 'operator name like \\sin'],
    ['boldsymbol', '{symbol}', 'bold symbol'],
    ['overset', '{above}{base}', 'symbol over another'],
    ['underset', '{below}{base}', 'symbol under another'],
    ['xrightarrow', '[below]{above}', 'extensible arrow →'],
    ['xleftarrow', '[below]{above}', 'extensible arrow ←'],
    ['substack', '{lines}', 'multi-line subscript (\\\\ between lines)'],
    ['boxed', '{formula}', 'framed formula'],
    ['tag', '{label}', 'custom equation number'],
    ['notag', '', 'no number for this line'],
    ['nonumber', '', 'no number for this line'],
  ]),
  ...cmds({ pkg: 'amssymb', math: true }, [
    ['mathbb', '{letters}', 'blackboard bold (ℝ, ℕ)'],
    ['mathfrak', '{letters}', 'Fraktur letters'],
  ]),
  ...cmds({ pkg: 'mathrsfs', math: true }, [['mathscr', '{letters}', 'script letters']]),
  ...cmds({ pkg: 'bm', math: true }, [['bm', '{symbol}', 'bold math symbol']]),
  ...cmds({ pkg: 'cancel', math: true }, [['cancel', '{formula}', 'strike out a term']]),
]

const MATH_ACCENTS = [
  ...cmds({ math: true }, [
    ['hat', '{x}', 'hat accent x̂'],
    ['widehat', '{formula}', 'wide hat'],
    ['tilde', '{x}', 'tilde accent x̃'],
    ['widetilde', '{formula}', 'wide tilde'],
    ['bar', '{x}', 'bar accent x̄'],
    ['vec', '{x}', 'vector arrow'],
    ['dot', '{x}', 'dot accent ẋ'],
    ['ddot', '{x}', 'double dot ẍ'],
    ['acute', '{x}', 'acute accent'],
    ['grave', '{x}', 'grave accent'],
    ['breve', '{x}', 'breve accent'],
    ['check', '{x}', 'caron accent'],
    ['mathring', '{x}', 'ring accent'],
    ['overrightarrow', '{formula}', 'arrow over, pointing right'],
    ['overleftarrow', '{formula}', 'arrow over, pointing left'],
  ]),
  ...cmds({ pkg: 'amsmath', math: true }, [['dddot', '{x}', 'triple dot']]),
]

const BIG_OPERATORS = [
  ...syms({ math: true }, [
    ['sum', 'sum ∑'],
    ['prod', 'product ∏'],
    ['coprod', 'coproduct ∐'],
    ['int', 'integral ∫'],
    ['oint', 'contour integral ∮'],
    ['bigcup', 'big union ⋃'],
    ['bigcap', 'big intersection ⋂'],
    ['bigoplus', 'big direct sum ⨁'],
    ['bigotimes', 'big tensor product ⨂'],
    ['bigvee', 'big or ⋁'],
    ['bigwedge', 'big and ⋀'],
    ['bigsqcup', 'big disjoint union ⨆'],
  ]),
  ...syms({ pkg: 'amsmath', math: true }, [
    ['iint', 'double integral ∬'],
    ['iiint', 'triple integral ∭'],
  ]),
]

const FUNCTIONS = syms({ math: true }, [
  ['lim', 'limit'],
  ['limsup', 'limit superior'],
  ['liminf', 'limit inferior'],
  ['sup', 'supremum'],
  ['inf', 'infimum'],
  ['max', 'maximum'],
  ['min', 'minimum'],
  ['arg', 'argument'],
  ['det', 'determinant'],
  ['dim', 'dimension'],
  ['ker', 'kernel'],
  ['hom', 'homomorphisms'],
  ['deg', 'degree'],
  ['gcd', 'greatest common divisor'],
  ['Pr', 'probability'],
  ['exp', 'exponential'],
  ['log', 'logarithm'],
  ['ln', 'natural logarithm'],
  ['lg', 'binary logarithm'],
  ['sin', 'sine'],
  ['cos', 'cosine'],
  ['tan', 'tangent'],
  ['cot', 'cotangent'],
  ['sec', 'secant'],
  ['csc', 'cosecant'],
  ['arcsin', 'arcsine'],
  ['arccos', 'arccosine'],
  ['arctan', 'arctangent'],
  ['sinh', 'hyperbolic sine'],
  ['cosh', 'hyperbolic cosine'],
  ['tanh', 'hyperbolic tangent'],
  ['coth', 'hyperbolic cotangent'],
])

const GREEK = [
  ...greek([
    ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ϵ'], ['varepsilon', 'ε'],
    ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['vartheta', 'ϑ'], ['iota', 'ι'], ['kappa', 'κ'],
    ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['pi', 'π'], ['varpi', 'ϖ'], ['rho', 'ρ'],
    ['varrho', 'ϱ'], ['sigma', 'σ'], ['varsigma', 'ς'], ['tau', 'τ'], ['upsilon', 'υ'], ['phi', 'ϕ'],
    ['varphi', 'φ'], ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω'],
    ['Gamma', 'Γ'], ['Delta', 'Δ'], ['Theta', 'Θ'], ['Lambda', 'Λ'], ['Xi', 'Ξ'], ['Pi', 'Π'],
    ['Sigma', 'Σ'], ['Upsilon', 'Υ'], ['Phi', 'Φ'], ['Psi', 'Ψ'], ['Omega', 'Ω'],
  ]),
  ...greek([['varkappa', 'ϰ'], ['digamma', 'ϝ']], 'amssymb'),
]

const BINARY_OPERATORS = syms({ math: true }, [
  ['pm', 'plus-minus ±'],
  ['mp', 'minus-plus ∓'],
  ['times', 'times ×'],
  ['div', 'division ÷'],
  ['cdot', 'centered dot ⋅'],
  ['ast', 'asterisk ∗'],
  ['star', 'star ⋆'],
  ['circ', 'composition ∘'],
  ['bullet', 'bullet ∙'],
  ['oplus', 'direct sum ⊕'],
  ['ominus', 'circled minus ⊖'],
  ['otimes', 'tensor product ⊗'],
  ['oslash', 'circled slash ⊘'],
  ['odot', 'circled dot ⊙'],
  ['cap', 'intersection ∩'],
  ['cup', 'union ∪'],
  ['sqcup', 'disjoint union ⊔'],
  ['uplus', 'multiset union ⊎'],
  ['setminus', 'set difference ∖'],
  ['wedge', 'logical and ∧'],
  ['vee', 'logical or ∨'],
  ['dagger', 'dagger †'],
])

const RELATIONS = [
  ...syms({ math: true }, [
    ['leq', 'less or equal ≤'],
    ['geq', 'greater or equal ≥'],
    ['neq', 'not equal ≠'],
    ['ll', 'much less ≪'],
    ['gg', 'much greater ≫'],
    ['approx', 'approximately ≈'],
    ['sim', 'similar ∼'],
    ['simeq', 'similar or equal ≃'],
    ['cong', 'congruent ≅'],
    ['equiv', 'equivalent ≡'],
    ['propto', 'proportional ∝'],
    ['doteq', 'approaches ≐'],
    ['asymp', 'asymptotic ≍'],
    ['prec', 'precedes ≺'],
    ['succ', 'succeeds ≻'],
    ['preceq', 'precedes or equal ⪯'],
    ['succeq', 'succeeds or equal ⪰'],
    ['subset', 'subset ⊂'],
    ['supset', 'superset ⊃'],
    ['subseteq', 'subset or equal ⊆'],
    ['supseteq', 'superset or equal ⊇'],
    ['in', 'element of ∈'],
    ['notin', 'not an element of ∉'],
    ['ni', 'contains ∋'],
    ['mid', 'divides ∣'],
    ['parallel', 'parallel ∥'],
    ['perp', 'perpendicular ⊥'],
    ['vdash', 'proves ⊢'],
    ['models', 'models ⊨'],
    ['not', 'negate the next relation'],
  ]),
  ...syms({ pkg: 'amssymb', math: true }, [
    ['leqslant', 'less or equal ⩽'],
    ['geqslant', 'greater or equal ⩾'],
    ['lesssim', 'less or similar ≲'],
    ['gtrsim', 'greater or similar ≳'],
    ['subsetneq', 'proper subset ⊊'],
    ['supsetneq', 'proper superset ⊋'],
    ['nmid', 'does not divide ∤'],
    ['triangleq', 'defined as ≜'],
  ]),
  ...syms({ pkg: 'mathtools', math: true }, [['coloneqq', 'defined as ≔']]),
]

const ARROWS = [
  ...syms({ math: true }, [
    ['to', 'arrow →'],
    ['gets', 'arrow ←'],
    ['rightarrow', 'right arrow →'],
    ['leftarrow', 'left arrow ←'],
    ['leftrightarrow', 'left-right arrow ↔'],
    ['Rightarrow', 'implies ⇒'],
    ['Leftarrow', 'is implied by ⇐'],
    ['Leftrightarrow', 'if and only if ⇔'],
    ['longrightarrow', 'long right arrow ⟶'],
    ['longleftarrow', 'long left arrow ⟵'],
    ['longleftrightarrow', 'long left-right arrow ⟷'],
    ['Longrightarrow', 'long implies ⟹'],
    ['Longleftarrow', 'long is implied by ⟸'],
    ['Longleftrightarrow', 'long if and only if ⟺'],
    ['iff', 'if and only if ⟺ (spaced)'],
    ['mapsto', 'maps to ↦'],
    ['longmapsto', 'long maps to ⟼'],
    ['uparrow', 'up arrow ↑'],
    ['downarrow', 'down arrow ↓'],
    ['updownarrow', 'up-down arrow ↕'],
    ['Uparrow', 'double up arrow ⇑'],
    ['Downarrow', 'double down arrow ⇓'],
    ['nearrow', 'north-east arrow ↗'],
    ['searrow', 'south-east arrow ↘'],
    ['swarrow', 'south-west arrow ↙'],
    ['nwarrow', 'north-west arrow ↖'],
    ['hookrightarrow', 'injection ↪'],
    ['hookleftarrow', 'hook left arrow ↩'],
    ['rightharpoonup', 'harpoon ⇀'],
    ['rightleftharpoons', 'equilibrium ⇌'],
  ]),
  ...syms({ pkg: 'amsmath', math: true }, [
    ['implies', 'implies ⟹ (spaced)'],
    ['impliedby', 'is implied by ⟸ (spaced)'],
  ]),
  ...syms({ pkg: 'amssymb', math: true }, [
    ['twoheadrightarrow', 'surjection ↠'],
    ['rightsquigarrow', 'squiggly arrow ⇝'],
  ]),
]

const MATH_SYMBOLS = [
  ...syms({ math: true }, [
    ['infty', 'infinity ∞'],
    ['partial', 'partial derivative ∂'],
    ['nabla', 'nabla ∇'],
    ['forall', 'for all ∀'],
    ['exists', 'there exists ∃'],
    ['emptyset', 'empty set ∅'],
    ['neg', 'not ¬'],
    ['angle', 'angle ∠'],
    ['triangle', 'triangle △'],
    ['ell', 'script l ℓ'],
    ['hbar', 'h-bar ℏ'],
    ['Re', 'real part ℜ'],
    ['Im', 'imaginary part ℑ'],
    ['aleph', 'aleph ℵ'],
    ['wp', 'Weierstrass p ℘'],
    ['prime', 'prime ′'],
    ['top', 'top ⊤'],
    ['bot', 'bottom ⊥'],
    ['cdots', 'centered dots ⋯'],
    ['vdots', 'vertical dots ⋮'],
    ['ddots', 'diagonal dots ⋱'],
  ]),
  ...syms({ pkg: 'amssymb', math: true }, [
    ['nexists', 'there is no ∄'],
    ['varnothing', 'empty set ∅'],
    ['hslash', 'h-slash ℏ'],
    ['therefore', 'therefore ∴'],
    ['because', 'because ∵'],
    ['square', 'square □'],
    ['blacksquare', 'filled square ■'],
  ]),
]

const DELIMITERS = [
  ...syms({ math: true }, [
    ['langle', 'left angle ⟨'],
    ['rangle', 'right angle ⟩'],
    ['lfloor', 'left floor ⌊'],
    ['rfloor', 'right floor ⌋'],
    ['lceil', 'left ceiling ⌈'],
    ['rceil', 'right ceiling ⌉'],
    ['lbrace', 'left brace {'],
    ['rbrace', 'right brace }'],
    ['vert', 'vertical bar |'],
    ['Vert', 'double vertical bar ‖'],
    ['backslash', 'backslash \\'],
  ]),
  ...syms({ pkg: 'amsmath', math: true }, [
    ['lvert', 'left bar |'],
    ['rvert', 'right bar |'],
    ['lVert', 'left double bar ‖'],
    ['rVert', 'right double bar ‖'],
  ]),
]

const BOOKTABS = cmds({ pkg: 'booktabs' }, [
  ['toprule', '[thickness]', 'top rule of a table'],
  ['midrule', '[thickness]', 'rule below the header'],
  ['bottomrule', '[thickness]', 'bottom rule of a table'],
  ['cmidrule', '{columns}', 'partial rule (e.g. 2-3; (lr) trims)'],
  ['addlinespace', '[space]', 'extra space between rows'],
  ['specialrule', '{thickness}{space above}{space below}', 'rule of any thickness'],
])

const SIUNITX = cmds({ pkg: 'siunitx' }, [
  ['SI', '[options]{value}{unit}', 'quantity with unit (v2; \\qty in v3)'],
  ['si', '[options]{unit}', 'unit (v2; \\unit in v3)'],
  ['qty', '[options]{value}{unit}', 'quantity with unit'],
  ['unit', '[options]{unit}', 'unit only'],
  ['num', '[options]{number}', 'formatted number'],
  ['ang', '[options]{angle}', 'angle in degrees'],
  ['qtyrange', '[options]{from}{to}{unit}', 'range of quantities'],
  ['SIrange', '[options]{from}{to}{unit}', 'range of quantities (v2)'],
  ['numrange', '[options]{from}{to}', 'range of numbers'],
  ['sisetup', '{options}', 'siunitx settings'],
])

/** TikZ path commands end with `;` and take their coordinates inline: only the options are an argument. */
const TIKZ = cmds({ pkg: 'tikz' }, [
  ['tikz', '[options]{commands}', 'inline TikZ picture'],
  ['draw', '[options]', 'draw a path'],
  ['fill', '[options]', 'fill a path'],
  ['filldraw', '[options]', 'fill and draw a path'],
  ['path', '[options]', 'path, neither drawn nor filled'],
  ['node', '[options]', 'node: (name) at (x,y) {text};'],
  ['coordinate', '[options]', 'named coordinate'],
  ['clip', '[options]', 'clip to a path'],
  ['foreach', '', 'loop: \\foreach \\x in {1,...,5}'],
  ['usetikzlibrary', '{libraries}', 'load TikZ libraries'],
  ['tikzset', '{styles}', 'define TikZ styles'],
])

const BEAMER = cmds({ pkg: 'beamer' }, [
  ['frametitle', '{title}', 'title of a frame'],
  ['framesubtitle', '{subtitle}', 'subtitle of a frame'],
  ['titlepage', '', 'title frame content'],
  ['usetheme', '{theme}', 'presentation theme'],
  ['usecolortheme', '{theme}', 'color theme'],
  ['usefonttheme', '{theme}', 'font theme'],
  ['institute', '{institution}', 'author affiliation'],
  ['pause', '', 'reveal the rest on the next slide'],
  ['alert', '{text}', 'highlighted text'],
  ['only', '{content}', 'content on some slides only (<2->)'],
  ['uncover', '{content}', 'reveal content on some slides'],
  ['onslide', '', 'following content on some slides'],
  ['visible', '{content}', 'visible on some slides'],
  ['invisible', '{content}', 'invisible on some slides'],
  ['setbeamertemplate', '{element}{template}', 'change a beamer template'],
  ['setbeamercolor', '{element}{colors}', 'change a beamer color'],
])

const OTHER_PACKAGES = [
  ...cmds({ pkg: 'geometry' }, [
    ['geometry', '{options}', 'page layout'],
    ['newgeometry', '{options}', 'page layout from here on'],
  ]),
  ...cmds({ pkg: 'caption' }, [['captionof', '{type}[short caption]{caption}', 'caption outside a float']]),
  ...cmds({ pkg: 'multirow' }, [['multirow', '{rows}{width}{text}', 'cell spanning rows (* for natural width)']]),
  ...cmds({ pkg: 'subfiles' }, [['subfile', '{file}', 'include a compilable part']]),
  ...cmds({ pkg: 'makeidx' }, [['printindex', '', 'print the index']]),
  ...cmds({ pkg: 'fancyhdr' }, [
    ['fancyhead', '[position]{text}', 'header text (L, C, R)'],
    ['fancyfoot', '[position]{text}', 'footer text (L, C, R)'],
    ['fancyhf', '{text}', 'clear or set header and footer'],
  ]),
  ...cmds({ pkg: 'listings' }, [
    ['lstinputlisting', '[options]{file}', 'code listing from a file'],
    ['lstset', '{options}', 'listings settings'],
  ]),
  ...cmds({ pkg: 'lipsum' }, [['lipsum', '[paragraphs]', 'placeholder text']]),
  ...cmds({ pkg: 'todonotes' }, [['todo', '[options]{text}', 'to-do note in the margin']]),
  ...cmds({ pkg: 'setspace' }, [
    ['onehalfspacing', '', 'line spacing 1.5'],
    ['doublespacing', '', 'double line spacing'],
    ['singlespacing', '', 'single line spacing'],
  ]),
]

export const COMMANDS: CommandInfo[] = [
  ...DOCUMENT, ...SECTIONS, ...TEXT_STYLE, ...BOXES, ...COLOR, ...LAYOUT, ...TABLES, ...TEXT_SYMBOLS,
  ...GRAPHICX, ...HYPERREF, ...REFS, ...CITATIONS, ...AMSMATH_TEXT,
  ...MATH_STRUCTURES, ...MATH_ACCENTS, ...BIG_OPERATORS, ...FUNCTIONS, ...GREEK, ...BINARY_OPERATORS,
  ...RELATIONS, ...ARROWS, ...MATH_SYMBOLS, ...DELIMITERS,
  ...BOOKTABS, ...SIUNITX, ...TIKZ, ...BEAMER, ...OTHER_PACKAGES,
]

/**
 * The most used commands, most frequent first: a ranking hint for the completion source (CommandInfo has no
 * frequency field). Anything not listed ranks after these.
 */
export const COMMON_COMMANDS: readonly string[] = [
  'section', 'subsection', 'textbf', 'emph', 'label', 'ref', 'cite', 'begin', 'end', 'item', 'frac',
  'textit', 'includegraphics', 'caption', 'usepackage', 'centering', 'subsubsection', 'eqref', 'footnote',
  'mathbf', 'mathrm', 'alpha', 'left', 'right', 'sum', 'int', 'sqrt', 'texttt', 'hline', 'chapter', 'cref',
  'text', 'mathbb', 'cdot', 'leq', 'geq', 'infty', 'url', 'href', 'vspace', 'hspace', 'newcommand', 'title',
  'author', 'maketitle', 'documentclass', 'input', 'citep', 'citet', 'textcite', 'parencite',
]

// ---------------------------------------------------------------------------------------------------------
// Environments

interface EnvOpts { pkg?: string; body?: string; math?: boolean }
type EnvRow = readonly [name: string, args: string, detail: string, opts?: EnvOpts]

function envs(defaults: EnvOpts, rows: readonly EnvRow[]): EnvironmentInfo[] {
  return rows.map(([name, args, detail, own]) => {
    const o = { ...defaults, ...own }
    return {
      name,
      args: parseArgs(args),
      ...(o.pkg ? { pkg: o.pkg } : {}),
      detail,
      ...(o.body !== undefined ? { body: o.body } : {}),
      ...(o.math ? { math: true } : {}),
    }
  })
}

const ITEM = { body: '\\item ' }

/**
 * `math: true` marks environments used *inside* math (cases, matrices, split): like CommandInfo.math, they
 * are suggested first there. Display environments (equation, align, ...) start math from text, so they are
 * not marked; DISPLAY_MATH_ENVIRONMENTS lists them for math-mode detection instead.
 */
export const ENVIRONMENTS: EnvironmentInfo[] = [
  ...envs({}, [
    ['document', '', 'document body'],
    ['abstract', '', 'abstract'],
    ['titlepage', '', 'separate title page'],
    ['itemize', '', 'bulleted list', ITEM],
    ['enumerate', '', 'numbered list', ITEM],
    ['description', '', 'list of terms (\\item[term])', { body: '\\item[term] ' }],
    ['figure', '[placement]', 'floating figure (h, t, b, p, !)'],
    ['figure*', '[placement]', 'figure across both columns'],
    ['table', '[placement]', 'floating table (h, t, b, p, !)'],
    ['table*', '[placement]', 'table across both columns'],
    ['tabular', '[position]{columns}', 'table (l c r p{width} |)'],
    ['tabular*', '{width}[position]{columns}', 'table of a given width'],
    ['array', '[position]{columns}', 'table inside math', { math: true }],
    ['tabbing', '', 'tab stops (\\= \\>)'],
    ['center', '', 'centered lines'],
    ['flushleft', '', 'left-aligned lines'],
    ['flushright', '', 'right-aligned lines'],
    ['quote', '', 'short quotation'],
    ['quotation', '', 'long quotation'],
    ['verse', '', 'poetry'],
    ['verbatim', '', 'text exactly as typed'],
    ['minipage', '[position]{width}', 'box with paragraphs'],
    ['thebibliography', '{widest label}', 'manual bibliography', { body: '\\bibitem{key} ' }],
    ['displaymath', '', 'unnumbered display math'],
    ['math', '', 'inline math'],
  ]),
  ...envs({ pkg: 'amsmath' }, [
    ['equation', '', 'numbered equation'],
    ['equation*', '', 'unnumbered equation'],
    ['align', '', 'aligned equations (& and \\\\)'],
    ['align*', '', 'aligned equations, unnumbered'],
    ['gather', '', 'centered equations'],
    ['gather*', '', 'centered equations, unnumbered'],
    ['multline', '', 'one long equation over lines'],
    ['multline*', '', 'long equation, unnumbered'],
    ['flalign', '', 'equations aligned to the margins'],
    ['flalign*', '', 'margin-aligned, unnumbered'],
    ['alignat', '{column pairs}', 'aligned with explicit spacing'],
    ['alignat*', '{column pairs}', 'alignat, unnumbered'],
    ['subequations', '', 'number equations 1a, 1b'],
    ['split', '', 'one equation split over lines', { math: true }],
    ['aligned', '[position]', 'aligned block inside math', { math: true }],
    ['alignedat', '[position]{column pairs}', 'alignedat block inside math', { math: true }],
    ['gathered', '[position]', 'centered block inside math', { math: true }],
    ['cases', '', 'cases with a brace (value & condition)', { math: true }],
    ['matrix', '', 'matrix without delimiters', { math: true }],
    ['pmatrix', '', 'matrix in ( )', { math: true }],
    ['bmatrix', '', 'matrix in [ ]', { math: true }],
    ['Bmatrix', '', 'matrix in { }', { math: true }],
    ['vmatrix', '', 'determinant | |', { math: true }],
    ['Vmatrix', '', 'norm ‖ ‖', { math: true }],
    ['smallmatrix', '', 'inline-size matrix', { math: true }],
  ]),
  ...envs({ pkg: 'mathtools' }, [
    ['dcases', '', 'cases in display style', { math: true }],
    ['pmatrix*', '[alignment]', 'pmatrix with column alignment', { math: true }],
  ]),
  ...envs({ pkg: 'amsthm' }, [
    ['proof', '[title]', 'proof with ∎'],
  ]),
  // Theorem-like: each needs a \newtheorem{name}{Title} in the preamble (amsthm or plain LaTeX).
  ...envs({}, [
    ['theorem', '[name]', 'theorem (needs \\newtheorem)'],
    ['lemma', '[name]', 'lemma (needs \\newtheorem)'],
    ['proposition', '[name]', 'proposition (needs \\newtheorem)'],
    ['corollary', '[name]', 'corollary (needs \\newtheorem)'],
    ['definition', '[name]', 'definition (needs \\newtheorem)'],
    ['remark', '[name]', 'remark (needs \\newtheorem)'],
    ['example', '[name]', 'example (needs \\newtheorem)'],
  ]),
  ...envs({}, [
    ['tabularx', '{width}{columns}', 'table of a given width (X columns)', { pkg: 'tabularx' }],
    ['longtable', '[alignment]{columns}', 'table across pages', { pkg: 'longtable' }],
    ['threeparttable', '', 'table with notes', { pkg: 'threeparttable' }],
    ['subfigure', '[position]{width}', 'sub-figure with its own caption', { pkg: 'subcaption' }],
    ['subtable', '[position]{width}', 'sub-table with its own caption', { pkg: 'subcaption' }],
    ['wrapfigure', '{placement}{width}', 'figure with text around it (r, l)', { pkg: 'wrapfig' }],
    ['multicols', '{columns}', 'text in columns', { pkg: 'multicol' }],
    ['landscape', '', 'landscape pages', { pkg: 'pdflscape' }],
    ['lstlisting', '[options]', 'code listing', { pkg: 'listings' }],
    ['minted', '[options]{language}', 'highlighted code (needs -shell-escape)', { pkg: 'minted' }],
    ['comment', '', 'ignored text', { pkg: 'comment' }],
    ['tikzpicture', '[options]', 'TikZ drawing', { pkg: 'tikz' }],
    ['scope', '[options]', 'TikZ scope with shared options', { pkg: 'tikz' }],
    ['axis', '[options]', 'pgfplots axis (\\addplot)', { pkg: 'pgfplots' }],
    ['tcolorbox', '[options]', 'colored box', { pkg: 'tcolorbox' }],
    ['framed', '', 'framed text across pages', { pkg: 'framed' }],
    ['algorithm', '[placement]', 'floating algorithm', { pkg: 'algorithm' }],
    ['algorithmic', '[numbering]', 'pseudocode (\\State)', { pkg: 'algpseudocode', body: '\\State ' }],
  ]),
  ...envs({ pkg: 'beamer' }, [
    ['frame', '[options]{title}', 'beamer slide'],
    ['block', '{title}', 'beamer block'],
    ['alertblock', '{title}', 'highlighted beamer block'],
    ['exampleblock', '{title}', 'example beamer block'],
    ['columns', '[options]', 'beamer columns (\\column)'],
    ['column', '{width}', 'one beamer column'],
  ]),
]

/** Environments whose body is display math: typing inside them is math mode. */
export const DISPLAY_MATH_ENVIRONMENTS: readonly string[] = [
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'flalign', 'flalign*', 'alignat', 'alignat*', 'displaymath', 'math',
]

// ---------------------------------------------------------------------------------------------------------
// Packages and classes

export const PACKAGES: string[] = [
  // math
  'amsmath', 'amssymb', 'amsthm', 'amsfonts', 'mathtools', 'bm', 'mathrsfs', 'esint', 'cancel', 'physics',
  'braket', 'nicefrac', 'xfrac', 'mathdots', 'upgreek', 'dsfont', 'bbm', 'stmaryrd', 'empheq', 'breqn',
  'unicode-math', 'siunitx', 'gensymb', 'tensor', 'amscd', 'tikz-cd', 'mhchem', 'chemfig',
  // graphics and floats
  'graphicx', 'xcolor', 'tikz', 'pgfplots', 'pgfplotstable', 'circuitikz', 'forest', 'float', 'wrapfig',
  'caption', 'subcaption', 'placeins', 'afterpage', 'rotating', 'pdflscape', 'adjustbox', 'overpic', 'svg',
  'transparent', 'eso-pic', 'background', 'draftwatermark', 'pdfpages', 'epstopdf', 'standalone',
  // tables
  'booktabs', 'tabularx', 'longtable', 'multirow', 'array', 'colortbl', 'threeparttable', 'makecell',
  'diagbox', 'dcolumn', 'hhline', 'arydshln', 'csvsimple',
  // references, links, bibliography
  'hyperref', 'cleveref', 'varioref', 'nameref', 'bookmark', 'url', 'xurl', 'biblatex', 'natbib', 'cite',
  'apacite', 'csquotes', 'xr', 'xr-hyperref', 'glossaries', 'acronym', 'nomencl', 'makeidx', 'imakeidx',
  // layout
  'geometry', 'fancyhdr', 'titlesec', 'titletoc', 'tocloft', 'tocbibind', 'titling', 'authblk', 'abstract',
  'setspace', 'parskip', 'enumitem', 'paralist', 'multicol', 'ragged2e', 'changepage', 'needspace',
  'footmisc', 'lastpage', 'emptypage', 'appendix', 'epigraph', 'lettrine', 'quoting', 'showframe', 'layout',
  // fonts and languages
  'fontenc', 'inputenc', 'fontspec', 'lmodern', 'microtype', 'babel', 'polyglossia', 'textcomp',
  'newtxtext', 'newtxmath', 'mathptmx', 'mathpazo', 'helvet', 'courier', 'libertine', 'libertinus',
  'charter', 'kpfonts', 'fourier', 'inconsolata', 'beramono', 'fontawesome5', 'marvosym', 'wasysym',
  'eurosym', 'newunicodechar', 'hyphenat',
  // code and text tools
  'listings', 'minted', 'fancyvrb', 'verbatim', 'comment', 'algorithm', 'algpseudocode', 'algorithmicx',
  'algorithm2e', 'tcolorbox', 'mdframed', 'framed', 'soul', 'ulem', 'xspace', 'todonotes', 'changes',
  'lipsum', 'blindtext', 'subfiles', 'import', 'datetime2', 'chngcntr',
  // programming
  'etoolbox', 'xparse', 'ifthen', 'calc', 'xstring', 'keyval', 'kvoptions', 'iftex', 'ifpdf', 'luacode',
  'datatool', 'graphics', 'beamerarticle',
]

/** \documentclass{…} suggestions: the spec's ten first, then a few other common ones. */
export const CLASSES: string[] = [
  'article', 'report', 'book', 'memoir', 'beamer', 'letter', 'scrartcl', 'scrreprt', 'scrbook', 'amsart',
  'amsbook', 'standalone', 'IEEEtran', 'llncs', 'revtex4-2', 'extarticle', 'scrlttr2', 'moderncv',
]

// ---------------------------------------------------------------------------------------------------------
// Commands whose argument the completion source fills from the project (names without the backslash)

export const REF_COMMANDS: readonly string[] = [
  'ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'Cref', 'vref', 'cpageref', 'Cpageref',
]

export const CITE_COMMANDS: readonly string[] = [
  'cite', 'nocite', 'citep', 'citet', 'Citep', 'Citet', 'citealt', 'citealp', 'citeauthor', 'Citeauthor',
  'citeyear', 'citeyearpar', 'parencite', 'Parencite', 'textcite', 'Textcite', 'autocite', 'Autocite',
  'footcite', 'smartcite', 'supercite', 'fullcite', 'footfullcite', 'citetitle',
]

export const INPUT_COMMANDS: readonly string[] = ['input', 'include', 'subfile']

export const GRAPHICS_COMMANDS: readonly string[] = ['includegraphics']

export const PACKAGE_COMMANDS: readonly string[] = ['usepackage', 'RequirePackage']
