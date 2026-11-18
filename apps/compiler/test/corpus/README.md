# Malicious-TeX corpus

The cases of [docs/M1.md §8](../../../../docs/M1.md#8-malicious-tex-corpus-must-fail-safely), run by
[`../corpus.test.ts`](../corpus.test.ts) through the real worker (HTTP API, real `latexmk`). One directory
per case; each holds the files of one project (two for case 2, two builds for case 10). Files are templates:
`@NAME@` placeholders (secret paths, `BUILDS_DIR`, another project's id, ...) are filled in by the test
(`corpus.ts`), and every project also gets [`probe.tex`](probe.tex) (`\tryread{label}{path}` logs
`CORPUS-PROBE label: refused|READ` without printing what it read).

"Fails safely" is checked after every case: the worker answers `/healthz`, nothing appeared in a
world-writable directory (like `/tmp`) or directly in `BUILDS_DIR`, and no planted secret (a world-readable
file, a root-only file, another project's source, decoys, the first line of `/etc/passwd` and, as root,
`/etc/shadow`) appears in the log, the PDF (including inflated streams) or the SyncTeX file. The victim
project's own PDF is the positive control of that check. At the end the victim still compiles.

| # | Case | Engine | Expected |
|---|---|---|---|
| 1 | `\openin`/`\input` of a root-only file; of `/etc/passwd` and a world-readable file (absolute, `../`) | pdflatex | root-only: refused, `failure` (uid sandbox). World-readable: refused by `openin_any=p` before TeX Live 2026; since 2026 a **known gap** (see below) |
| 2 | `\openin`/`\input` of another project's `src/`, `out/`, the blob cache | pdflatex | refused (0700 dirs of another uid / root); `failure` |
| 3 | `\write18{touch ...}`, `\input|"cmd"` | pdflatex | nothing runs (`shell_escape=f`), log says `runsystem(...)...disabled` |
| 4 | Lua `os.execute`, `io.popen`, `os.spawn`, `os.exec`; `io.open` writes and reads; `require("socket")`; climbing out with relative `lfs.chdir("..")`, then `io.open`/`lfs.mkdir` | lualatex | nothing runs, no socket, no write outside; reads of root-only files, other projects, the blob cache, `/proc/<worker>/environ`, listing `BUILDS_DIR`: refused (uid only). Climbing: refused where the project uid may not write (a worker directory, another project; uid only) and in `/tmp`, `/var/tmp`, `/dev/shm` when they are not world-writable (as in production); a world-writable directory is a **known gap** (see below) |
| 5 | `\openout` to `../../evil.tex`, an absolute path in a world-writable dir, another project's `src/` (pdflatex and lualatex); `\openout` after climbing out with `lfs.chdir("..")` (lualatex) | pdflatex, lualatex | refused (`openout_any=p`); after climbing, nothing lands outside (`-output-directory` puts relative names in `out/`) |
| 6 | `\def\x{\x}\x` | pdflatex | `timeout` (5 s), process group killed, no stray process, project usable right after |
| 7 | 2 000 000 `\message` lines (`CORPUS_FLOOD_LINES`) | pdflatex | reported log ≤ 2 MB + notices, worker healthy |
| 8 | a 110 MiB uncompressed stream object | lualatex | PDF over the 100 MB cap discarded with a note, `404` on fetch |
| 9 | Lua fork bomb; `\loop` writing 20 000 files | lualatex / pdflatex | 0 processes started; file limit (3000 in the test) stops the build, files deleted |
| 10 | symlinks planted in `out/` (`output.pdf` → `/etc/shadow`, `output.synctex.gz` → a blob, `out/chapters` → the blob cache), then a normal build | lualatex, pdflatex | never reported, never served, targets unchanged |
| 11 | `latexmkrc` / `.latexmkrc` with Perl code | pdflatex | not executed (`-norc`) |
| 12 | hostile main-file names (`names.json`) | - | `200 failure` before anything is spawned (project dir not even created), or `400` |

## Modes

`CORPUS_NO_WORLD_WRITABLE=1` (set by the CI `sandbox` job, which first makes `/tmp`, `/var/tmp` and `/dev/shm`
0700 like the production container): a climbing write into one of them fails the run. Without it, on a host
whose `/tmp` is world-writable as usual, that write is reported as a known gap.

- `SANDBOX=uid` (CI job `sandbox`, Linux, root): every check runs; missing prerequisites fail.
  `scripts/ci/compiler-sandbox-tests.sh` (or, in `apps/compiler`, `sudo -E env "PATH=$PATH" SANDBOX=uid ../../node_modules/.bin/vitest run test/corpus.test.ts`).
- `SANDBOX=none` (default; any OS, normal user; CI job `test` on Linux): only TeX's own restrictions and the
  worker's limits. Skipped, with the reason in the test name: Lua reads (case 4) and writing through a planted
  link (case 10, second build), which only the OS boundary prevents; with TeX Live 2026 or later also the
  root-only file of case 1 and case 2 (kpathsea no longer restricts reading, see below); case 10 when symlinks
  cannot be created (Windows without the privilege).

## Known gaps

**TeX Live 2026's kpathsea ignores `openin_any` for reading.** Its `kpathsea_name_ok` returns true for every
read ("no one seems to have any requirement for restricted reading"); `openin_any=p` now restricts nothing but
writes (`openout_any`). The test detects this with `kpsewhich -safe-in-name=/etc/passwd`. Older TeX Live
(e.g. Ubuntu's 2023, used by the CI `test` job) still refuses absolute and `../` reads.

Together with Lua's `io.open` (never restricted by kpathsea), this means that in the uid sandbox a document
can **read world-readable files of the compiler container** (`/etc/passwd`, TeX Live itself, the worker's
sources) and typeset them into its own PDF. Files of other projects (0700, another uid), the blob cache and
output store (root 0700) and anything not world-readable stay out of reach, and the compiler image holds no
secrets, so nothing private leaks. The corpus reports these as `KNOWN GAP` (a warning, a GitHub annotation in
CI; `CORPUS_STRICT=1` makes them fail). Closing them needs a private mount namespace (gVisor `runsc`, bwrap).

**LuaTeX: relative `lfs.chdir("..")`.** LuaTeX refuses absolute paths and `../` in `io.open`, `lfs.chdir`,
`lfs.mkdir` (`openout_any=p`), but not `lfs.chdir("..")` itself; later relative names are checked against the new
working directory. A document can therefore walk to `/` and back down into any directory it can enter, and create
files there **wherever its uid may write**. In the uid sandbox that is only world-writable directories, so the
production compiler container has none: read-only root filesystem, `/tmp` a root-only (0700) tmpfs, `ipc: none`
(no `/dev/shm`) — see `docker/compose.yaml`, checked by `../deployConfig.test.ts`. With `SANDBOX=none` (development)
a document can write anywhere the developer can. Closing it inside TeX would need `lualatex --safer` or a Lua
start-up wrapper (worker change, not done in M1).
