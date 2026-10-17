# TERMUX_APP_PACKAGE

A candidate package pipeline for the private AI Builder runtime (`com.karat.aibuilder`, `aarch64`), not for stock Termux.

## Production status: blocked

- The legacy `main` tree contains 133 `.deb` files without complete verified provenance; three package records remain unconfirmed. They are not a trusted install feed.
- GitHub Pages is not enabled for this repository; no production feed URL is available.
- PR #2 contains a gated candidate pipeline and a narrowly scoped cleanup of six legacy workflow/script files; it does not publish packages.
- CI separately builds and statically audits GNU Make `4.4.1-1` and GitHub CLI `gh` `2.102.0`; a separate Git workflow builds Git `2.56.0` with its 14-package source-built dependency closure. Each candidate feed is temporary and signed; CI verifies download and `apt-get --simulate`, but performs no package installation.
- The Python `3.14.6-1` candidate passed [hosted source build, static audits and ephemeral-signed APT download/simulation](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39036690122) at commit `b39ebbf624a19adee282f28568c50a5619a192af`: 17 runtime packages / 25 dependency alternatives, with `tk` build-only and Python recommendations excluded. The run uploaded no artifacts and removed its temporary source, packages, feed and signing material; Android installation and rollback remain NOT RUN. OpenJDK 17 (36 / 46) and CMake+Ninja (22 / 34) remain metadata-only inventories.
- Node.js `26.4.0-1` + npm `11.20.0` passed [hosted build, static audit and ephemeral-signed APT simulation](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39053197442/attempts/2) at commit `281edbb3e832ab8d3e3c2fc27a7c4c1aae2a26bd`: all 11 pinned runtime packages / 14 source dependency alternatives, with `nodejs` as the exclusive npm provider and npm metadata architecture `all`. The package-index closure had 13 required dependency relations and zero external-base assumptions; simulated installation matched all 11 packages exactly. The immutable npm source archive, bundled Node/npm/ICU LICENSE hashes, private paths, AArch64 ELF/library providers, indexes and package hashes passed their gates. There were zero uploaded artifacts; temporary source, binaries, feed and ephemeral keys were cleaned. Android installation/runtime/rollback remain NOT RUN; production publication and Builder `pkg.ensure` stay blocked.
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
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s termux-private-package-kit/nodejs-npm/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -v
```

See [APT_REPO_SETUP_RU.md](./APT_REPO_SETUP_RU.md) and [docs/FEED_SIGNING_RU.md](./docs/FEED_SIGNING_RU.md).
