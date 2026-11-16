# Сборка и провижининг пакетов для встроенного Termux — v476

## Статус

Это **зафиксированный план исходной сборки**, не готовый пакетный репозиторий и не набор `.deb`. На момент v476:

- бинарные пакеты не собирались и не устанавливались;
- подписанный совместимый репозиторий, его ключ и `Release/InRelease` не создавались;
- `runtime.packages` из v475 остаётся только read-only;
- зависимости не проверены на настоящем Android-устройстве с AI Builder;
- стандартный `com.termux` apt feed, внешние `.deb` и PocketForge не используются;
- исходные версии и `TERMUX_PKG_SHA256` закреплены в [`manifest.json`](manifest.json), но сами архивы в этой задаче не скачивались и заново не хешировались.

## Целевой набор-кандидат

Корневые рецепты из lock-файла: `nodejs-lts`, `npm`, `openjdk-17`, `python`, `cmake`, `ninja`, `git`, `make`, `pkg-config`. Это **кандидаты для первого сборочного PoC, не доказанный минимум**. Package builder должен вывести полное замыкание зависимостей из закреплённого source commit; это замыкание, его версии, контрольные суммы и лицензии нужно отдельно сохранить в результатах сборки.

Node.js включён как LTS runtime; отдельный `npm` обязателен для выбранного рецепта Node 24.18.0. `openjdk-17` нужен для Gradle; Python, Git и native build helpers нужны разным RN/Expo-проектам и native modules. Ни один из этих корневых пакетов пока не доказан как совместимый именно с текущим private prefix.

## Повторяемая подготовка исходников

Работать только в чистом builder directory, сохранять исходные логи и итоговые контрольные суммы:

```sh
git clone https://github.com/termux/termux-packages.git termux-packages
cd termux-packages
git checkout --detach 505e06ef0c8dbd7611abfb90e9eb60826dcd01d7
git rev-parse HEAD
```

До сборки нужна отдельная patch/overlay для `scripts/properties.sh`. В закреплённом файле по умолчанию задаются `TERMUX_APP__PACKAGE_NAME="com.termux"` и пути Termux. Документация upstream разрешает кастомизацию ограниченного перечня переменных при полном форке, включая:

- `TERMUX_APP__PACKAGE_NAME` → `com.karat.aibuilder`;
- `TERMUX_APP__DATA_DIR` → фактический Android app data directory, полученный из установленного AI Builder;
- `TERMUX__PREFIX` и связанные layout paths → фактический validated private prefix из AI Builder;
- соответствующие `TERMUX_REPO_*` значения — только если локальная репозитория будет добавлена и настроена.

**Не подставлять путь на глаз** (`/data/data/...` и `/data/user/0/...` могут быть aliases). Не допускать package payload, maintainer script, shebang, `JAVA_HOME`, ELF RPATH/RUNPATH или symlink, выходящий за целевой private prefix. Собрать небольшой layout/probe на самом приложении и сравнить результат с параметрами fork до подготовки пакетов.

Для пробной source-сборки upstream CLI имеет форму `./build-package.sh -a aarch64 PACKAGE_1 PACKAGE_2 ...`. Не передавать `-i`/`-I`: эти опции предназначены для загрузки и извлечения готовых dependency packages. Все необходимые build/runtime dependencies должны быть построены из того же source revision либо получены из отдельного проверенного локального source cache. Любая попытка взять `.deb` из удалённого Termux feed — стоп-сигнал. Сборка допускает загрузку **исходников** по URL и проверку hash из рецепта; это не подключение package feed.

```sh
./build-package.sh -a aarch64 \
  nodejs-lts npm openjdk-17 python cmake ninja git make pkg-config
```

Этот командный пример документирует **будущую** сборку на Linux builder; его не запускали в v476. Upstream source commit и отдельные recipe `TERMUX_PKG_SHA256` являются исходными pins. Текущий upstream Dockerfile использует mutable `ubuntu:26.04` tag и `apt-get update/upgrade`; поэтому pin сам по себе **не обеспечивает byte-for-byte reproducibility**. Для строгой повторяемости потребуется зафиксировать OCI digest, snapshot host packages и build environment, затем сравнить независимые rebuilds.

## Минимальные ворота перед любой установкой

1. Зафиксировать полный source dependency closure: имя, версия/revision, source URL/commit, SHA-256, SPDX/license, build recipe commit, Android API level, ABI и builder image digest.
2. Проверить каждый `.deb` без установки: control metadata, package architecture `aarch64`, `Depends`, maintainer scripts, все архивные пути, symlink targets, ELF machine/ABI/interpreter, dynamic dependencies, RPATH/RUNPATH и наличие/отсутствие hard-coded `/data/data/com.termux`.
3. Проверить, что payload содержит только разрешённые пути внутри app-private prefix и не включает проекты, shared-storage копии, приватные ключи или внешние app данные. Каждый hook должен иметь валидный app-private shebang.
4. Проверить target-prefix ссылки/вызовы `node`, `npm`, `python`, `java`, `cmake`, `ninja`, `git`, `make`, `pkg-config` на настоящем ARM64 Android устройстве, не подменяя вывод статическим тестом.
5. Собрать пустой RN/Expo Android проект и один проект с native module на устройстве; сохранить Gradle/AGP/aapt2/D8/apksigner/NDK журналы, успешный APK и проверку подписи/идентичности. Затем повторить без сети только после прогрева wrapper, Maven/Google Maven, SDK/NDK/build-tools и npm/pnpm cache.
6. Не менять project Gradle wrapper или Android defaults ради рецепта пакетов. Каждый проект остаётся источником своих версий; build tools выбираются и проверяются относительно его Expo/RN/AGP settings.
7. Только после всех ворот создать локальный, подписанный package index/репозиторий, закрепить его public key в приложении и реализовать отдельную user-consented install-функцию. Она **не входит в v476**; read-only `runtime.packages` не превращать в installer.

## Архитектура offline-провижининга

- Пакеты поставляются отдельным локальным bundle/repository, подписанным собственной проверяемой ключевой парой; никаких изменений `com.termux` репозитория.
- Устройство сначала проверяет подпись, формат/architecture, hash, пакетные зависимости, install root и минимально допустимые права. При неизвестном ключе, prefix или архитектуре — отказ без записи.
- Google SDK/NDK компоненты и Maven/npm/Git зависимости не считать redistributable автоматически. Лицензии принимаются пользователем; proprietary Google SDK не включать в архив без подтверждённого права распространения.
- «Офлайн» означает повторную сборку после одноразового получения/лицензирования всех конкретных toolchain/SDK/Gradle/Maven/npm артефактов. Произвольный Expo-проект не станет offline-capable без его собственного dependency closure и cache.
- Все долговременные проекты остаются только в `/storage/emulated/0/AIBuilderTermux`; пакетный prefix используется для runtime-инструментов, не как второй проектный каталог.

## Почему бинарники не собраны в этой версии

У среды разработки было менее 0.3 GiB свободного диска при начале подготовки; после распаковки исходников осталось около 0.28 GiB. В закреплённом Node recipe upstream отдельно пишет, что один архитектурный build может занимать около двух часов; OpenJDK и Python также тянут существенные native dependency closures. Android package compiler и ARM64 device smoke здесь не выполнялись. Поэтому безопасный результат v476 — lock-file, проверяемая source recipe и явно зафиксированные блокеры, а не неподтверждённые `.deb`.
