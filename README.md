# TERMUX_APP_PACKAGE

A candidate package pipeline for the private AI Builder runtime (`com.karat.aibuilder`, `aarch64`), not for stock Termux.

## Production status: blocked

- The legacy `main` tree contains 133 unsigned `.deb` files without complete verified provenance; three package records were previously left unconfirmed. They are not a trusted install feed.
- GitHub Pages is not enabled for this repository; no production feed URL is available.
- The candidate workflow builds and statically audits two pinned candidates: GNU Make `4.4.1-1` and GitHub CLI `gh` `2.102.0`. Each gets a temporary signed APT feed and strict `signed-by` download/simulated-install checks; CI does not install either package.
- Ordinary candidate runs delete all binaries and feed metadata on the runner. The specifically authorized one-time marker push uploaded a public Actions artifact containing **only** the statically audited `make` candidate, its signed temporary APT metadata, public ephemeral keyring, manifest, build result, and audit report; `gh` and private signing material are not included. It expires at `2026-10-16 17:29 UTC` ([Actions run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38777394187)).
- The temporary `make` artifact is for device testing only: it is not device-validated or a production feed, and no package is committed, released, or deployed to Pages.
- Production publication and app-side `pkg.ensure` stay disabled until exact-device install and rollback tests pass.

Never use `trusted=yes`, unauthenticated/insecure APT options, stock `com.termux` packages, or PocketForge artifacts.

## Checks

```sh
./scripts/test-candidate-feed-policy.sh
./termux-private-package-kit/make-v476/verify-kit.sh
```

See [APT_REPO_SETUP_RU.md](./APT_REPO_SETUP_RU.md) and [docs/FEED_SIGNING_RU.md](./docs/FEED_SIGNING_RU.md).
