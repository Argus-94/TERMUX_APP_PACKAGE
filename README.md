# TERMUX_APP_PACKAGE

A candidate package pipeline for the private AI Builder runtime (`com.karat.aibuilder`, `aarch64`), not for stock Termux.

## Production status: blocked

- The legacy `main` tree contains 133 `.deb` files without complete verified provenance; three package records remain unconfirmed. They are not a trusted install feed.
- GitHub Pages is not enabled for this repository; no production feed URL is available.
- PR #2 contains a gated candidate pipeline and a narrowly scoped cleanup of six legacy workflow/script files; it does not publish packages.
- CI separately builds and statically audits GNU Make `4.4.1-1` and GitHub CLI `gh` `2.102.0`; a separate Git workflow builds Git `2.56.0` with its 14-package source-built dependency closure. Each candidate feed is temporary and signed; CI verifies download and `apt-get --simulate`, but performs no package installation.
- A new Python-specific candidate workflow/kit is being validated on PR #6: it locks the 17-package / 25-alternative Python runtime closure, treats `tk` as build-only, excludes Python recommendations, and is designed to source-build, statically audit, then simulate from an ephemeral signed APT feed. Do not treat it as a passed hosted build until its Actions check is green; it still provides no Android install or rollback proof. Node.js+NPM (11 / 14, with `nodejs` selected as npm provider), OpenJDK 17 (36 / 46), and CMake+Ninja (22 / 34) remain metadata-only inventories.
- Ordinary candidate runs delete binaries and feed metadata from the runner. The specifically authorized one-time marker push uploaded a public Actions artifact containing **only** the statically audited `make` candidate, its signed temporary APT metadata, public ephemeral keyring, manifest, build result, and audit report. It expires at `2026-10-16 17:29 UTC` ([Actions run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38777394187)).
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
python3 -m unittest discover -s termux-private-package-kit/python-v3.14.6/tests -p 'test_*.py' -v
```

See [APT_REPO_SETUP_RU.md](./APT_REPO_SETUP_RU.md) and [docs/FEED_SIGNING_RU.md](./docs/FEED_SIGNING_RU.md).
