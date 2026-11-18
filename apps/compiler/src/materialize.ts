/**
 * Materialising a manifest into a project's source directory. Runs inside the sandbox helper
 * (as the project's uid), never in the root worker.
 *
 * Project directory layout (BUILDS_DIR/<projectId>/):
 *   src/          sources, exactly the manifest (latexmk's cwd)
 *   out/          latexmk -outdir; mirrors src's directory tree so \include{chapters/x} can write chapters/x.aux
 *   .home/ .tmp/ .texmf-var/ .texmf-config/   HOME, TMPDIR, TEXMFVAR, TEXMFCONFIG for the run
 *
 * Rules: write only files whose content changed (keeps mtimes, so latexmk stays incremental), delete
 * everything not in the manifest, never follow a symlink (symlinks and other special files are deleted).
 */
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Manifest } from './contract.ts'
import { errnoCode, hashRegularFile } from './fsSafe.ts'

export interface Layout { root: string; src: string; out: string; home: string; tmp: string; texmfVar: string; texmfConfig: string }

export function layout(root: string): Layout {
  return {
    root,
    src: join(root, 'src'),
    out: join(root, 'out'),
    home: join(root, '.home'),
    tmp: join(root, '.tmp'),
    texmfVar: join(root, '.texmf-var'),
    texmfConfig: join(root, '.texmf-config'),
  }
}

export type EntryKind = 'file' | 'dir' | 'other'

/** Scans deeper than this are not trusted; the whole subtree is treated as junk. */
const MAX_SCAN_DEPTH = 64

/** Walk `dir` without following symlinks. Keys are '/'-separated paths relative to `dir`. */
export async function scanTree(dir: string): Promise<Map<string, EntryKind>> {
  const found = new Map<string, EntryKind>()
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true })
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth >= MAX_SCAN_DEPTH) { found.set(r, 'other'); continue }
        found.set(r, 'dir')
        await walk(join(abs, e.name), r, depth + 1)
      } else if (e.isFile()) {
        found.set(r, 'file')
      } else {
        found.set(r, 'other') // symlink, fifo, socket, device...
      }
    }
  }
  await walk(dir, '', 0)
  return found
}

/** All directories implied by the manifest's file paths ("a/b/c.tex" -> "a", "a/b"). */
export function manifestDirs(manifest: Manifest): Set<string> {
  const dirs = new Set<string>()
  for (const path of Object.keys(manifest)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return dirs
}

export interface SyncPlan {
  /** Paths (relative to src) to delete recursively; never contains a descendant of another entry. */
  remove: string[]
  /** hash -> paths that must be (re)written with that content */
  needed: Map<string, string[]>
  /** number of manifest files already up to date */
  unchanged: number
}

/** sha256 of the regular file at `rel` under `src`, or null if it is not one. */
export type HashOf = (src: string, rel: string) => Promise<string | null>

const hashByReading: HashOf = (src, rel) => hashRegularFile(join(src, ...rel.split('/')))

/**
 * Compare the source dir with the manifest. Pure read; nothing is modified.
 * `hashOf` lets the helper answer from its per-project hash cache (hashCache.ts) instead of re-reading every file.
 */
export async function planSync(src: string, manifest: Manifest, hashOf: HashOf = hashByReading): Promise<SyncPlan> {
  const existing = await scanTree(src)
  const wantDirs = manifestDirs(manifest)
  const remove: string[] = []
  const removed = new Set<string>()
  const underRemoved = (p: string): boolean => {
    for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) if (removed.has(p.slice(0, i))) return true
    return false
  }
  // Map iteration follows insertion order, which for scanTree is parents before children.
  for (const [p, kind] of existing) {
    if (underRemoved(p)) continue
    const keep = kind === 'file' ? Object.hasOwn(manifest, p) : kind === 'dir' ? wantDirs.has(p) : false
    if (!keep) { remove.push(p); removed.add(p) }
  }
  const needed = new Map<string, string[]>()
  let unchanged = 0
  for (const [p, hash] of Object.entries(manifest)) {
    if (existing.get(p) === 'file' && !removed.has(p) && (await hashOf(src, p)) === hash) {
      unchanged++
      continue
    }
    const list = needed.get(hash)
    if (list) list.push(p)
    else needed.set(hash, [p])
  }
  return { remove, needed, unchanged }
}

export async function applyRemovals(src: string, remove: readonly string[]): Promise<void> {
  // fs.rm never follows symlinks: a link is unlinked, not its target.
  for (const p of remove) await rm(join(src, ...p.split('/')), { recursive: true, force: true })
}

/** Make `abs` a real directory: anything else in its place (file, symlink, ...) is deleted first. */
export async function ensureRealDir(abs: string): Promise<void> {
  try {
    const st = await lstat(abs)
    if (st.isDirectory()) return
    await rm(abs, { recursive: true, force: true })
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') throw e
  }
  await mkdir(abs, { mode: 0o700 })
}

/** Create the parent directories of `rel` under `base`, one level at a time, refusing to pass through symlinks. */
export async function ensureParents(base: string, rel: string): Promise<void> {
  const parts = rel.split('/')
  let cur = base
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]!)
    await ensureRealDir(cur)
  }
}

/** Mirror the manifest's directory tree into out/ (latexmk -outdir does not always create subdirectories). */
export async function mirrorDirs(out: string, manifest: Manifest): Promise<void> {
  await ensureRealDir(out)
  const dirs = [...manifestDirs(manifest)].sort((a, b) => a.split('/').length - b.split('/').length)
  for (const d of dirs) await ensureRealDir(join(out, ...d.split('/')))
}

/** Create the project's working directories (replacing anything that is not a real directory). */
export async function ensureLayout(l: Layout, clean: boolean): Promise<void> {
  if (clean) await rm(l.out, { recursive: true, force: true })
  for (const d of [l.src, l.out, l.home, l.tmp, l.texmfVar, l.texmfConfig]) await ensureRealDir(d)
}
