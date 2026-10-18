# Почему совпадающие исходники дали разные `.deb`

Объединять кандидаты по одному имени и версии нельзя. Сначала сравниваются полные SHA-256 каждого повторяющегося пакета; при различии сборка общего набора останавливается. Готовые `.deb` не исправляются и не перепаковываются.

## Что доказали свежие сборки

В snapshot `27b1cd7e381af8340560c7a630837d5dd36a31bc` исходники, private-prefix overlays и builder image закреплены. Сохранённые кандидаты прошли независимую проверку GitHub artifact digest, fingerprint из отдельного run log, подписей, индексов и привязки provenance к исходникам и байтам пакетов. Это ephemeral CI-подпись, а не доверенная production-подпись.

У `libcurl 8.23.0` из [curl run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39141315237) и [CMake/Ninja run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39141352841) разные SHA-256 `.deb`, но побайтно одинаковый `data.tar.xz`:

`1d66cc2247293e4e08ea2acfb9c9b49ff45a1a6c208c9fa073921aa388a34d88`.

Различается `Installed-Size`: `3560` и `3564`. Git воспроизводит второй вариант. У `libssh2 1.11.1-2` сравнение curl и [Git run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39141309078) также даёт одинаковый `data.tar.xz`:

`9f2ccb6f01d6af3378ee426eeb34cc475fd2439419df46b7fe4983afb4709355`,

но `Installed-Size` равен `1160` либо `1164`. Это не доказательство полной Android ABI-совместимости: оно устанавливает конкретное отличие контейнеров при одинаковом payload.

Закреплённый source packager вычислял это поле через `du -sk .`. Такой результат зависит от физического размещения каталогов и файлов на filesystem сборщика. [Политика Debian](https://www.debian.org/doc/debian-policy/ch-controlfields.html#installed-size) определяет оценку по размерам файлов и symlink с округлением до KiB и базовым KiB для остальных объектов. Новая source-packaging policy должна вычислять её детерминированно до создания архива, а не менять существующий control внутри готовой `.deb`.

Общий payload audit выявил и самостоятельное расхождение modes: общий `usr` у `curl` имеет `0755`, у нескольких зависимостей — `0700`. Это не следует скрывать разрешением произвольных directory collisions.

## Как исправляется источник проблемы

Hash-checked source policy применяется ко всем десяти build entrypoints. Она закрепляет оценку `Installed-Size`, сохраняет содержимое, modes обычных файлов, symlink и лицензии, а каталоги внутри private-prefix делает `0700`. Данные предназначены для одного Android app UID; доступ group/other не добавляется. Сам `data.tar` включает только private `files/usr` и его содержимое, без directory headers родительских Android-путей. Policy не меняет каталоги установленного Android и не запускает пакеты.

Точные исходные и изменённые hashes обеих packaging functions, helper и applier должны присутствовать в `unified-candidate-input-lock.json`. Смена исходного packaging кода либо удаление вызова policy из одного профиля останавливает preflight. Source recipes `libcurl` и `ncurses` остаются согласованными; сохранение исходного `COPYING` в обоих split-пакетах ncurses не отменяется.

## Какие доказательства ещё нужны

После изменения packaging policy требуется новый полный source rebuild. Старые кандидаты остаются диагностическими и не подмешиваются к новому feed. Затем нужны побайтное сравнение всех повторений, полный общий control/payload/ELF/ABI audit и одна signed-by APT simulation всех 12 точных корней с ожидаемым закрытием из 79 пакетов. Многокорневой APT helper не устанавливает пакеты и не разрешает неподписанные источники.

Даже успешный Linux CI не заменяет фактические Android install/upgrade/rollback и проверку private-prefix на `com.karat.aibuilder`. Без этих evidence и доверенного production key/fingerprint публикация feed, Pages и Builder installer запрещена. Ephemeral candidate keys не становятся production keys автоматически.

## До дорогого rebuild

После всех recipe/properties overlays каждый wrapper повторно проверяет точные hashes обеих изменённых packaging functions и установленного helper через `--verify-only`. Source patch-scope guards допускают только два явно названных новых файла, не произвольные изменения `scripts/`. ROOT определяется после KIT_DIR.

PR source-preflight запускает весь generic suite и все десять пакетных suites с сохранёнными reviewed builder-hash pins. Дополнительный host fixture выполняет подготовку всех десяти настоящих wrappers на закреплённом checkout и останавливает их Docker stub до контейнера/компиляции. Он выявляет ошибки путей, source guard и порядка apply/verify, но не создаёт candidate packages и не заменяет настоящий rebuild или Android qualification.
