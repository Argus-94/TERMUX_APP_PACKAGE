# TERMUX_APP_PACKAGE — пакеты для AI Builder

Отдельный APT-репозиторий для приватного runtime AI Builder (`com.karat.aibuilder`, `aarch64`). Он не предназначен для stock Termux и не использует пакеты `com.termux` или PocketForge.

## Текущее состояние — production закрыт

- В `main` сохранён старый пул из 133 `.deb`, но у него нет подтверждённого полного provenance; статический аудит отметил 3 неподтверждённых записи. Эти файлы **не являются доверенным установочным feed**.
- GitHub Pages для этого репозитория не включён; безопасный production URL пока не объявлен.
- В отдельной ветке добавлен read-only candidate pipeline. Старые build/Pages workflows в `main` пока остаются; до отдельного подтверждения их cleanup не выполняется.
- Ветка кандидата собирает только GNU Make `4.4.1-1` из закреплённого исходного recipe, проверяет payload, временно формирует подписанный локальный APT feed и проверяет его через `signed-by` и `apt-get --simulate`.
- Candidate `.deb` и feed остаются только на CI runner и удаляются. Ничего не коммитится, не загружается как artifact и не публикуется.
- `pkg.ensure` и подключение production source остаются закрыты до точного Android install/rollback smoke-теста.

## Никаких обходов доверия

Не использовать `trusted=yes`, `AllowUnauthenticated`, `AllowInsecureRepositories`, официальный `com.termux` feed, пакеты из неизвестного источника или артефакты PocketForge. Наличие подписи Release подтверждает целостность индекса, но не происхождение/совместимость самих `.deb`.

## Проверки

```sh
./scripts/test-candidate-feed-policy.sh
./termux-private-package-kit/make-v476/verify-kit.sh
```

Политика кандидата и текущие блокеры описаны в [APT_REPO_SETUP_RU.md](./APT_REPO_SETUP_RU.md); схема подписи — в [docs/FEED_SIGNING_RU.md](./docs/FEED_SIGNING_RU.md).
