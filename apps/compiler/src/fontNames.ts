/**
 * Seeding a project's LuaTeX cache with the installation's luaotfload font-names database.
 *
 * luaotfload reads its names database only from the FIRST WRITABLE directory of TEXMFCACHE (kpathsea's default is
 * "$TEXMFSYSVAR;$TEXMFVAR"). For a project uid that is the project's own TEXMFVAR, so the database the compiler
 * image builds into TEXMFSYSVAR (docker/Dockerfile.compiler) is never found, and each project's first LuaLaTeX
 * compile spends ~10 s rebuilding it ("Font names database not found, generating new one"). Copying the image's
 * database into the project's cache before that first compile avoids it; the other luaotfload caches (font
 * tables) are already read from TEXMFSYSVAR. The copy is the project's own: luaotfload may update it (e.g. when
 * a font is missing) without touching the image, and wiping the project's caches simply copies it again.
 * Runs in the helper, as the project's uid.
 */
import { execFile } from 'node:child_process'
import { readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCode, openForWrite, openRegular } from './fsSafe.ts'
import { ensureParents } from './materialize.ts'

/** Where luaotfload keeps the database under a TEXMF var tree. */
export const NAMES_DIR = 'luatex-cache/generic/names'
/** The database proper (bytecode .luc and/or source .lua, gzipped or not); not the per-run lookup cache. */
const NAMES_FILE_RE = /^luaotfload-names\.lu[ac](?:\.gz)?$/

async function namesFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(n => NAMES_FILE_RE.test(n)).sort()
  } catch (e) {
    const c = errnoCode(e)
    if (c === 'ENOENT' || c === 'ENOTDIR') return []
    throw e
  }
}

/** Copy a regular file without following symlinks, via a temporary name: a killed copy never looks complete. */
async function copyFileSafely(from: string, to: string): Promise<boolean> {
  const src = await openRegular(from)
  if (!src) return false
  const tmp = `${to}.tmp`
  try {
    const out = await openForWrite(tmp)
    try {
      for await (const chunk of src.fh.createReadStream({ autoClose: false })) await out.write(chunk as Buffer)
    } finally {
      await out.close()
    }
    await rename(tmp, to)
    return true
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  } finally {
    await src.fh.close()
  }
}

/**
 * Copy the database files from TEXMFSYSVAR (asked for only when needed) into the project's `texmfVar`, unless
 * the project already has a database. Returns the names of the files copied.
 */
export async function seedFontNames(texmfVar: string, systemVar: () => Promise<string | null>): Promise<string[]> {
  const dest = join(texmfVar, ...NAMES_DIR.split('/'))
  if ((await namesFiles(dest)).length > 0) return []
  const sys = await systemVar()
  if (sys === null) return []
  const src = join(sys, ...NAMES_DIR.split('/'))
  const files = await namesFiles(src)
  if (files.length === 0) return []
  // The project uid can write its TEXMFVAR (a Lua script could plant symlinks there): never pass through one.
  await ensureParents(texmfVar, `${NAMES_DIR}/x`)
  const copied: string[] = []
  for (const f of files) if (await copyFileSafely(join(src, f), join(dest, f))) copied.push(f)
  return copied
}

/** TEXMFSYSVAR of the TeX installation on PATH, or null (no kpsewhich, or no value). */
export function systemTexmfVar(env: Record<string, string>): Promise<string | null> {
  return new Promise(resolve => {
    execFile('kpsewhich', ['-var-value=TEXMFSYSVAR'], { env, timeout: 10_000, windowsHide: true }, (err, stdout) => {
      const v = err ? '' : String(stdout).trim()
      resolve(v === '' ? null : v)
    })
  })
}
