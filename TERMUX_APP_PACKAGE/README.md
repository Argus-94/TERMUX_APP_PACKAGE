# TERMUX_APP_PACKAGE

Apt-репозиторий пакетов Termux для **AI Builder** (`com.karat.aibuilder`), **не** для stock `com.termux`.

## Быстрый старт

См. **[РАСПАКУЙ_И_ПУШ_RU.md](./РАСПАКУЙ_И_ПУШ_RU.md)** и **[CHECKLIST_RU.md](./CHECKLIST_RU.md)**.

```bash
./scripts/push-to-github.sh
git push -u origin main
```

## Feed URL (после GitHub Pages)

```text
deb https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main stable main
```

Проверка индекса:

```text
https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main/dists/stable/main/binary-aarch64/Packages
```

## Layout

```text
apt/termux-main/
  dists/stable/main/binary-aarch64/Packages[.gz]
  pool/main/<package>/*.deb
  Release
```

## Status

- [x] Directory layout + docs + Pages workflow
- [ ] Real `.deb` (`TERMUX_APP__PACKAGE_NAME=com.karat.aibuilder`)
- [ ] Regenerated `Packages` with real packages
- [ ] GitHub Pages live
- [ ] AI Builder `AIB_TERMUX_APT_FEED_DEFAULT` points here

## Docs

| File | Content |
|------|---------|
| [APT_REPO_SETUP_RU.md](./APT_REPO_SETUP_RU.md) | Полная настройка apt |
| [docs/BUILD_PACKAGES_RU.md](./docs/BUILD_PACKAGES_RU.md) | Сборка `.deb` |
| [CHECKLIST_RU.md](./CHECKLIST_RU.md) | Пошаговый чеклист |

## Critical rule

```bash
export TERMUX_APP__PACKAGE_NAME=com.karat.aibuilder
```

Do **not** publish packages built for `com.termux`.
