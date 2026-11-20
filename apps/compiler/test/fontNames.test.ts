import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NAMES_DIR, seedFontNames } from '../src/fontNames.ts'

const WIN = process.platform === 'win32'
let dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ligature-fontnames-'))
  dirs.push(d)
  return d
}

/** A TEXMFSYSVAR holding a names database (and the lookup cache, which is not copied). */
function systemVar(): string {
  const sys = tmp()
  const names = join(sys, ...NAMES_DIR.split('/'))
  mkdirSync(names, { recursive: true })
  writeFileSync(join(names, 'luaotfload-names.luc.gz'), 'bytecode')
  writeFileSync(join(names, 'luaotfload-names.lua.gz'), 'source')
  writeFileSync(join(names, 'luaotfload-lookup-cache.luc'), 'lookups')
  return sys
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('seeding the luaotfload names database', () => {
  it('copies the database (not the lookup cache) into a project that has none, once', async () => {
    const sys = systemVar()
    const project = tmp()
    let asked = 0
    const ask = async () => { asked++; return sys }
    expect(await seedFontNames(project, ask)).toEqual(['luaotfload-names.lua.gz', 'luaotfload-names.luc.gz'])
    const names = join(project, ...NAMES_DIR.split('/'))
    expect(readdirSync(names).sort()).toEqual(['luaotfload-names.lua.gz', 'luaotfload-names.luc.gz'])
    expect(readFileSync(join(names, 'luaotfload-names.luc.gz'), 'utf8')).toBe('bytecode')
    // The project's own database (maybe updated by luaotfload since) is kept, and kpsewhich is not asked again.
    writeFileSync(join(names, 'luaotfload-names.luc.gz'), 'updated by the project')
    expect(await seedFontNames(project, ask)).toEqual([])
    expect(readFileSync(join(names, 'luaotfload-names.luc.gz'), 'utf8')).toBe('updated by the project')
    expect(asked).toBe(1)
  })

  it('nothing to copy: no TEXMFSYSVAR, or no database in it', async () => {
    const project = tmp()
    expect(await seedFontNames(project, async () => null)).toEqual([])
    expect(await seedFontNames(project, async () => tmp())).toEqual([])
    expect(readdirSync(project)).toEqual([])
  })

  it.skipIf(WIN)('never writes through a symlink the project planted in its cache', async () => {
    const sys = systemVar()
    const project = tmp()
    const elsewhere = tmp()
    symlinkSync(elsewhere, join(project, 'luatex-cache'))
    expect(await seedFontNames(project, async () => sys)).toHaveLength(2)
    expect(lstatSync(join(project, 'luatex-cache')).isDirectory()).toBe(true)
    expect(readdirSync(elsewhere)).toEqual([])
  })
})
