# Чеклист TERMUX_APP_PACKAGE

## Сейчас (каркас)

- [x] Папки `apt/termux-main/dists/...` и `pool/main/`
- [x] Пустые `Packages` / `Packages.gz`
- [x] `Release`
- [x] GitHub Actions Pages workflow
- [x] Документация (APT_REPO_SETUP_RU.md, BUILD_PACKAGES_RU.md)

## Твои шаги

1. [ ] Распаковать этот архив
2. [ ] `cd TERMUX_APP_PACKAGE && ./scripts/push-to-github.sh`
3. [ ] `git push -u origin main` (логин GitHub)
4. [ ] Settings → Pages → Source: **GitHub Actions**
5. [ ] Дождаться зелёного workflow «Deploy apt repo to Pages»
6. [ ] Проверить в браузере:
      `https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main/dists/stable/main/binary-aarch64/Packages`
7. [ ] Собрать `.deb` (`TERMUX_APP__PACKAGE_NAME=com.karat.aibuilder`) — см. docs/BUILD_PACKAGES_RU.md
8. [ ] Положить `.deb` в `apt/termux-main/pool/main/<имя>/`
9. [ ] `./scripts/rebuild-index.sh`
10. [ ] `git add -A && git commit -m "Add packages" && git push`
11. [ ] В AI Builder выставить feed URL / `AIB_TERMUX_APT_FEED_DEFAULT`

## Проверка на телефоне (embedded shell)

```bash
pkg update
pkg install -y git
command -v git
echo "$PREFIX"
# ожидается: /data/data/com.karat.aibuilder/files/usr
```
