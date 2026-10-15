# GNU Make для AI Builder — pinned candidate build и аудит

Комплект проверяет сборку GNU Make `4.4.1-1` для `aarch64`/`arm64-v8a` в app-private runtime `com.karat.aibuilder`. Готового доверенного production `.deb` или feed здесь нет.

## Закреплённые входы

- Termux recipe source: commit `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`.
- GNU Make source: `https://mirrors.kernel.org/gnu/make/make-4.4.1.tar.gz`, SHA-256 — в `manifest.json`.
- Официальный Termux builder image закреплён digest `sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9`.
- SHA-256 recipe, patch и builder files проверяются до сборки.

## Быстрые проверки

```sh
./verify-kit.sh
```

Synthetic `.deb` внутри unit tests — только fixtures; их нельзя устанавливать.

## Моделируемый compile-time prefix

CI не запрашивает runtime пути у пользователя. Для модели вычисляется canonical Android-путь по application ID:

```sh
APP_DATA_DIR=/data/user/0/com.karat.aibuilder
PREFIX="$APP_DATA_DIR/files/usr"
```

Эти значения нужны лишь для встраивания путей в тестовый кандидат. Они **не** доказывают фактические `applicationInfo.dataDir` и `filesDir` на установленном APK; `/data/data/...` также может быть canonical alias. Перед production необходима проверка реального prefix на устройстве.

Ручной build требует Docker, не менее 3 GiB свободного места, чистый checkout точного commit и output path вне source tree:

```sh
export AIB_TERMUX_APP_DATA_DIR=/data/user/0/com.karat.aibuilder
export AIB_TERMUX_PREFIX=/data/user/0/com.karat.aibuilder/files/usr
export AIB_TERMUX_BUILDER_IMAGE_REF='ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9'
./build-make-private-aarch64.sh /path/to/pinned-termux-packages /path/to/new-empty-output
```

Скрипт проверяет locked source files, prefix consistency и image digest, запрещает `-i`/`-I`, собирает только `make`, не устанавливает пакет и копирует `.deb` только после pass fail-closed аудита. Cache остаётся в изолированном контейнерном `/home/builder/.termux-build`; `.deb` сначала пишется в `/home/builder/termux-packages/output/.aib-private-make-debs`, разрешённый закреплённым AppArmor profile, затем проверяется и только после pass аудита копируется в отдельный output.

В embedded strings auditor допускает только канонический modeled prefix `.../files/usr` и modeled app-private home `.../files/home` (с потомками); любой `..`, другой каталог приложения или `com.termux` отклоняется. Это не расширяет install payload: файлы, ссылки и ELF RPATH по-прежнему ограничены `files/usr`.

## GitHub Actions

Workflow автоматически запускается при push в ветку candidate pipeline. Он использует те же моделируемые значения, собирает временный candidate APT feed, проверяет подпись/`signed-by` и simulated install, затем удаляет source tree, `.deb`, feed и signing workspace. Binary не загружается как artifact, не коммитится и не публикуется.

Workflow намеренно не запускает настоящий device install и не открывает production release. В `manifest.json` device compatibility, package installation, rollback, feed publication и byte reproducibility остаются `false` до соответствующих доказательств.
