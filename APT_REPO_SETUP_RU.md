# APT-пакеты AI Builder: состояние и безопасный порядок включения

Репозиторий предназначен только для app-private runtime `com.karat.aibuilder` (`aarch64`/`arm64-v8a`). Он не совместим автоматически со stock Termux и не должен использовать его приватные данные, prefix или пакеты.

## Текущее состояние

**Production feed не готов.** В `main` находится legacy pool из 133 `.deb`; полный source/build provenance для этого набора не подтверждён, а прежний статический аудит оставил `fontconfig`, `libx11` и `termux-auth` неподтверждёнными. В отдельной ветке подготовлен gated candidate pipeline без production publication; legacy workflows пока не удалены и требуют отдельного подтверждения владельца перед cleanup/merge. GitHub Pages сейчас не включён. Не добавляйте старый pool в trusted APT sources и не используйте URL Pages как рабочий feed.

Подписной smoke test на синтетическом fixture проверяет `Release`/`InRelease`, `signed-by` и отказ APT при изменении индекса. Отдельные candidate CI jobs также собирают и статически проверяют два точечных пакета и моделируют их загрузку/установочный план из временного подписанного feed. Ни один результат не доказывает происхождение старых пакетов или фактическую Android-установку/runtime.

## Кандидатный конвейер

Текущий узкий allowlist кандидатов содержит GNU Make `4.4.1-1` и GitHub CLI `gh` `2.102.0`:

- исходники и Termux recipes закреплены на commit `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`;
- исходные архивы и recipe/patch (для Make) имеют SHA-256 locks;
- используется официальный Termux builder image, закреплённый по digest;
- каждый пакет проверяется fail-closed аудитом путей, namespace, control metadata, ELF, license и payload;
- после аудита CI строит отдельный временный локальный APT feed для каждого кандидата, подписывает Release, применяет только `signed-by=<закреплённый public keyring>`, загружает пакет и запускает `apt-get --simulate install`;
- у `gh` нет обязательных runtime `Depends` в собранном пакете; `openssh` указан только как `Recommends` и не включается в симуляцию с `--no-install-recommends`;
- CI не устанавливает пакеты. Обычные запуски удаляют `.deb`, индексы и подписи с runner. Единственный одобренный marker push уже создал публичный artifact **только для `make`**, не для `gh`; он истекает `2026-10-16 17:29 UTC` ([Actions run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38777394187)). Это лишь device-test handoff, не production feed; Pages и GitHub Release не публикуются.

**Моделируемый CI prefix** вычислен из фиксированного Android application ID: `/data/user/0/com.karat.aibuilder/files/usr`. Это только compile-time модель, а не утверждение об измеренном на устройстве `dataDir`/`filesDir`. Скрипты не читают данные внешнего Termux и не трогают проекты пользователя. Реальный prefix, установка, исполнение и rollback должны быть проверены отдельно на целевом устройстве.

## Production gate

До открытия production feed или `pkg.ensure` нужны все пункты:

1. Для каждого публикуемого пакета — pinned source/recipe/build provenance, точный SHA-256 бинарника и pass статического аудита.
2. Полный allowlist и dependency closure; никаких неучтённых `.deb` или частичных успешных сборок.
3. Подписанные `Packages`/`Packages.gz` и `Release`/`InRelease`; клиент закрепляет fingerprint и SHA-256 public keyring и применяет APT `signed-by`.
4. Доступная HTTPS-раздача без публикации тестового или непроверенного feed.
5. На поддерживаемой версии AI Builder/Android — установка и проверка выбранного пакета в его собственном prefix, выполнение бинарника, затем rollback/removal; подтвердить, что внешний Termux и каталог проекта `/storage/emulated/0/AIBuilderTermux` не изменены.
6. Только после этих доказательств отдельно открывается app-side package source/`pkg.ensure`.

**Запрещено:** `trusted=yes`, `--allow-unauthenticated`, `Acquire::AllowInsecureRepositories`, обход подписи, подстановка `com.termux` feed/бинарников и использование PocketForge пакетов.

## Локальные проверки без устройства

```sh
./scripts/test-candidate-feed-policy.sh
./termux-private-package-kit/make-v476/verify-kit.sh
```

На GitHub Actions дополнительно выполняются digest-pinned сборка, статический аудит и временный APT candidate smoke. Успех этих тестов означает только `candidate built + feed verified`; он не означает production readiness, установку или Android runtime proof.

Подробнее: [production gate](./docs/PRODUCTION_GATE_RU.md) и [подпись feed](./docs/FEED_SIGNING_RU.md). Private key, его export или passphrase в Git не помещать; публично хранятся только public keyring и его pinned fingerprint/hash.
