# Security

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository (private vulnerability reporting). Include what an
attacker can do, the steps to reproduce, and the Ligature version (`ligature --version`, or the bottom of the Admin page).

You will get an answer as soon as possible; fixes are released as a new version with a note in
[CHANGELOG.md](CHANGELOG.md).

## Supported versions

Only the latest release gets security fixes. Upgrade with the steps in
[docker/README.md](docker/README.md#upgrade).

## What Ligature is built for

Ligature is meant for a **team that trusts each other** (a research group, a class, colleagues). LaTeX
documents are programs, and compiles run in a sandbox: no network, one Unix user per project, a read-only
system, time, memory and disk limits, and a test suite of malicious documents in CI
([apps/compiler/test/corpus](apps/compiler/test/corpus/README.md)). That sandbox is not yet strong enough for
**open sign-up by strangers**: keep registration on *invite only* or *closed* until the gVisor sandbox
(planned, [docs/PLAN.md](docs/PLAN.md)) is available.
