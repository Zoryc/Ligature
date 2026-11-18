# @ligature/compiler

The compile worker: a small Node HTTP service that turns a project manifest into a PDF with
`latexmk`, inside a sandbox. It implements the contract in
[`packages/shared/src/compile.ts`](../../packages/shared/src/compile.ts); the app talks to it with
[`apps/server/src/compile/compilerClient.ts`](../server/src/compile/compilerClient.ts).
Design background: [PLAN section 6](../../docs/PLAN.md#6-compile-service-and-sandbox).

Plain `node:http`, **no runtime dependencies**, run directly from TypeScript by Node's type stripping
(only erasable syntax is used: no enums, namespaces or parameter properties).

## How it works

```
app ──HTTP over unix socket──▶ worker (root in prod) ──pipes, framed──▶ helper (project uid) ──▶ latexmk
                                 │ .blobs/  (sha256 cache)               │ BUILDS_DIR/<projectId>/src, out/, ...
                                 │ .outputs/<projectId>/ (latest pdf/log/synctex)
```

| Endpoint | |
|---|---|
| `GET /healthz` | `200 {"ok":true,"sandbox":"uid"}` |
| `POST /projects/:id/sync` | `{manifest}` → `{missing}`: the hashes the blob cache lacks |
| `PUT /blobs/:sha256` | raw bytes → `204`; the body must hash to `:sha256` (else `400 hash-mismatch`), max 100 MB |
| `POST /projects/:id/compile` | `CompileRequest` → `CompileResponse`; `409 {missing}` if a blob was never uploaded |
| `GET /projects/:id/output/:name` | `output.pdf`, `output.log` or `output.synctex.gz` of the latest build, else `404` |

Validation, before anything touches the disk: project ids must be lowercase UUIDs; hashes 64 lowercase
hex; manifest paths pass `isValidRelPath` (no `..`, absolute paths, backslashes, control characters, …;
a local copy of the shared function, kept in sync by `test/contract.test.ts`) and no path may be both a
file and a folder; unknown fields are rejected; JSON bodies ≤ 10 MB, ≤ 20 000 manifest entries;
`timeoutMs` in [1 s, 300 s].

**Main file.** latexmk runs `pdflatex %O "%S"` as one string through `/bin/sh`, where `$(…)`, backticks
and `$VAR` still expand inside the double quotes, and TeX treats `%` as a comment and a leading `&` as a
format on its command line. So each segment of `mainFile` must match `[\p{L}\p{N}_][\p{L}\p{N}_ .+,=@-]*`
(letters and digits of any script, space, `_ . + , = @ -`; never starting with `-`, `.` or a space),
it must end in `.tex`, and it must be in the manifest. A main file that breaks these rules is the user's
mistake, not a malformed request: the worker answers `200` with `status: "failure"`, no outputs, and a
log line that says what to fix (nothing is run; the previous build's outputs are withdrawn).

**A compile**, serialised per project:

1. The worker checks every manifest hash is in its blob cache (`BUILDS_DIR/.blobs`).
2. The sandbox prepares `BUILDS_DIR/<projectId>/` (for `uid`: root creates it, `chmod 0700`, `chown` to the
   project uid; this is the only thing root ever does with a project path).
3. The worker spawns the **helper** (`src/helper.ts`) under the sandbox's identity and speaks a small
   framed protocol with it over stdin/stdout (`src/framing.ts`, `src/protocol.ts`):
   `job` → `need {hashes}` → `blob` + data … → `blobs-done` → `result` → `output` + data … → `done`.
   Frames are `type:u8 length:u32be payload`; CONTROL frames carry JSON, DATA frames ≤ 1 MiB of bytes.
4. The helper materialises `src/` exactly as the manifest (`src/materialize.ts`): files whose content
   already matches are left alone (mtimes kept, so latexmk stays incremental), everything else is
   deleted, symlinks and special files are never followed, only removed; source folders are mirrored
   into `out/` so `\include{chapters/x}` works with `-outdir`. Whether a file "already matches" comes
   from a per-project hash cache (`.src-hashes.json`, `src/hashCache.ts`) keyed on size, mtime, ctime
   and inode, so unchanged sources (e.g. hundreds of MB of images) are not re-read on every compile. A
   write by the TeX run changes the ctime, which cannot be set back, so such a file is still detected and
   restored; `clean: true` ignores the cache.
5. It runs, in `src/` with `HOME`, `TMPDIR`, `TEXMFVAR`, `TEXMFCONFIG` inside the project dir,
   `TEXMFHOME=/nonexistent`, `TEXMFOUTPUT=<project>/out`, `openin_any=p`, `openout_any=p`, `shell_escape=f`:

   ```
   [prlimit …] latexmk -norc -pdf|-pdfxe|-pdflua -interaction=nonstopmode -file-line-error -synctex=1
               -jobname=output -outdir=<project>/out <mainFile>
   ```
   `-norc` keeps a `latexmkrc` in the project (Perl, i.e. arbitrary code) from being executed.
   `-outdir` is absolute so that a project may have its own folder named `out`.
   On timeout the whole process group gets `SIGKILL`.

   **Disk quota** (`src/diskUsage.ts`): while latexmk runs, the helper re-measures the project directory
   every 2 s (less often for huge trees); everything except the manifest's sources counts. Over
   `PROJECT_DISK_QUOTA_MB` (or `PROJECT_MAX_FILES` entries) the run is killed, `out/`, `HOME`, `TMPDIR`
   and the TeX caches are wiped, and the build is a `failure` that says so. A final check after the run
   catches what was written between two polls. This bounds a runaway build to roughly the quota plus
   2 s of writing; for a hard limit put the `builds` volume on its own size-limited filesystem.
6. Status: `success` = exit 0 and a PDF exists; `timeout`; `error` = latexmk could not be started, the
   helper failed, or the build volume has less than `BUILDS_MIN_FREE_MB` free; otherwise `failure`.
   After a failed run, a PDF/SyncTeX file left over from an earlier build is not reported. The log is
   `out/output.log` (else latexmk's console), capped to the last 2 MB of UTF-8 with a one-line notice
   (measured after decoding: pdflatex logs are often not valid UTF-8, and each invalid byte becomes a
   3-byte U+FFFD). PDF and SyncTeX are capped at 100 MB each.
7. Outputs are opened with `O_NOFOLLOW`, checked to be regular files, and streamed back to the worker,
   which validates every message (names, sizes, order: the helper shares a uid with the TeX run, so it
   is untrusted) and stores them in `BUILDS_DIR/.outputs/<projectId>/`. `GET /output` serves only from
   there, never from the project directory.
8. Afterwards the helper gets 2 s to exit; if it is still alive (whatever it reported) its process group
   is killed, and the sandbox's sweep runs after **every** compile (`uid`: every process of the project
   uid is killed).

## Staying small over time

- **Blob cache** (`BUILDS_DIR/.blobs`): every sync marks the blobs it references as used (mtime). Once
  an hour (and at start-up) blobs unused for `BLOB_CACHE_MAX_AGE_HOURS` are evicted, then the least
  recently used until the cache fits in `BLOB_CACHE_MAX_MB`; nothing used in the last 15 minutes is
  evicted. Evicting is always safe: the next sync reports the blob missing and the app re-uploads it
  (and `src/` keeps its own copy anyway).
- **Build directories**: projects not compiled for `BUILD_DIR_MAX_IDLE_DAYS` lose their build dir and
  stored outputs (`uid`: emptied by a process running as the project uid, then removed by root); the
  next compile rebuilds from scratch.
- **Free space guard**: below `BUILDS_MIN_FREE_MB` free, a compile first triggers a sweep and, if that is
  not enough, answers `error` with a clear log instead of filling the disk the app's database lives on.
- **Processes**: the image's PID 1 is `tini`, so TeX processes orphaned by a group kill are reaped
  instead of piling up as zombies against `pids_limit`.

## Sandboxes (`src/sandbox/`)

- **`none`** (dev default): helper and latexmk run as the current user. Refuses to start when
  `NODE_ENV=production`.
- **`uid`** (production default, Linux only, worker runs as root with only
  `SETUID SETGID CHOWN KILL`): the helper is spawned with `{uid, gid}` of the project
  (supplementary groups dropped), latexmk is wrapped in `prlimit` (2 GB address space, 200 MB file size,
  1024 files, 256 processes, CPU = timeout + 5 s, no core dumps), and after every compile every process
  of that uid is killed. `init()` also checks that `latexmk -v` runs (behind `prlimit` a missing latexmk
  would otherwise only show up as a failed build). `BUILDS_DIR` is `root 0711`, `.blobs`/`.outputs` `root 0700`,
  each project dir `0700` owned by its uid. On another OS, or not as root, it fails at startup with a
  clear message.

  **Project uid** (`src/sandbox/projectUid.ts`): unique per project, range 100000–1148575. The owner of
  `BUILDS_DIR/<id>` is the record (only root creates and chowns those, and a project uid cannot rename or
  chown its directory); the worker reads the owners back at start-up. A new project gets
  `100000 + (first 4 bytes of sha256(projectId), big-endian) mod 2^20` if no other project has it, else
  the next free uid. So no two projects share a uid, which would let them read each other's files and
  let one project's post-compile sweep kill the other's compile. Directories of an older worker version
  that do share a uid are deleted at start-up (they are only a cache).

The `Sandbox` interface (`src/sandbox/types.ts`) leaves room for `gvisor` (the `uid` sandbox under
`runtime: runsc`, no code change) and `bwrap`.

## Configuration

| Variable | Default (dev / `NODE_ENV=production`) | |
|---|---|---|
| `COMPILER_LISTEN` | `tcp:127.0.0.1:7071` / `unix:/run/ligature/compiler.sock` | `unix:/abs/path` or `tcp:host:port`. TCP is refused in production, and a non-loopback TCP host everywhere, unless `ALLOW_TCP=1`. |
| `ALLOW_TCP` | unset | `1` allows TCP in production and non-loopback TCP hosts (not recommended: no auth). |
| `COMPILER_SOCKET_GID` | unset | If the app is not root: socket dir becomes `root:<gid> 0710`, socket `0660`. Must be < 100000. |
| `SANDBOX` | `none` / `uid` | |
| `BUILDS_DIR` | `./builds` / `/builds` | |
| `LIGATURE_LATEXMK` | `latexmk` | Command, or a JSON argv prefix such as `["node","/path/fake-latexmk.mjs"]`. |
| `LIGATURE_PRLIMIT` | `1` | `0` disables the `prlimit` wrapper (uid sandbox). |
| `COMPILE_MAX_TIMEOUT_MS` | `300000` | Upper bound for `timeoutMs` (default per request: 90 s). |
| `PROJECT_DISK_QUOTA_MB` | `1024` | What one build may write on top of its sources. |
| `PROJECT_MAX_FILES` | `100000` | Files and folders one build may create. |
| `BLOB_CACHE_MAX_MB` | `2048` | Blob cache size after eviction. |
| `BLOB_CACHE_MAX_AGE_HOURS` | `72` | Blobs unused this long are evicted. |
| `BUILD_DIR_MAX_IDLE_DAYS` | `7` | Build dirs of projects not compiled this long are deleted. |
| `BUILDS_MIN_FREE_MB` | `1024` | Compiles answer `error` below this much free space; `0` disables. |

## Running

```sh
npm start -w @ligature/compiler          # dev: tcp:127.0.0.1:7071, sandbox none, ./builds, needs latexmk on PATH
LIGATURE_LATEXMK='["node","apps/compiler/test/fixtures/fake-latexmk.mjs"]' npm start -w @ligature/compiler   # without TeX
```

Production: `docker/Dockerfile.compiler` + `docker/compose.yaml` (network-less, read-only container;
`tini` as PID 1; `HEALTHCHECK` runs `src/healthcheck.ts`, which probes whatever `COMPILER_LISTEN` names).
For an app running natively on Windows: `docker compose -f docker/compose.dev.yaml up --build` publishes
the compiler on `127.0.0.1:7071`. Small VPS: build with `--build-arg TEXLIVE_IMAGE=<medium-scheme tag>`
(or `LIGATURE_TEXLIVE_IMAGE` in `docker/.env`, see `docker/.env.example`).

## Tests

```sh
npx tsc -p apps/compiler
cd apps/compiler && npx vitest run
```

No TeX needed: `test/fixtures/fake-latexmk.mjs` stands in for latexmk (reads the main file, checks
`\input`/`\include` targets exist, writes `out/output.{pdf,log,synctex.gz}`; `%FAKE: sleep|fail|failpdf|biglog N|
latin1log N|fill N|fillhang N|hold N` directives drive timeouts, failures, log floods, non-UTF-8 logs,
disk floods and overlap detection). Covered: validation, contract copies vs
`@ligature/shared`, framing round-trips, log capping, materialisation (incremental writes, deletes,
file⇄folder swaps, symlinked files/folders never followed, `out/` mirroring), the worker over HTTP
(sync → blobs → compile → outputs, failure, timeout, invalid input), the helper rejecting bad content,
the worker rejecting a misbehaving helper (`test/fixtures/evil-helper.mjs`), the real entrypoint's
production refusals, and the app's `CompilerClient` against the worker. `test/realTex.test.ts` runs only
when a real `latexmk` is on `PATH`. The `uid` sandbox's setuid path can only be exercised on Linux as
root (inside the image); it uses exactly the same helper and protocol as `none`.
