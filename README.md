# TERMUX_APP_PACKAGE

A candidate package pipeline for the private AI Builder runtime (`com.karat.aibuilder`, `aarch64`), not for stock Termux.

## Production status: blocked

- The legacy `main` tree contains 133 `.deb` files without complete verified provenance; three package records remain unconfirmed. They are not a trusted install feed.
- GitHub Pages is not enabled for this repository; no production feed URL is available.
- PR #2 contains a gated candidate pipeline and a narrowly scoped cleanup of six legacy workflow/script files; it does not publish packages.
- CI separately builds and statically audits GNU Make `4.4.1-1` and GitHub CLI `gh` `2.102.0`; a separate Git workflow builds Git `2.56.0` with its 14-package source-built dependency closure. Each candidate feed is temporary and signed; CI verifies download and `apt-get --simulate`, but performs no package installation.
- A separate read-only inventory locks source/runtime dependency metadata for Node.js `26.4.0` + npm `11.20.0` (11 packages / 14 dependency alternatives, with npm's provider explicitly selected as `nodejs`), OpenJDK 17 `17.0.20` (36 / 46), Python `3.14.6` (17 / 25), and CMake+Ninja `4.4.4` / `1.13.2` (22 / 34). These are **not built package candidates**: the resolver does not traverse `TERMUX_PKG_BUILD_DEPENDS` and produces no binaries, static audit, signed feed, APT simulation, Android install, or rollback evidence.
- Ordinary candidate runs delete binaries and feed metadata from the runner. The specifically authorized one-time marker push uploaded a public Actions artifact containing **only** the statically audited `make` candidate, its signed temporary APT metadata, public ephemeral keyring, manifest, build result, and audit report. `gh`, Git and private signing material are not included. It expires at `2026-10-16 17:29 UTC` ([Actions run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38777394187)).
- The temporary `make` artifact is for device testing only: it is not device-validated or a production feed, and no package is committed, released, or deployed to Pages.
- Production publication and app-side `pkg.ensure` stay disabled until exact-device install and rollback tests pass.

Never use `trusted=yes`, unauthenticated/insecure APT options, stock `com.termux` packages, or PocketForge artifacts.

## Checks

```sh
./scripts/test-candidate-feed-policy.sh
./scripts/test-candidate-dependency-closure.sh
./scripts/test-pinned-termux-recipe-closure.sh
./scripts/test-device-test-artifact-staging.sh
./scripts/test-signed-feed-smoke.sh
./termux-private-package-kit/make-v476/verify-kit.sh
```

See [APT_REPO_SETUP_RU.md](./APT_REPO_SETUP_RU.md) and [docs/FEED_SIGNING_RU.md](./docs/FEED_SIGNING_RU.md).
