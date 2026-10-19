# PulseAudio: что доказано и что остаётся проверить

**Пересборка пакетов по результатам этого анализа не требуется: подтверждённого дефекта исходников не найдено.** Для двух символов WebRTC установлен конкретный корректный loader-контракт, а не просто наличие provider в наборе. Но реальный запуск на Android не выполнен, поэтому исходный ELF gate остаётся `FAIL`, `qualified=false`, `productionAllowed=false`.

## Два strong-импорта: важен родительский модуль

В точных ELF кандидата `libwebrtc-util.so` импортирует `pa_echo_canceller_get_capture_volume` и `pa_echo_canceller_set_capture_volume`: `GLOBAL`, `UND`, `NOTYPE`, без symbol version; relocation — `R_AARCH64_JUMP_SLOT`. В `module-echo-cancel.so` обе функции определены как `GLOBAL DEFAULT FUNC`, без версии. Это совместимые имена и видимость; `NOTYPE` импорта не означает отсутствие функции.

`module-echo-cancel.so` имеет **прямой `DT_NEEDED` на `libwebrtc-util.so`**. SHA-256 точных библиотек:

```text
module-echo-cancel.so 31ec3001982525eb9d66487a418b133e7ccf719ed32ffe6bd3322862016e2c00
libwebrtc-util.so     90b77eb9eadfb7578eae320545d72e6073e665b9cecd73606a2062fd3b8f1f8d
```

Это намеренная upstream-архитектура. В [PulseAudio 17.0, echo-cancel/meson.build](https://github.com/pulseaudio/pulseaudio/blob/1f020889c9aa44ea0f63d7222e8c2b62c3f45f68/src/modules/echo-cancel/meson.build#L1-L8) прямо объяснены обратные ссылки helper на модуль. [modules/meson.build](https://github.com/pulseaudio/pulseaudio/blob/1f020889c9aa44ea0f63d7222e8c2b62c3f45f68/src/modules/meson.build#L287-L301) связывает модуль с helper; строки 313–333 создают shared module с `link_with: extra_libs`. [webrtc.cc](https://github.com/pulseaudio/pulseaudio/blob/1f020889c9aa44ea0f63d7222e8c2b62c3f45f68/src/modules/echo-cancel/webrtc.cc#L340) действительно вызывает эти функции, а не только объявляет их.

[pa_module_load](https://github.com/pulseaudio/pulseaudio/blob/1f020889c9aa44ea0f63d7222e8c2b62c3f45f68/src/pulsecore/module.c#L115-L150) открывает **родительский модуль** через `lt_dlopenext(name)`. В закреплённом рецептом libtool 2.6.2 `lt_dlopenext` задаёт extension advice, но не global advice; dlopen backend использует `RTLD_LAZY` без `RTLD_GLOBAL`. Сам helper содержит `BIND_NOW`/`DF_1_NOW`, поэтому полагаться на отсрочку разрешения нельзя. Архив libtool проверен по recipe SHA-256 `24adb3aa9ae035c70faba344af57d73215eb89281045af6c7ccd307751f8b0bf`.

**`RTLD_GLOBAL` для этой схемы не обязателен.** В [Bionic Android 7/API 24, linker.cpp](https://android.googlesource.com/platform/bionic/+/7cdb481dfe626524c93e4b6a1aae4621b1beedbc/linker/linker.cpp#2118) `find_libraries` сначала формирует local group из корня и его `DT_NEEDED` closure, затем передаёт **одну и ту же группу** каждому `link_image`. `soinfo_do_lookup` ищет сначала global, затем local group; определённость и GLOBAL/WEAK binding проверяются отдельно от типа импортируемого символа. Следовательно, при первом открытии `module-echo-cancel.so` helper видит функции родителя в общей группе. Это согласуется с [официальным описанием Android](https://android.googlesource.com/platform/bionic/+/android-n-mr2-preview-1/android-changes-for-ndk-developers.md): `RTLD_LOCAL` ограничивает последующие независимые `dlopen`, а не взаимодействие участников одной `DT_NEEDED`-группы.

Контракт условный: точные файлы должны быть найдены в одном доступном namespace, родитель должен открываться первым штатным путём, не должно быть подмены SONAME, несовместимых библиотек или стороннего preload. Изолированное открытие helper — другой, неподтверждённый сценарий. Проверки путей, namespace и реально запущенного приложения требуют Android.

## Синтетическая проверка: 6/6

`test_loader_contract.py` строит маленькую независимую ELF-схему с обоими именами функций и вызывает getter/setter. Положительные контроли: родитель с helper через `RTLD_LOCAL`, через `RTLD_GLOBAL` и через host `lt_dlopenext`. Отрицательные: helper отдельно и helper после несвязанного `RTLD_LOCAL` provider. Последний контроль — тот же несвязанный provider через `RTLD_GLOBAL` — успешен. Отрицательные загрузки действительно завершаются undefined-symbol error, что показывает, почему простая co-presence недостаточна.

Все шесть ожиданий выполнены на Linux/glibc. Это проверка модели загрузки, **не запуск candidate ELF и не Android ABI qualification**. Для реального устройства подготовлены отдельные C probe и изолированный PulseAudio smoke test.

## 89 weak-импортов: не автоматический PASS или FAIL

Полный список сохранён по каждой паре consumer/symbol. Это 15 уникальных имён; количество записей не равно количеству функций или достижимых вызовов.

| Группа | Записей | Что установлено |
|---|---:|---|
| `memfd_create` | 68 | В трёх исследованных Abseil DSO — weak dynsym/GOT без найденного обращения к соответствующему слоту и без вызова. **Не распространяется автоматически на все 68.** Точный механизм массового появления и полнота анализа каждого consumer не доказаны. |
| `getentropy` | 1 | OpenSSL: GOT pointer проверяется `cbz` перед вызовом; исходник предусматривает fallback к Linux `getrandom` syscall при отсутствии/ENOSYS. Работоспособность fallback и entropy на устройстве не проверена. |
| Четыре `ZSTD_trace_*` | 8 | Optional tracing hooks. В исходниках zstd 1.5.7 есть NULL guards; Node 26.4.0 содержит zstd 1.5.7. Сохранены disassembly-примеры всех четырёх hooks в каждом точном ELF. Наличие BL само по себе не является безусловным вызовом. |
| LSan: enable/disable/ignore_object | 5 | GLib 2.90.1 `glib-private.h`: weak declarations и отдельные NULL guards в dynamic-ASan ветке. Source archive сверён с recipe SHA-256. |
| `__gcov_dump`, `__gcov_flush` | 2 | Abseil 20260526.0: проверки адресов в `LogMessage::FailWithoutStackTrace` перед optional coverage flush. |
| `main` | 2 | PulseAudio `util.c`: `_main` проверяется перед `dladdr`; сама main не вызывается. Это необязательная идентификация процесса. |
| `g_get_application_name` | 1 | PulseAudio `proplist-util.c`: проверяется weak alias, затем вызывается для metadata приложения. |
| `collector_func_load` | 1 | OpenJDK 17.0.20 `forte.cpp`: conditional wrapper проверяет weak profiler hook. |
| V8 TLS initializer accessor | 1 | В точном Node ELF GOT pointer проверяется `cbz` перед BL; затем отдельно выполняется `__emutls_get_address`. Это не unresolved TLS data-symbol. |

Для 21 записи вне `memfd_create` найден конкретный source/binary guard-контракт; это **не полный аудит каждого пути конкретного ELF** и не доказательство работы всех fallback на Android. Слабые импорты не удалялись из gate, `.deb` не перепаковывались.

## Что показывает приложение

Проверен APK v491 `com.karat.aibuilder`, minSdk 24 / targetSdk 36, SHA-256 `9c1a480d78ef4356c7f33844a6a8a94306b47f5920228a72c7e22723c5fe00d4`. Исходники задают prefix `filesDir/usr`, `PATH` внутри prefix и `LD_LIBRARY_PATH=<prefix>/lib` через `ProcessBuilder`. Это правильное место для проверки, но не evidence успешного исполнения.

В проверенном app-коде нет явного запуска PulseAudio/WebRTC; native libraries APK этих модулей не содержат. Ключ signed feed намеренно `UNPROVISIONED`, installer закрыт. Поэтому реальная установка пакетов, запуск daemon и достижимость echo-cancel в приложении **не доказаны**. Подробные file:line и hashes сохранены в app evidence.

## Итог

Исходная гипотеза «родитель не виден helper из-за RTLD_LOCAL» для штатного loader-пути не подтверждается: Bionic local group даёт исходно обоснованный путь разрешения. Изменять upstream loading semantics, добавлять `RTLD_GLOBAL`, отключать WebRTC или ослаблять ELF gate оснований нет.

Пакеты, signatures, pinned recipes и production settings не менялись. Сохраняется статус кандидата `REPRODUCIBLE_CANDIDATE_ELF_RUNTIME_BLOCKED`; install/runtime/build/upgrade/rollback — `NOT_RUN`. Финальный допуск требует Android-тестов, отдельно доверенного production signer и отдельного разрешения публикации. Pages, production feed и Builder installer остаются выключены.
