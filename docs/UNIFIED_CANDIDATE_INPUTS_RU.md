# Единые рецепты и новая сборка кандидатов

**Совпадение рецептов — только исходный gate, не разрешение установки.** Десять профилей содержат 144 вхождения и 79 уникальных имён пакетов. Production feed, Pages и Builder `pkg.ensure` остаются закрытыми. Legacy `.deb` не являются входами новой сборки.

## Как устранены расхождения

### libcurl: одинаковая конфигурация без неявной zstd

Закреплённый upstream рецепт `libcurl 8.23.0` не объявляет zstd в runtime dependencies, но не отключает её обнаружение configure. CMake/Ninja уже применял `--without-zstd`; Git и curl должны применять тот же проверяемый overlay. Это предотвращает неявную связь с библиотекой вне объявленной closure, не выбирая произвольный готовый бинарник. Изначальный recipe SHA-256 `0051cc33b3d3f0b69e74a00c67ba668f295b6eb3574e548154653d7e69f12025`, эффективный — `ba13efc16ac98cec77ebd9c0718c65ea69cef87c96e3cb0c27864593f8ede348`.

Это осознанное отключение optional-функции. HTTP/ABI, фактические ELF imports и работоспособность всех потребителей ещё требуют проверки новых бинарников. Совпадение версии и recipe hash не доказывает бинарную совместимость.

### ncurses: лицензия сохраняется, не удаляется

Python и pkg-config уже копировали исходный `COPYING` в `share/doc/ncurses-ui-libs/COPYING` и включали этот каталог в split subpackage. Git должен применять идентичный overlay родительского recipe и sibling subpackage, хотя UI subpackage не входит в runtime closure Git. Это сохраняет одинаковый контекст родительской сборки и лицензию, не меняя configure/compile flags. Разница не была доказанным ABI-конфликтом; её нельзя было игнорировать при выборе одинаково именованных пакетов.

## Что проверяет lock

[`unified-candidate-input-lock.json`](../unified-candidate-input-lock.json) версии 2 вычисляется из чистого source checkout `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`. Он фиксирует manifests, workflows, ordered overlays, upstream/effective recipe и sibling subpackage hashes, builder digest и modeled app-private prefix.

`--require-unified-recipes` требует отсутствия расходящихся дубликатов. Удаление одного общего overlay вновь выявляет расхождение. Shell recipes при этом не исполняются; патчи применяются к изолированным копиям с проверкой hash и допустимых путей. Это ограниченный recipe context, не полный build environment или ABI.

Lock остаётся **inventory-only**: `binarySha256=null`, `signedBinaryBundle=null`, `aggregateReady=false`, `publicationAllowed=false`. Бинарные результаты нельзя объявлять проверенными правкой этих полей.

## Повторная сборка и сохранение результатов

Candidate workflows строят из закреплённого исходного commit в digest-pinned builder с app-private properties, без скачивания готовых Termux dependency packages. Точные root versions и closure находятся в десяти `*candidate-package-set.json`.

Новый явный opt-in `workflow_dispatch` позволяет сохранить allowlisted candidate artifacts после успешных build/static audit/signed APT checks: настоящие новые `.deb`, подписанные индексы, публичный ephemeral keyring/fingerprint, отчёты, checksums и provenance. Приватные ключи, source worktrees и случайные файлы runner не должны попадать в artifact. Срок хранения ограничен; после скачивания необходимо отдельно сохранить immutable копию и её GitHub artifact digest.

**Репозиторий публичный:** Actions artifacts не являются конфиденциальным хранилищем. Это не production release, не feed для подключения и не разрешение установки. Наличие собственного keyring и подписи доказывает согласованность bundle, но не доверие к production signer; связь с exact GitHub run/commit и digest требует независимой проверки. Private signing material удаляется на runner. Стабильность байтов между двумя независимыми сборками не заявляется без сравнения.

## Что требуется после сборок

1. Скачать и проверить artifact digest каждого exact run/commit; сверить SHA-256 файлов и GPG signatures с fingerprint, полученным отдельно из run evidence. Повторно выполнить существующие аудиторы на реальных пакетах.
2. Проверить все control relations: `Depends`, `Pre-Depends`, `Conflicts`, `Breaks`, `Replaces`, `Provides`; полный payload/type/mode/link inventory и ELF/ABI/provider closure. Одинаковые name/version/architecture с разными байтами не выбирать по порядку или перезаписи.
3. Собрать один однозначный candidate set; выполнить aggregate dependency/control/payload/ELF проверки и одну signed-by APT simulation всех точных корней вместе. Проверить отказы при omission, подменах hash/signature и cross-family dependency hole.
4. Провести реальную Android install/runtime/project-build/upgrade/rollback qualification для точного APK, наблюдённых путей и двух разрешённых наборов версий. Пока все device checks — **NOT RUN**.
5. Независимо закрепить доверенный signing key/fingerprint и получить отдельное разрешение публикации. Успешный CI не включает feed, Pages или установщик.

Ограниченный `scripts/audit-deb-payload-collisions.py` читает Debian ar/tar без извлечения payload. Он fail-closed отвергает неподдерживаемые форматы, опасные пути, ссылки и специальные файлы, дубликаты файлов и несовпадающие байты одинаковых package identities; обычные повторные каталоги допустимы. Это полезный preflight, но не полный аудит ссылок/ABI и не provenance qualification. Его `qualified=false` не следует заменять на PASS.

## Проверка исходного gate

```bash
export PYTHONDONTWRITEBYTECODE=1
export AIB_PINNED_SOURCE_ROOT=/path/to/clean/pinned/termux-packages
python3 scripts/audit-unified-candidate-inputs.py --source-root "$AIB_PINNED_SOURCE_ROOT" --require-unified-recipes
python3 -m unittest discover -s scripts/tests -v
```

`--write-lock` обновляет inventory для review. `--require-aggregate-ready` по-прежнему обязан отклонять вход с `AGGREGATE_BLOCKED_SIGNED_BINARY_INPUTS_MISSING`; никакое успешное source-only сравнение этот gate не открывает.
