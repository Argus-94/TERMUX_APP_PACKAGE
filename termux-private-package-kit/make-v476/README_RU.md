# GNU Make для AI Builder v476 — комплект сборки и аудита

Это комплект исходной сборки GNU Make `4.4.1-1` для `aarch64`/`arm64-v8a` в app-private runtime AI Builder (`com.karat.aibuilder`). **Готового `.deb` в репозитории нет.**

## Зафиксированные входы

- Рецепт Termux: `termux/termux-packages`, commit `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`.
- GNU Make source: `https://mirrors.kernel.org/gnu/make/make-4.4.1.tar.gz`; SHA-256 находится в `manifest.json`.
- Официальный Termux builder: `ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9` ([запись версии в GHCR](https://github.com/orgs/termux/packages/container/package-builder/1311633938?tag=latest)). Workflow скачивает строго этот digest, не изменяемый тег `latest`.
- SHA-256 точных upstream `build.sh` и `src-job.c.patch` перечислены в `upstream/termux-packages/SHA256SUMS` и закреплены в `manifest.json`.

## Проверка комплекта

```sh
./verify-kit.sh
```

Тестовые `.deb` — синтетические fixtures для unit-тестов аудитора, не установочные пакеты.

## Ручной запуск сборки

Для ручной сборки нужны Docker, не менее 3 GiB свободного места, чистый checkout указанного Termux commit и **точные** `applicationInfo.dataDir` и private prefix, полученные из реально установленного AI Builder v476. Prefix должен быть `filesDir/usr`.

```sh
export AIB_TERMUX_APP_DATA_DIR='<точный dataDir с устройства>'
export AIB_TERMUX_PREFIX='<точный проверенный filesDir/usr prefix>'
export AIB_TERMUX_BUILDER_IMAGE_REF='ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9'
./build-make-private-aarch64.sh /path/to/pinned-termux-packages /path/to/new-empty-output
```

Скрипт откажется продолжать при неизвестном/несовпадающем prefix, чужом source commit, изменённых locked-файлах или недоступном закреплённом image. Он собирает только `make`, сверяет fork properties, не использует `-i`/`-I`, не устанавливает пакет и копирует `.deb` в результат только после fail-closed статического аудита. Успешный статический аудит сам по себе не подтверждает установку или работу на устройстве.

## GitHub Actions

Ветка содержит ручной workflow для проверки/сборки. Используй его только на ветке `work/gnu-make-4.4.1-1`. Запуск требует точные `app_data_dir` и `termux_prefix` из установленного AI Builder; значения нельзя угадывать. Workflow в этой ветке вызывается через уже зарегистрированный путь `.github/workflows/build-packages.yml`; запускай его с выбранной рабочей веткой, не с `main`.

Это публичный репозиторий: dispatch-вводы и журналы workflow могут быть видны читателям. Не вводи секреты. Workflow не загружает `.deb` как Actions-артефакт, не коммитит его и удаляет временную сборку после аудита. Публично остаётся только краткий отчёт и SHA-256; сам бинарник не публикуется и не доставляется.

## Ограничения

В комплекте нет APK, private Termux feed, подписи, установщика или результата runtime-smoke-test. `manifest.json` намеренно оставляет `binaryPackageProduced`, `appPrefixCompatibilityProvenOnDevice` и `runtimeSmokeTestRun` равными `false`, пока нет фактических свидетельств.