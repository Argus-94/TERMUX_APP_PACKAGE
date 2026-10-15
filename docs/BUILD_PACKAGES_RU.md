# Сборка кандидатов пакетов AI Builder

## Текущий статус

Репозиторий работает в режиме **candidate-only**. Production APT feed не настроен, GitHub Pages не включён, а подключение `pkg.ensure` остаётся закрытым. Не копируйте собранные `.deb` в `apt/`, не пересобирайте production-индексы вручную и не публикуйте кандидаты.

Подтверждённые CI-кандидаты на текущей ветке:

- GNU Make `4.4.1-1` (`candidate-package-set.json`);
- GitHub CLI `gh` `2.102.0` (`gh-candidate-package-set.json`).

Для них проверены pinned source, рецепт, builder image, app-private prefix в модели CI, package payload и временный подписанный APT feed с `signed-by` и `apt-get --simulate`. Это **не** Android install test и не разрешение production-публикации. Профили `base` и `git-extras` в `termux-package-source-scope.json` — только инвентаризация рецептов/зависимостей; перечисленные там пакеты не считаются собранными, проверенными или устанавливаемыми.

## Повторяемая проверка

Запускайте команды из корня репозитория:

```sh
./scripts/test-candidate-feed-policy.sh
./scripts/test-candidate-dependency-closure.sh
bash ./scripts/test-pinned-termux-recipe-closure.sh
./termux-private-package-kit/make-v476/verify-kit.sh
./scripts/test-device-test-artifact-staging.sh
python3 -m unittest discover -s termux-private-package-kit/gh-v2.102.0/tests -p 'test_*.py' -v
```

Полную сборку двух разрешённых кандидатов, статический аудит и временную APT-симуляцию выполняет `.github/workflows/package-feed-candidate.yml` в GitHub Actions. Обычные запуски не публикуют пакеты и удаляют временные исходники, бинарники и signing workspace после проверки.

## Ограниченная локальная сборка для разработки

Локальные builder-скрипты предназначены только для получения **непубликуемого** результата аудита. Они требуют чистый checkout Termux на точном pinned commit, Docker, digest-pinned официальный builder image и не менее 3 GiB свободного места. Скрипты проверяют app-private namespace, выполняют статический аудит и не устанавливают пакет. Например, для Make:

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
