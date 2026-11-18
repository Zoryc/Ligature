/**
 * With CI=true, tests that would otherwise skip themselves for lack of TeX, symlinks, root, ... must not
 * skip silently: this file fails loudly instead. Skipped entirely outside CI.
 *   test job (normal user, SANDBOX unset): realTex.test.ts, the corpus (SANDBOX=none) and the symlink /
 *     O_NOFOLLOW tests need latexmk and a POSIX file system;
 *   sandbox job (root, SANDBOX=uid): uidSandbox.test.ts and the corpus additionally need Linux, root, prlimit.
 */
import { spawnSync } from 'node:child_process'
import { constants, mkdtempSync, readlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const IN_CI = process.env.CI === 'true' || process.env.CI === '1'
const UID = process.env.SANDBOX === 'uid'
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const runs = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0

describe.skipIf(!IN_CI)('CI prerequisites (nothing may skip silently in CI)', () => {
  it('latexmk is installed (real-TeX tests and the malicious-TeX corpus)', () => {
    expect(runs('latexmk', ['-v']), 'latexmk -v failed: install TeX Live (apt: latexmk texlive-...)').toBe(true)
    expect(runs('lualatex', ['--version']), 'lualatex missing (corpus cases 4, 8, 9, 10)').toBe(true)
  })

  it.skipIf(process.platform === 'win32')('symlinks and O_NOFOLLOW work (materialize and storage tests)', () => {
    expect(constants.O_NOFOLLOW, 'O_NOFOLLOW').toBeGreaterThan(0)
    const d = mkdtempSync(join(tmpdir(), 'ligature-ci-'))
    symlinkSync('/nonexistent-target', join(d, 'link'))
    expect(readlinkSync(join(d, 'link'))).toBe('/nonexistent-target')
  })

  it.skipIf(UID)('the SANDBOX=none suite does not run as root (the compile helper refuses root)', () => {
    expect(IS_ROOT, 'run `npm test` as a normal user; root-only tests run with SANDBOX=uid (scripts/ci/compiler-sandbox-tests.sh)').toBe(false)
  })

  it.skipIf(!UID)('SANDBOX=uid: Linux, root, prlimit', () => {
    expect(process.platform).toBe('linux')
    expect(IS_ROOT, 'SANDBOX=uid tests must run as root: sudo -E env "PATH=$PATH" ...').toBe(true)
    expect(runs('prlimit', ['--version']), 'prlimit (util-linux) missing').toBe(true)
  })
})
