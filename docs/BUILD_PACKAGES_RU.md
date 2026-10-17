# Сборка кандидатов пакетов AI Builder

## Текущий статус

Репозиторий работает в режиме **candidate-only**. Production APT feed не настроен, GitHub Pages не включён, а подключение `pkg.ensure` остаётся закрытым. Не копируйте собранные `.deb` в `apt/`, не пересобирайте production-индексы вручную и не публикуйте кандидаты.

Подтверждённые CI-кандидаты на `main`:

- GNU Make `4.4.1-1` (`candidate-package-set.json`);
- GitHub CLI `gh` `2.102.0` (`gh-candidate-package-set.json`);
- Git `2.56.0`: 14 source-built packages и 20 dependency alternatives (CI run `38829235485`).

Для подтверждённых кандидатов проверяются pinned source, рецепт, builder image, app-private prefix в модели CI, package payload и временный подписанный APT feed с `signed-by` и `apt-get --simulate`. Отдельный `curl` `8.23.0` candidate workflow фиксирует closure из 9 пакетов и 12 dependency alternatives, включая hash `curl` subpackage; его актуальный CI-результат смотрите в Actions check связанного PR. Поскольку upstream subpackage `curl` не несёт отдельный copyright payload, аудит требует license evidence от включённого parent `.deb` `libcurl` с теми же pinned recipe/source/version/license; без доказательства parent evidence closure отклоняется. Даже успешная симуляция — **не** Android install test и не разрешение production-публикации. Профили `base` и `git-extras` в `termux-package-source-scope.json` остаются inventory для всех пакетов, кроме тех, что отдельно закреплены candidate manifests.

## Toolchain profiles: candidate и source-metadata inventory

Для Node.js+NPM, OpenJDK 17 и CMake+Ninja отдельная ветка фиксирует recipe hashes и runtime dependency closures из Termux commit `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`:

- Node.js `26.4.0` + npm `11.20.0`: 11 пакетов, 14 dependency alternatives. Upstream `nodejs` recipe рекомендует npm, но использует `--without-npm`; npm включён как отдельный root. Для `npm` явно выбран provider `nodejs` вместо конфликтующего `nodejs-lts`; исходная группа `nodejs | nodejs-lts` при этом сохраняется в metadata.
- OpenJDK 17 `17.0.20`: 36 пакетов, 46 alternatives.
- CMake `4.4.4` + Ninja `1.13.2`: 22 пакета, 34 alternatives.

Эти числа описывают **runtime `Depends` closure**, а не полный build closure. Read-only workflow повторно разрешает recipes/subpackages и сверяет snapshots/hashes, но для этих трёх профилей ничего не собирает и не запускает APT или Android.

### Python `3.14.6` — отдельный candidate pipeline

Python вынесен в отдельный package set и kit: pinned runtime closure содержит 17 пакетов / 25 dependency alternatives. В `build.sh` `tk` закреплён как build-only dependency; `tk`, `tcl` и отдельный `python-tkinter` не входят в candidate runtime feed. Рекомендации `python-pip` и `python-ensurepip-wheels` также исключены из required closure и simulated install. Workflow в `.github/workflows/python-package-candidate.yml` предназначен для source build из точного commit, static ELF/license/dependency audit и временного ephemeral-signed APT `--simulate`; его результат считается доказанным только после зелёного Actions check на PR #6. Даже после успеха это не Android installation/rollback proof и не разрешение production feed/Pages публикации.

## Повторяемая проверка

Запускайте команды из корня репозитория:

```sh
./scripts/test-candidate-feed-policy.sh
./scripts/test-candidate-dependency-closure.sh
bash ./scripts/test-pinned-termux-recipe-closure.sh
bash ./scripts/test-toolchain-candidate-source-closures.sh /path/to/clean-pinned-termux-packages
python3 -m unittest discover -s termux-private-package-kit/python-v3.14.6/tests -p 'test_*.py' -v
./termux-private-package-kit/make-v476/verify-kit.sh
./scripts/test-device-test-artifact-staging.sh
python3 -m unittest discover -s termux-private-package-kit/gh-v2.102.0/tests -p 'test_*.py' -v
python3 -m unittest discover -s termux-private-package-kit/git-v2.56.0/tests -p 'test_*.py' -v
python3 -m unittest discover -s termux-private-package-kit/curl-v8.23.0/tests -p 'test_*.py' -v
```

Полную сборку Make/`gh` выполняет `.github/workflows/package-feed-candidate.yml`; Git, `curl` и Python проверяются отдельными `.github/workflows/git-package-candidate.yml`, `.github/workflows/curl-package-candidate.yml` и `.github/workflows/python-package-candidate.yml`. Candidate workflows не публикуют бинарники или production feed и удаляют временные исходники, пакеты и signing workspace после проверки.

## Ограниченная локальная сборка для разработки

Локальные builder-скрипты предназначены только для получения **непубликуемого** результата аудита. Они требуют чистый checkout Termux на точном pinned commit, Docker и digest-pinned официальный builder image; минимальный запас — 3 GiB для Make, 5 GiB для Git/`curl` и 8 GiB для Python. Скрипты проверяют app-private namespace, выполняют статический аудит и не устанавливают пакет. Например, для Make:

```sh
export AIB_TERMUX_APP_DATA_DIR=/data/user/0/com.karat.aibuilder
export AIB_TERMUX_PREFIX=/data/user/0/com.karat.aibuilder/files/usr
export AIB_TERMUX_BUILDER_IMAGE_REF='ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9'
./termux-private-package-kit/make-v476/build-make-private-aarch64.sh \
  /path/to/clean-pinned-termux-packages /path/to/new-empty-output
```

Пути выше — параметры **модели сборки**, а не доказательство реальных Android `dataDir`/`filesDir`. Не используйте созданный локально `.deb` как установочный источник и не переносите его в старый `apt/`.

## Что требуется до установки и production

1. Собрать dependency-closed allowlist; для каждого пакета закрепить источник и рецепт, построить бинарник, выполнить статический аудит и проверить его транзитивные зависимости.
2. Проверить точные пути `applicationInfo.dataDir` и `filesDir/usr` на целевом Android-приложении.
3. На тестовом устройстве проверить установку пакета, запуск бинарника, удаление и rollback; подтвердить, что внешняя Termux-среда и файлы проектов не затронуты.
4. Проверить fingerprint и SHA-256 keyring в приложении, а также HTTPS feed, `signed-by`, скачивание и целостность индексов.
5. Только после прохождения этих gate и отдельного разрешения настроить production Pages/feed и открыть app-side `pkg.ensure`.

До этого нельзя использовать `trusted=yes`, `AllowUnauthenticated`, `AllowInsecureRepositories`, stock `com.termux` feed/packages, неподтверждённые legacy `.deb` или пакеты из других приложений. См. [production gate](./PRODUCTION_GATE_RU.md), [подпись feed](./FEED_SIGNING_RU.md) и [основную настройку репозитория](../APT_REPO_SETUP_RU.md).
