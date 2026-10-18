# Что мешает объединить кандидаты в один APT feed

**Исходные наборы сходятся, но бинарное объединение пока заблокировано.** Десять отдельно проверенных семейств дают 144 вхождения и 79 уникальных имён пакетов. В текущих manifest нет расхождений версии или архитектуры одного имени. Обязательные зависимости рецептов удовлетворяются и внутри каждого профиля, и в объединении. Это не доказательство совместимости собранных `.deb`: доступных подписанных бинарных наборов для повторной проверки нет.

## Что теперь закреплено

[`unified-candidate-input-lock.json`](../unified-candidate-input-lock.json) — **inventory-only lock входов**, а не перечень доступных собранных пакетов. Он фиксирует точные ожидаемые версии/архитектуры, source commit, recipe/subpackage SHA-256, группы зависимостей, все вхождения дубликатов, хэши manifest/workflow и локальных патчей, builder digest и modeled app-private prefix. `binarySha256` и `signedBinaryBundle` оставлены `null`; `aggregateReady=false`, `publicationAllowed=false`.

| Семейство | Корни | Пакетов в профиле |
|---|---|---:|
| Make | make 4.4.1-1 | 1 |
| gh | gh 2.102.0 | 1 |
| Git | git 2.56.0 | 14 |
| curl | curl 8.23.0 | 9 |
| wget | wget 1.25.0-1 | 11 |
| pkg-config | pkg-config 0.29.2-3 | 22 |
| Python | python 3.14.6-1 | 17 |
| Node/npm | nodejs 26.4.0-1, npm 11.20.0 | 11 |
| OpenJDK17 | openjdk-17 17.0.20 | 36 |
| CMake/Ninja | cmake 4.4.4, ninja 1.13.2 | 22 |

Все исходные рецепты проверяются из чистого checkout `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`; рецепты не исполняются. Make и gh также проходят resolver по своим корням; отсутствие `dependencyGroups` в старом Make/Git manifest не подменяется предположением об отсутствии зависимостей. Точные версии/revision и architecture сверяются с pinned source; для ncurses/libandroid-support читается первый literal элемент массива версий без shell-eval. У subpackage маркер `parent-build-version` сравнивается с точной source-validated версией subpackage; версия родителя также отдельно сверяется с тем же исходным рецептом. Рекомендации и build/host-зависимости не входят в эту runtime source closure; это не новый аудит всей build-chain.

## Дубликаты не означают одинаковые бинарники

Повторяются **28 имён**, всего 65 дополнительных вхождений. Полный список профилей каждого имени находится в lock. Ни один поставщик не выбран автоматически.

Особенно важен `libcurl 8.23.0`: CMake/Ninja применяет [`libcurl-disable-optional-zstd.patch`](../termux-private-package-kit/cmake-ninja/libcurl-disable-optional-zstd.patch). Исходный рецепт имеет SHA-256 `0051cc33b3d3f0b69e74a00c67ba668f295b6eb3574e548154653d7e69f12025`, эффективный рецепт профиля — `ba13efc16ac98cec77ebd9c0718c65ea69cef87c96e3cb0c27864593f8ede348`. Git и curl используют то же имя/версию без этого локального патча. Это **разные варианты входов**, но ещё не доказанный бинарный конфликт.

Будущий сборщик обязан остановиться при разных SHA-256 одного name/version/architecture. Нельзя выбирать первый/последний файл, перезаписывать его по имени или считать равные upstream recipe hash доказательством равенства `.deb`. Даже при равных SHA-256 дедупликация допустима только после проверки подписанной provenance каждого входа.

## Почему готовые результаты нельзя просто скачать и объединить

GitHub API у следующих успешных запусков вернул `total_count=0` для artifacts:

- [Make и gh — 38817260914](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38817260914)
- [Git — 38829235485](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38829235485)
- [curl — 38847403466](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38847403466)
- [wget — 38858437726](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38858437726)
- [pkg-config — 38873727743](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38873727743)
- [Python — 39036690122](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39036690122)
- [Node/npm — 39053197442](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39053197442)
- [OpenJDK17 — 39080124869](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39080124869)
- [CMake/Ninja — 39086630210](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39086630210)

Workflow удаляют runner-local output/feed/ключи после проверки. В Make workflow есть исторический одноразовый upload, разрешённый только точным marker push, с хранением один день; это не общий экспорт десяти семейств и не основание повторно активировать его. Отсутствие artifact в указанных запусках не означает, что пакеты никогда не собирались; оно означает, что эти запуски не предоставляют доступный бинарный вход агрегатору.

## Чего точно не хватает

1. **Новых runner-local подписанных наборов всех десяти профилей:** самих точных `.deb`, их SHA-256, `Packages`, `Release`, `InRelease`, `Release.gpg`, публичного ephemeral keyring и независимо закреплённого fingerprint. Не загружать бинарники публично и не сохранять private key. Одной самоподписи неизвестным ключом недостаточно для provenance.
2. **Привязанных к хэшам доказательств сборки:** source closure, полного effective recipe/patch context, source archive checksums, builder digest, build-result и static audit для каждого набора. Успешный CI-статус и JSON `ok=true` не заменяют повторную проверку пакетов.
3. **Решения по каноническим дубликатам**, прежде всего `libcurl`, с пересборкой нужных поставщиков и повторным аудитом всех потребителей. Смешивание ранее отдельно прошедших closure без этого не разрешено.
4. **Фактических control и payload каждого `.deb`:** `Depends`, `Pre-Depends`, `Conflicts`, `Breaks`, `Replaces`, `Provides`, тип/режим/хэш каждого пути и цели symlink/hardlink. Нельзя установить коллизии путей или ABI по перечню исходников. До безопасной проверки archive paths извлекать произвольные входы нельзя; совпадение обычных директорий отдельно от коллизий файлов.
5. **Одной общей проверки** реального набора: строгий статический/ELF аудит, только временный ключ, `signed-by`, `apt-get update`, все точные корни в одной `apt-get --simulate --no-install-recommends install` транзакции; отрицательные тесты omission, hash/signature tampering и cross-family dependency hole. После выполнения удалить пакеты/feed/ключи на runner.

Без этих входов CI-only бинарный aggregate job сознательно **не добавлен**: он либо не имел бы чего проверять, либо требовал бы новой совместной пересборки. Новый workflow выполняет только воспроизводимый source preflight и доказывает, что binary-ready gate остаётся закрыт.

## Как проверить этот шаг

```bash
export PYTHONDONTWRITEBYTECODE=1
export AIB_PINNED_SOURCE_ROOT=/path/to/clean/pinned/termux-packages
python3 scripts/audit-unified-candidate-inputs.py --source-root "$AIB_PINNED_SOURCE_ROOT"
python3 -m unittest discover -s scripts/tests -p test_unified_candidate_inputs.py -v
```

`--write-lock` обновляет inventory для review, но ничего не разрешает. `--require-aggregate-ready` обязан завершаться с кодом 2 и `AGGREGATE_BLOCKED_SIGNED_BINARY_INPUTS_MISSING`. 26 новых тестов проверяют source omissions, версии/epoch/альтернативы/subpackage parent, architecture, subpackage path/hash, cross-family source hole, изменения recipe/patch/manifest/workflow и сохранение запрета публикации. Это **не** тесты подписи или файловых коллизий настоящего aggregate. Весь scripts suite: 79 тестов с заданным clean pinned source; интеграционные тесты этого шага без него пропускаются явно.

Существующие успешные candidate workflows не изменены. Никаких новых `.deb`, публичных artifacts, Pages, production signing secret, продвижения кандидатов или изменений Builder `pkg.ensure`. Android install/runtime/project build/upgrade/rollback — **NOT RUN**.

## Неизвлекающий аудит путей payload `.deb`

`scripts/audit-deb-payload-collisions.py FILE.deb...` читает ограниченный subset формата Debian `ar` и tar в памяти, не извлекая payload на диск. Он отклоняет абсолютные/ traversal пути, ссылки (symlink/hardlink), специальные файлы, setuid/setgid, внутрипакетные и межпакетные коллизии, кроме повторных обычных каталогов. Повторное имя package/version/architecture с разными SHA-256 отвергается; одинаковые байты считаются одним входом только для отчёта, не как подтверждение provenance.

Результат намеренно содержит `qualified=false` и `provenanceValidated=false`. Это только статическая проверка пересечения payload путей; она **не** проверяет подписи/подписанную provenance, доверенные builder, ABI/ELF, зависимости, совместимость runtime, полноту набора или пригодность к установке, и ничего не агрегирует, не устанавливает и не публикует. Безопасность ограничена поддерживаемым subset: максимальный вход 512 MiB, член 128 MiB, суммарный payload 1 GiB и 200 000 записей. Форматы ar/tar extensions и компрессии вне распознаваемого набора fail closed.

Синтетические тесты: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p test_deb_payload_collisions.py -v`.
