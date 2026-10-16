# TERMUX_APP_PACKAGE — пакеты для AI Builder

Отдельный APT-репозиторий для приватного runtime AI Builder (`com.karat.aibuilder`, `aarch64`). Он не предназначен для stock Termux и не использует пакеты `com.termux` или PocketForge.

## Текущее состояние — production закрыт

- В `main` сохранён старый пул из 133 `.deb`, но у него нет подтверждённого полного provenance; статический аудит отметил 3 неподтверждённых записи. Эти файлы **не являются доверенным установочным feed**.
- GitHub Pages для этого репозитория не включён; безопасный production URL пока не объявлен.
- PR #2 содержит gated candidate pipeline без production publication и ограниченный cleanup шести legacy workflow/script файлов.
- CI отдельно собирает GNU Make `4.4.1-1` и GitHub CLI `gh` `2.102.0`, а отдельный Git workflow — Git `2.56.0` вместе с 14-пакетной source-built dependency closure. Все кандидаты проходят статический аудит и временную подписанную APT download/`--simulate` проверку; реальной установки нет.
- Обычные CI-запуски удаляют `.deb` и feed с runner. Единственный заранее одобренный marker push выдал публичный Actions artifact **только для Make**: candidate `.deb`, подписанные временные APT metadata, публичный ephemeral keyring, manifest, build-result и audit-report. `gh`, Git и приватный ключ в artifact не входят; срок истечения — `2026-10-16 17:29 UTC` ([Actions run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38777394187)).
- Временный Make artifact предназначен только для device smoke: он не прошёл device validation и не является production feed. Пакеты не коммитятся, не выпускаются через GitHub Release и не публикуются на Pages.
- `pkg.ensure` и подключение production source остаются закрыты до точного Android install/rollback smoke-теста.

## Никаких обходов доверия

Не использовать `trusted=yes`, `AllowUnauthenticated`, `AllowInsecureRepositories`, официальный `com.termux` feed, пакеты из неизвестного источника или артефакты PocketForge. Наличие подписи Release подтверждает целостность индекса, но не происхождение/совместимость самих `.deb`.

## Проверки

```sh
./scripts/test-candidate-feed-policy.sh
./scripts/test-candidate-dependency-closure.sh
./scripts/test-pinned-termux-recipe-closure.sh
./scripts/test-device-test-artifact-staging.sh
./scripts/test-signed-feed-smoke.sh
./termux-private-package-kit/make-v476/verify-kit.sh
```

Политика кандидата и текущие блокеры описаны в [APT_REPO_SETUP_RU.md](./APT_REPO_SETUP_RU.md); схема подписи — в [docs/FEED_SIGNING_RU.md](./docs/FEED_SIGNING_RU.md).
