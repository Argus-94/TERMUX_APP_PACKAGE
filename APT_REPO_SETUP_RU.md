# APT-пакеты AI Builder: состояние и безопасный порядок включения

Репозиторий предназначен только для app-private runtime `com.karat.aibuilder` (`aarch64`/`arm64-v8a`). Он не совместим автоматически со stock Termux и не должен использовать его приватные данные, prefix или пакеты.

## Текущее состояние

**Production feed не готов.** В `main` находится legacy pool из 133 `.deb`; полный source/build provenance для набора не подтверждён, а прежний статический аудит оставил `fontconfig`, `libx11` и `termux-auth` неподтверждёнными. Ветка PR #2 содержит gated candidate pipeline и cleanup только шести legacy workflow/script файлов; ни этот cleanup, ни candidate CI не публикуют production feed. GitHub Pages для репозитория не включён. Старый pool нельзя добавлять в trusted APT sources.

Signing smoke на синтетическом fixture проверяет `Release`/`InRelease`, `signed-by` и отказ APT при изменении индекса. CI отдельно строит и статически проверяет Make `4.4.1-1`, `gh` `2.102.0`, а Git `2.56.0` — вместе с 14-пакетной source-built dependency closure. Для кандидатов создаются только временные подписанные feeds и выполняются download/`apt-get --simulate` проверки; фактической Android-установки не было.

## Кандидатный конвейер

- Termux source commit закреплён на `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`; builder image закреплён по digest.
- Make и `gh` собираются как отдельные кандидаты. Для Git CI проверяет закреплённый source/recipe closure: 14 пакетов и 20 dependency alternatives; dependency downloads отключены.
- Каждый собранный `.deb` проходит fail-closed аудит путей, namespace, control metadata, ELF, лицензии и payload.
- Для кандидатов CI строит временный подписанный APT feed, использует только `signed-by=<закреплённый public keyring>`, загружает пакет и запускает `apt-get --simulate install`.
- У `gh` нет обязательных runtime `Depends`; `openssh` — только `Recommends`. Git closure проверяется как полный набор без внешних base-runtime предположений.
- Обычные запуски удаляют `.deb`, индексы и подписи с runner. Единственный одобренный marker push создал публичный Actions artifact **только для Make**, не для `gh` или Git; он истекает `2026-10-16 17:29 UTC` ([Actions run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38777394187)). Это device-test handoff, не production feed; Pages и GitHub Release не публикуются.

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
./scripts/test-candidate-dependency-closure.sh
./scripts/test-pinned-termux-recipe-closure.sh
./scripts/test-device-test-artifact-staging.sh
./scripts/test-signed-feed-smoke.sh
./termux-private-package-kit/make-v476/verify-kit.sh
```

На GitHub Actions дополнительно выполняются digest-pinned сборка, статический аудит и временный APT candidate smoke. Успех этих тестов означает только `candidate built + feed verified`; он не означает production readiness, установку или Android runtime proof.

Подробнее: [production gate](./docs/PRODUCTION_GATE_RU.md) и [подпись feed](./docs/FEED_SIGNING_RU.md). Private key, его export или passphrase в Git не помещать; публично хранятся только public keyring и его pinned fingerprint/hash.
