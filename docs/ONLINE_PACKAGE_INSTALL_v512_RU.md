# AI Builder v512: онлайн-пакеты и установка

## Что проверено

Клиент принимает каталог только после проверки Karat-подписи, свежести и последовательности; состояние anti-replay сохраняется атомарно. Пакеты загружаются native file downloader напрямую в закрытую app-private staging-папку. Сверяются подписанные размер и SHA-256, загрузку можно отменить. Native installer перечитывает staged-каталог, строит APT dependency plan с точными именами и версиями, требует явного подтверждения и перед установкой повторно сравнивает фактическую симуляцию APT с показанным планом. Общие `pkg`, `apt` и `dpkg` команды не разблокируются.

## E2E-проверка на Karat-подписанном архиве

В качестве источника взят ровно существующий подписанный offline ZIP v508: 138 package assets, 135 записей version, 131 уникальное имя пакета. Из его содержимого локально собран Karat-подписанный online catalog с sequence `511`. Настоящий TypeScript loader загружал ответы с локального HTTP mock; native staging bridge и install boundary были замокированы, а APT выполнял только offline simulation из локального каталога.

Проверки прошли: потоковая передача всех 138 файлов (71 160 030 байт), точное сопоставление размера/хеша, manifest/index/inventory validation, трёхпакетный план `file` → `zlib`, `libmagic`, `file`, отказ при изменённом плане до любой package mutation, блокировка replay до повторного скачивания, очистка частичного stage при отмене без расходования sequence, отказ на tampered package bytes. `apt-get --simulate` предложил только ожидаемые локальные пакеты; реальная установка не выполнялась.

Это end-to-end проверка JavaScript loader и локальной APT-симуляции, не запуск Android Kotlin bridge на устройстве. Она не доказывает успешную установку или работу пакетов на Android.

## Сборка и Android-совместимость

`pnpm exec tsc --noEmit` прошёл и был повторён после feed-изменений. Более ранний запуск сообщал `pnpm test:pre-release` **117/117 PASS**, но текущая точная ревизия не прошла полный aggregate повторно: ограниченный запуск нашёл устаревший bridge hash и smoke wording. После их исправления оба guard-теста, целевые feed/install/native boundary проверки, native-source preflight и full-source syntax audit прошли отдельно; весь aggregate заново до конца не запускался.

Чистый `pnpm prebuild` ранее завершился успешно и сгенерировал ARM64 release-конфигурацию с V1/V2/V3 signing; после последнего изменения cancellation-пути prebuild не повторялся.

APK v512 не выпущен: две попытки Gradle Release прервались перезапусками execution environment, и release output не содержит APK. Поэтому для v512 не подтверждены APK manifest, подпись или установка; Android device/emulator smoke — **NOT RUN**.

Expo предупредил, что сочетание `edgeToEdgeEnabled: false` и `targetSdkVersion 36` не может отключить edge-to-edge на Android 16+. Настройку не меняли без UI-проверки: текущая конфигурация намеренно удерживает экран внутри system bars. Android 16 layout/insets остаются непроверенными.

## Почему production feed всё ещё закрыт

Закреплённые GitHub Release/Pages endpoints возвращают HTTP 404. Кандидатный репозиторий не содержит квалифицированной production inventory с pinned source provenance, полным dependency closure, лицензиями и пакетными хешами. Offline ZIP — подписанный subset, но не полный compiler/SDK/NDK toolchain. Встроенный 82-пакетный test feed остаётся test-only. Отдельно не подтверждены install, runtime, upgrade и rollback пакетов на изолированном Android ARM64 устройстве. Поэтому production feed остаётся fail-closed; новый публичный payload в репозиторий не публиковался.

Offline ZIP v508 не изменён и не переименован. Для общей Runtime-папки Android All Files Access остаётся отдельным пользовательским действием в Settings; разрешение не запрашивалось и не менялось.

## Обновление: прямая загрузка из GitHub Releases

Клиент теперь поддерживает оба варианта доставки с GitHub Releases без отдельного сервера: один `online-feed-bundle.zip` либо отдельные assets для файлов из подписанного каталога. Архив не считается доверенным: после ограниченной потоковой распаковки проверяются точный список файлов, размеры и SHA-256 по Karat-подписанному каталогу. Отдельные assets также сопоставляются с подписанными именами, размерами и хешами.

Сетевые операции ограничены дедлайнами: запросы каталога и HEAD — 20 секунд, бездействие при скачивании — 45 секунд, один transfer — 20 минут, вся операция — 45 минут, один SHA-256 — 120 секунд, native stage — 180 секунд. Отмена теперь передаётся native bridge и останавливает активный процесс; ожидание подтверждения отмены и завершения stage ограничено 5 секундами для каждого этапа. При неподтверждённой отмене результат остаётся заблокированным, а каталог не удаляется наперегонки с потенциально ещё работающим процессом — его очистка остаётся за native bridge.

Для изменённого исходного дерева прошли `tsc --noEmit`, feed runtime/hardening, native boundary, offline-bundle, полный source syntax и Android native-source preflight checks. Это статические и mock/runtime проверки; Android/Gradle сборка и реальный ARM64 runtime в этой работе не запускались. Ни один из этих результатов сам по себе не подтверждает установку пакетов на устройстве.

Живой запрос к [GitHub Release API для `aib-feed-v1`](https://api.github.com/repos/Argus-94/TERMUX_APP_PACKAGE/releases/tags/aib-feed-v1) вернул HTTP 404: production Release и assets отсутствуют. Production feed остаётся закрытым, ничего в GitHub не опубликовано. Существующий source archive создан до этих изменений и их не содержит; v512 APK не создан.
