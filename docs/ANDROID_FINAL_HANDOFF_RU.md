# Финальная проверка кандидата на Android

**Пакетная сборка завершена, но допуск к production не выдан.** 80 пакетов воспроизводимы; подписи, payload/control и signed APT transaction подтверждены. Новый анализ объясняет корректный путь двух WebRTC-символов через родительский модуль. Заменять этим запуск на телефоне нельзя.

## Что использовать

Репозиторий: `Argus-94/TERMUX_APP_PACKAGE`. Неизменённый producer: `9acaf2fe959f728680569b7794ee5234f01b7954`; исходный Termux tree: `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`. Начальное состояние main для этого анализа: `bc9328d5bf2c2dd1d8bd7130d2d4f0e28f200059`.

80 `.deb`, подписанный тестовый feed и исходные доказательства находятся в **неопубликованном draft/prerelease** `candidate-static80-evidence-20261019`, release ID `416777571`. Основной архив:

```text
aggregate80-static-reproducible-evidence-9acaf2f.tar.gz
SHA-256 46f3341b8933ad76fa62b9a6713172e997ee65b02186446e62ae237f6a74dd76
```

До установки сверить внешний SHA-256, внутренний `SHA256SUMS`, подписи provenance и source bundles с fingerprints из независимых CI logs. Публичный ключ внутри архива сам по себе не создаёт доверия. Эфемерный candidate signer не должен становиться production trust anchor. Подробная исходная инструкция — `docs/UNIFIED_CANDIDATE_INPUTS_RU.md` и `docs/FINAL_CANDIDATE_80_RU.md` репозитория.

Контрольный APK v491: package `com.karat.aibuilder`, minSdk 24, targetSdk 36, arm64; SHA-256 `9c1a480d78ef4356c7f33844a6a8a94306b47f5920228a72c7e22723c5fe00d4`. Это debug-signed APK, не подтверждение production signer.

## До теста

Нужны отдельная тестовая копия/профиль с возможностью восстановления, свободное приватное хранилище и сохранённая рабочая baseline. Не заменять единственную рабочую среду и не очищать app data ради проверки. Зафиксировать Android SDK, модель/ABI, UID приложения, APK hash, фактические `PREFIX`, `PATH`, `LD_LIBRARY_PATH` и текущие package versions.

Installer намеренно выключен: feed key/fingerprint в проверенном приложении `UNPROVISIONED`. Поэтому «нажать install» сейчас недостаточно. Сначала нужен отдельно проверенный **тестовый** путь provisioning именно signed candidate и его доверия; не включать production feed/Pages/Builder и не использовать `--allow-unauthenticated`, `trusted=yes` или stock `com.termux` пакеты. Если безопасный test-only provisioning недоступен, остановиться с `BLOCKED`, а не обходить gate.

Оба harness проверяют UID владельца app data directory; это защита от случайного запуска другим UID, не замена проверке package identity, APK hash и signer на устройстве.

Все проверки ниже запускать через реальную встроенную терминальную сессию/bridge **того же приложения и UID**, не через обычный Termux и не из adb shell с другим UID. Иначе тестируется другое окружение.

## 1. Установка и точный состав

Установить только утверждённый тестовый набор штатным signed APT путём. До и после сохранить APT output, `dpkg-query`, hashes и контроль состояния baseline. Все 13 root specs должны совпадать:

```text
make=4.4.1-1          gh=2.102.0          git=2.56.0
curl=8.23.0          wget=1.25.0-1       pkg-config=0.29.2-3
python=3.14.6-1      nodejs=26.4.0-1     npm=11.20.0
openjdk-17=17.0.20   cmake=4.4.4         ninja=1.13.2
termux-licenses=2.2
```

Сверить весь состав 80 пакетов с aggregate manifest, а не только 13 корней. Ниже приведены тестовые команды, **не скрипт установки**.

## 2. Загрузчик двух WebRTC-символов

Harness-файлы находятся в `scripts/runtime-validation/` репозитория или `tests/` архива дополнения. Команды сборки/запуска ниже выполняются из каталога с этими файлами.

Собрать `android-module-loader-probe.c` закреплённым Android NDK r30 (`30.0.16248370`) для `aarch64-linux-android24`, например на Linux build machine:

```bash
CC="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang"
"$CC" -O2 -Wall -Wextra -Werror android-module-loader-probe.c -ldl -o android-module-loader-probe
```

Сохранить compiler version и hash бинарника; передать его в приватный тестовый каталог приложения. Затем в app terminal:

```bash
./android-module-loader-probe "$PREFIX/lib/pulseaudio/modules/module-echo-cancel.so"
```

Требуется exit code 0 и оба provider, совпадающие по inode с `module-echo-cancel.so`. Probe открывает **родительский модуль** через `RTLD_NOW|RTLD_LOCAL` и проверяет оба символа; он не вызывает `pa__init`/capture callbacks. Нельзя вместо этого открывать helper отдельно или выдавать host-результат за Android PASS. Ошибки exec, namespace, SELinux, symbol/SONAME, зависимости — сохранять полностью, не исправлять окружение скрытно.

## 3. Настоящий PulseAudio module/init/processing

После шага 2 запустить в том же app terminal:

```bash
bash android-echo-cancel-smoke.sh
```

Скрипт создаёт отдельный PulseAudio process, приватный Unix socket, два null sinks и WebRTC echo-cancel; запускает краткую playback/record обработку. Он не устанавливает пакеты, не меняет глобальный config, не останавливает существующий daemon, не открывает TCP и не использует микрофон. Останавливает только созданные им PID. В выводе указан приватный каталог с config, environment, server/client logs, списками модулей/источников и capture output.

PASS здесь означает module init и обработку null-audio, **не качество микрофона/динамика и не проверку всех API paths**. Физическое OpenSLES audio, AGC/volume callbacks, resume/background и длительная работа проверяются отдельно с разрешениями пользователя. Не отключать memfd/другие функции только ради зелёного smoke.

## 4. Инструменты и сборка проекта

Проверить запуск всех 12 native/tool roots и npm, затем минимальные реальные действия: Python import/SSL, Node/npm local project, Java compile/run, CMake/Ninja configure/build, make и pkg-config, Git/curl/wget/gh штатными локальными или разрешёнными сетевыми сценариями. Сохранить stdout/stderr и exit codes.

Провести целевую сборку проекта внутри приложения до итогового артефакта. Важно: baseline из 80 пакетов сам по себе не обещает наличие Android SDK/Gradle/C/C++ compiler и всех project dependencies. Отсутствующий инструмент — отдельный `BLOCKED`, не «сборка прошла». Установку дополнительных инструментов и сеть не скрывать от отчёта.

## 5. Upgrade и rollback

Только после успешной чистой установки, в восстанавливаемой тестовой среде: baseline → candidate → повторный запуск/проект → возврат к точной baseline → повторные проверки. Сохранить hashes, versions, conffile decisions, maintainer-script output и состояние проекта. Если baseline/средства восстановления отсутствуют, пометить оба шага `NOT_RUN/BLOCKED`; не делать разрушительную имитацию rollback.

## Какой результат вернуть

Один архив с environment/APK/package identities, output каждого этапа, loader-probe output, isolated PulseAudio logs, project build logs, upgrade/rollback evidence и таблицей `PASS / FAIL / BLOCKED / NOT_RUN`. Для API-24 совместимости нужен тест на API 24; успех только на новом Android не доказывает нижнюю границу. Отдельно полезен современный Android с targetSdk 36 restrictions.

До проверки логов сохраняются исходный `ELF auditor FAIL`, `android=NOT_RUN`, `qualified=false`, `productionAllowed=false`. После теста статусы меняются только по фактическим доказательствам. Даже успешный Android-тест не разрешает публикацию автоматически: production signer/trust и разрешение публикации — отдельные решения.
