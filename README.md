# TERMUX_APP_PACKAGE

A candidate package pipeline for the private AI Builder runtime (`com.karat.aibuilder`, `aarch64`), not for stock Termux.

## Production status: blocked

- The legacy `main` tree contains 133 unsigned `.deb` files without complete verified provenance; three package records were previously left unconfirmed. They are not a trusted install feed.
- GitHub Pages is not enabled for this repository; no production feed URL is available.
- The candidate pipeline builds only pinned GNU Make `4.4.1-1`, statically audits it, assembles a temporary signed APT feed, and tests strict `signed-by` metadata handling plus a simulated install plan.
- Candidate binaries and feed metadata are deleted on the runner: no package artifact, commit, release, or Pages deployment is produced.
- Production publication and app-side `pkg.ensure` stay disabled until exact-device install and rollback tests pass.

Never use `trusted=yes`, unauthenticated/insecure APT options, stock `com.termux` packages, or PocketForge artifacts.

## Checks

```sh
./scripts/test-candidate-feed-policy.sh
./termux-private-package-kit/make-v476/verify-kit.sh
```

See [APT_REPO_SETUP_RU.md](./APT_REPO_SETUP_RU.md) and [docs/FEED_SIGNING_RU.md](./docs/FEED_SIGNING_RU.md).
