import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Manifest } from '../src/contract.ts'
import { applyRemovals, ensureLayout, ensureParents, layout, manifestDirs, mirrorDirs, planSync, scanTree } from '../src/materialize.ts'
import { openForWrite } from '../src/fsSafe.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const tmp = () => mkdtempSync(join(tmpdir(), 'ligature-mat-'))

/** What the helper does with a plan, with contents from a local table. */
async function materialise(src: string, files: Record<string, string>): Promise<{ written: string[]; removed: string[] }> {
  const manifest: Manifest = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha(c)]))
  const byHash = new Map(Object.values(files).map(c => [sha(c), c]))
  const plan = await planSync(src, manifest)
  await applyRemovals(src, plan.remove)
  const written: string[] = []
  for (const [hash, paths] of plan.needed) {
    for (const p of paths) {
      await ensureParents(src, p)
      const fh = await openForWrite(join(src, ...p.split('/')))
      await fh.writeFile(byHash.get(hash)!)
      await fh.close()
      written.push(p)
    }
  }
  return { written: written.sort(), removed: plan.remove.sort() }
}

/** Symlinks need privileges on Windows; directory junctions do not. */
function trySymlink(target: string, path: string, type: 'file' | 'dir'): boolean {
  try {
    symlinkSync(target, path, process.platform === 'win32' && type === 'dir' ? 'junction' : type)
    return true
  } catch {
    return false
  }
}

describe('materialisation', () => {
  it('writes only what changed, deletes what is gone', async () => {
    const root = tmp()
    const l = layout(root)
    await ensureLayout(l, false)

    let r = await materialise(l.src, { 'main.tex': 'M1', 'chapters/a.tex': 'A', 'chapters/b.tex': 'B', 'img/x.png': 'X' })
    expect(r.written).toEqual(['chapters/a.tex', 'chapters/b.tex', 'img/x.png', 'main.tex'])
    expect(r.removed).toEqual([])
    const mtimeA = statSync(join(l.src, 'chapters', 'a.tex')).mtimeMs

    await new Promise(res => setTimeout(res, 30))
    r = await materialise(l.src, { 'main.tex': 'M2', 'chapters/a.tex': 'A', 'img/x.png': 'X' })
    expect(r.written).toEqual(['main.tex'])
    expect(r.removed).toEqual(['chapters/b.tex'])
    expect(statSync(join(l.src, 'chapters', 'a.tex')).mtimeMs).toBe(mtimeA)
    expect(readFileSync(join(l.src, 'main.tex'), 'utf8')).toBe('M2')

    // Removing a whole folder removes it once (not each child), and stray files written by a run go too.
    writeFileSync(join(l.src, 'stray.aux'), 'junk')
    r = await materialise(l.src, { 'main.tex': 'M2' })
    expect(r.removed).toEqual(['chapters', 'img', 'stray.aux'])
    expect([...(await scanTree(l.src)).keys()]).toEqual(['main.tex'])
  })

  it('identical content at several paths is fetched once', async () => {
    const src = tmp()
    const plan = await planSync(src, { 'a.tex': sha('same'), 'b/c.tex': sha('same') })
    expect([...plan.needed.entries()]).toEqual([[sha('same'), ['a.tex', 'b/c.tex']]])
  })

  it('replaces a file with a directory and vice versa', async () => {
    const src = tmp()
    await materialise(src, { 'x': 'file', 'd/y.tex': 'Y' })
    const r = await materialise(src, { 'x/inner.tex': 'I', 'd': 'now a file' })
    expect(r.removed).toEqual(['d', 'x'])
    expect(lstatSync(join(src, 'x')).isDirectory()).toBe(true)
    expect(readFileSync(join(src, 'd'), 'utf8')).toBe('now a file')
  })

  it('a modified source (e.g. written by the TeX run) is detected by content and rewritten', async () => {
    const src = tmp()
    await materialise(src, { 'main.tex': 'orig' })
    writeFileSync(join(src, 'main.tex'), 'tampered')
    const r = await materialise(src, { 'main.tex': 'orig' })
    expect(r.written).toEqual(['main.tex'])
    expect(readFileSync(join(src, 'main.tex'), 'utf8')).toBe('orig')
  })

  it('never follows a symlinked directory: the link is removed and the target untouched', async ({ skip }) => {
    const root = tmp()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.tex'), 'SECRET')
    const src = join(root, 'src')
    mkdirSync(src)
    if (!trySymlink(outside, join(src, 'chapters'), 'dir')) return skip('cannot create directory links here')
    const r = await materialise(src, { 'chapters/secret.tex': 'mine', 'main.tex': 'M' })
    expect(r.removed).toEqual(['chapters'])
    expect(lstatSync(join(src, 'chapters')).isDirectory()).toBe(true)
    expect(lstatSync(join(src, 'chapters')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(outside, 'secret.tex'), 'utf8')).toBe('SECRET')
    expect(readFileSync(join(src, 'chapters', 'secret.tex'), 'utf8')).toBe('mine')
  })

  it('never writes through a symlinked file', async ({ skip }) => {
    const root = tmp()
    const target = join(root, 'target.txt')
    writeFileSync(target, 'TARGET')
    const src = join(root, 'src')
    mkdirSync(src)
    if (!trySymlink(target, join(src, 'main.tex'), 'file')) return skip('no symlink privilege (Windows without developer mode)')
    const plan = await planSync(src, { 'main.tex': sha('TARGET') })
    // Even though the link target has the right content, a link is never accepted as the file.
    expect(plan.remove).toEqual(['main.tex'])
    expect([...plan.needed.keys()]).toEqual([sha('TARGET')])
    await materialise(src, { 'main.tex': 'new' })
    expect(readFileSync(target, 'utf8')).toBe('TARGET')
    expect(lstatSync(join(src, 'main.tex')).isFile()).toBe(true)
    // openForWrite itself refuses a symlink at the final component.
    if (trySymlink(target, join(src, 'link.tex'), 'file')) await expect(openForWrite(join(src, 'link.tex'))).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('TARGET')
  })

  it('mirrors source directories into out/, replacing links', async () => {
    const root = tmp()
    const l = layout(root)
    await ensureLayout(l, false)
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const linked = trySymlink(outside, join(l.out, 'chapters'), 'dir')
    const m: Manifest = { 'main.tex': sha('m'), 'chapters/a.tex': sha('a'), 'chapters/deep/b.tex': sha('b'), 'img/x.png': sha('x') }
    expect([...manifestDirs(m)].sort()).toEqual(['chapters', 'chapters/deep', 'img'])
    await mirrorDirs(l.out, m)
    for (const d of ['chapters', 'chapters/deep', 'img']) {
      const st = lstatSync(join(l.out, ...d.split('/')))
      expect(st.isDirectory() && !st.isSymbolicLink()).toBe(true)
    }
    if (linked) expect(existsSync(join(outside, 'deep'))).toBe(false)
  })

  it('ensureLayout(clean) wipes out/ but keeps src/', async () => {
    const root = tmp()
    const l = layout(root)
    await ensureLayout(l, false)
    writeFileSync(join(l.out, 'output.aux'), 'x')
    writeFileSync(join(l.src, 'main.tex'), 'm')
    await ensureLayout(l, true)
    expect(existsSync(join(l.out, 'output.aux'))).toBe(false)
    expect(existsSync(join(l.src, 'main.tex'))).toBe(true)
    for (const d of [l.home, l.tmp, l.texmfVar, l.texmfConfig]) expect(statSync(d).isDirectory()).toBe(true)
  })
})
