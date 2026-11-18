/**
 * Static checks of the deployment and CI configuration (docker/compose*.yaml, .github/workflows/ci.yml):
 * settings the sandbox depends on that no test on a developer machine would notice when they are lost.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(import.meta.dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8').replace(/\r\n/g, '\n')

/** Lines of a top-level block's child `name` (2-space indented key), without comments and blank lines. */
function block(text: string, name: string, indent = '  '): string[] {
  const lines = text.split('\n')
  const start = lines.indexOf(`${indent}${name}:`)
  if (start === -1) throw new Error(`no block "${name}"`)
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== '' && !l.startsWith(`${indent} `)) break
    const t = l.replace(/^\s*#.*$/, '').replace(/\s+#.*$/, '')
    if (t.trim() !== '') out.push(t.trimEnd())
  }
  return out
}

describe('docker compose: the compiler container has no world-writable directory', () => {
  // A LuaLaTeX document can leave its project with relative lfs.chdir("..") (openout_any does not stop it,
  // see test/corpus.test.ts case 4) and write wherever its uid may: the container must offer it nothing.
  for (const file of ['docker/compose.yaml', 'docker/compose.dev.yaml']) {
    it(file, () => {
      const c = block(read(file), 'compiler')
      expect(c).toContain('    read_only: true')
      expect(c, 'ipc: none (no /dev/shm)').toContain('    ipc: none')
      expect(c.some(l => /shm_size/.test(l)), 'shm_size would bring /dev/shm back').toBe(false)
      // tmpfs entries are "- /path:options" (volumes are "- name:/path")
      const tmpfs = c.filter(l => /^\s+- \//.test(l) && c.indexOf(l) > c.indexOf('    tmpfs:'))
      expect(tmpfs.length, 'a tmpfs for /tmp').toBeGreaterThan(0)
      for (const t of tmpfs) expect(t, 'every tmpfs is root-only').toMatch(/mode=0?700(,|$)/)
      expect(c).toContain('    cap_drop: [ALL]')
      expect(c).toContain('    security_opt: [no-new-privileges:true]')
    })
  }

  it('docker/compose.yaml: the compiler has no network', () => {
    expect(block(read('docker/compose.yaml'), 'compiler')).toContain('    network_mode: none')
  })
})

describe('CI workflow', () => {
  const ci = read('.github/workflows/ci.yml')

  it('pins the runner image (the TeX Live year of the test job must not change underneath the tests)', () => {
    const runsOn = [...ci.matchAll(/^\s+runs-on:\s*(\S+)/gm)].map(m => m[1])
    expect(runsOn.length).toBeGreaterThanOrEqual(3)
    for (const r of runsOn) expect(r).toMatch(/^ubuntu-\d{2}\.\d{2}$/)
  })

  it('uses checkout/setup-node versions that run on Node 24 (v5 or later)', () => {
    const uses = [...ci.matchAll(/uses:\s*actions\/(checkout|setup-node)@v(\d+)/g)]
    expect(uses.length).toBeGreaterThanOrEqual(5)
    for (const u of uses) expect(Number(u[2]), u[0]).toBeGreaterThanOrEqual(5)
  })

  it('the sandbox job runs on the same TeX Live image as the docker job, hardened like production', () => {
    const sandbox = block(ci, 'sandbox').join('\n')
    const image = /image:\s*(\S+)/.exec(sandbox)?.[1]
    const composeEnv = /^LIGATURE_TEXLIVE_IMAGE=(\S+)$/m.exec(read('scripts/ci/compose.ci.env'))?.[1]
    expect(image).toMatch(/@sha256:[0-9a-f]{64}$/)
    expect(image).toBe(composeEnv)
    expect(sandbox).toMatch(/for d in \/tmp \/var\/tmp \/dev\/shm; do\s+if \[ -d "\$d" \]; then chmod 0700 "\$d"; fi/)
    expect(sandbox).toContain("CORPUS_NO_WORLD_WRITABLE: '1'")
    expect(sandbox).toMatch(/TEXMFVAR="\$\(kpsewhich -var-value=TEXMFSYSVAR\)" luaotfload-tool --update --force/)
    expect(sandbox).toContain('bash scripts/ci/compiler-sandbox-tests.sh')
  })
})

describe('docker/Dockerfile.app', () => {
  it('copies the package.json of every workspace package before npm ci (else npm skips linking it)', () => {
    const dockerfile = read('docker/Dockerfile.app')
    const npmCi = dockerfile.indexOf('RUN npm ci')
    expect(npmCi).toBeGreaterThan(0)
    const beforeCi = dockerfile.slice(0, npmCi)
    for (const group of ['apps', 'packages']) {
      for (const name of readdirSync(join(REPO, group))) {
        if (!existsSync(join(REPO, group, name, 'package.json'))) continue
        expect(beforeCi, `${group}/${name}/package.json is not copied before npm ci`)
          .toContain(`COPY ${group}/${name}/package.json ${group}/${name}/package.json`)
      }
    }
  })

  it('ships every workspace package the server imports at runtime', () => {
    const dockerfile = read('docker/Dockerfile.app')
    expect(dockerfile).toMatch(/^COPY --from=build \/src\/packages packages$/m)
  })
})
