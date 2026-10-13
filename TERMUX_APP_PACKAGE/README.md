# TERMUX_APP_PACKAGE

Apt repository of Termux packages built for **AI Builder** (`com.karat.aibuilder`), **not** for stock `com.termux`.

## Feed URL (after GitHub Pages is enabled)

```text
deb https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main stable main
```

## Layout

```text
apt/termux-main/
  dists/stable/main/binary-aarch64/Packages[.gz]
  pool/main/<package>/*.deb
  Release
```

## Status

- [x] Directory layout
- [ ] `.deb` packages (`TERMUX_APP__PACKAGE_NAME=com.karat.aibuilder`)
- [ ] Regenerated `Packages` index with real packages
- [ ] GitHub Pages enabled
- [ ] AI Builder `AIB_TERMUX_APT_FEED_DEFAULT` points here

## Docs

- [APT_REPO_SETUP_RU.md](./APT_REPO_SETUP_RU.md) — full setup guide (RU)
- [docs/BUILD_PACKAGES_RU.md](./docs/BUILD_PACKAGES_RU.md) — how to build `.deb`

## Critical rule

All packages **must** be built with:

```bash
export TERMUX_APP__PACKAGE_NAME=com.karat.aibuilder
```

Do **not** publish binaries built for `com.termux`.
