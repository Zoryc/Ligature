/**
 * Helpers for the malicious-TeX corpus (docs/M1.md §8, test/corpus.test.ts).
 *
 * Each case directory holds the files of one project (or of several, in sub-directories). Files are
 * templates: `@NAME@` placeholders are replaced with paths of the run (secret files, the builds dir,
 * another project's id, ...) before upload. Every project also gets `probe.tex` (\tryread).
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

export const CORPUS_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Forward slashes: TeX and Lua want them, also on Windows. */
export const fwd = (p: string) => p.replace(/\\/g, '/')

/** All files below `dir` as project paths ('/'-separated) -> contents, with placeholders substituted. */
export function loadProject(dir: string, vars: Record<string, string>): Record<string, string> {
  const abs = join(CORPUS_DIR, dir)
  const files: Record<string, string> = {}
  for (const e of readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue
    const rel = fwd(relative(abs, join(e.parentPath, e.name)))
    files[rel] = substitute(readFileSync(join(e.parentPath, e.name), 'utf8'), vars)
  }
  files['probe.tex'] ??= readFileSync(join(CORPUS_DIR, 'probe.tex'), 'utf8')
  return files
}

export function substitute(text: string, vars: Record<string, string>): string {
  const out = text.replace(/@([A-Z0-9_]+)@/g, (m, name: string) => {
    const v = vars[name]
    if (v === undefined) throw new Error(`corpus: no value for placeholder ${m}`)
    return v
  })
  return out
}

/** `CORPUS-PROBE <label>: <first word of the result>` lines of a log. */
export function probes(log: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const m of log.matchAll(/CORPUS-PROBE ([^:\r\n]+): (\S+)/g)) found.set(m[1]!.trim(), m[2]!)
  return found
}

/**
 * Raw bytes plus every inflatable stream of a PDF, as latin1 text (for "does X appear in the PDF"), plus the
 * text of every TJ array with its kerns removed: `[(ro)-27(ot:x)]TJ` also yields `root:x`, so typeset text
 * that kerning split into pieces (e.g. a line of /etc/passwd) is still found.
 */
export function pdfText(pdf: Buffer): string {
  const parts = [pdf.toString('latin1')]
  const s = parts[0]!
  for (let i = s.indexOf('stream'); i !== -1; i = s.indexOf('stream', i + 6)) {
    let start = i + 6
    if (s[start] === '\r') start++
    if (s[start] === '\n') start++
    const end = s.indexOf('endstream', start)
    if (end === -1) break
    try {
      const content = inflateSync(pdf.subarray(start, end)).toString('latin1')
      parts.push(content, tjText(content))
    } catch { /* not deflated */ }
    i = end
  }
  return parts.join('\n')
}

/** The strings of a content stream's TJ arrays and Tj operators, unescaped and joined without the kerns between them. */
export function tjText(content: string): string {
  const str = /\(((?:\\[\s\S]|[^\\)])*)\)/g
  const unescape = (t: string) => t.replace(/\\([0-7]{1,3}|[\s\S])/g, (_, e: string) =>
    /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e)
  const out: string[] = []
  for (const m of content.matchAll(/\[((?:\((?:\\[\s\S]|[^\\)])*\)|[^\]])*)\]\s*TJ|(\((?:\\[\s\S]|[^\\)])*\))\s*Tj/g)) {
    const body = m[1] ?? m[2] ?? ''
    out.push([...body.matchAll(str)].map(x => unescape(x[1] ?? '')).join(''))
  }
  return out.join('')
}

export interface ProcInfo { pid: number; uid: number | null; cmd: string }

/** Processes on this machine (best effort, used to look for strays). */
export function listProcesses(): ProcInfo[] {
  if (process.platform === 'linux') {
    const out: ProcInfo[] = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const cmd = readFileSync(`/proc/${name}/cmdline`, 'latin1').replace(/\0/g, ' ').trim()
        const status = readFileSync(`/proc/${name}/status`, 'latin1')
        const uid = /^Uid:\s+(\d+)/m.exec(status)
        out.push({ pid: Number(name), uid: uid ? Number(uid[1]) : null, cmd: cmd || safeReadlink(`/proc/${name}/exe`) })
      } catch { /* exited meanwhile */ }
    }
    return out
  }
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true })
    return (r.stdout ?? '').split(/\r?\n/).filter(Boolean).map(line => {
      const tab = line.indexOf('\t')
      return { pid: Number(line.slice(0, tab)), uid: null, cmd: line.slice(tab + 1) }
    })
  }
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,uid=,command='], { encoding: 'utf8' })
  return (r.stdout ?? '').split('\n').filter(Boolean).map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return { pid: Number(m?.[1]), uid: Number(m?.[2]), cmd: m?.[3] ?? '' }
  })
}

function safeReadlink(p: string): string {
  try { return readlinkSync(p) } catch { return '' }
}

/** Processes whose command line mentions `needle` (e.g. a project id: latexmk's -outdir contains it), or run as `uid`. */
export function strayProcesses(needle: string, uid?: number): ProcInfo[] {
  return listProcesses().filter(p => p.pid !== process.pid &&
    (p.cmd.includes(needle) || (uid !== undefined && p.uid === uid)) &&
    !/Get-CimInstance|powershell/i.test(p.cmd))
}
