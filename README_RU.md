# TERMUX_APP_PACKAGE — пакеты для AI Builder

Изолированный candidate APT-набор для приватного runtime AI Builder (`com.karat.aibuilder`, `aarch64`). Не предназначен для stock Termux; не использует feed или пакеты `com.termux` и не имеет отношения к PocketForge.

## Новый объединённый кандидат: 80 пакетов

[Итоговые доказательства и ограничения](docs/FINAL_CANDIDATE_80_RU.md): воспроизводимость подтверждена для 80/80 пакетов, payload/control и общая signed APT simulation 13 корней прошли. **ELF gate остаётся FAIL из-за двух PulseAudio loader-context требований; Android — NOT_RUN.** Архив и 12 новых исходных CI ZIP сохранены в draft с проверенными digests. Это не production feed и не разрешение установки.

## Исторический pool и отдельные кандидаты — production закрыт

- Legacy pool, сохранённый с `2a2dd775` (merge PR #9; PR #8 добавил Java), содержит 133 `.deb`. У него нет полного подтверждённого build provenance, а три записи — `fontconfig`, `libx11`, `termux-auth` — остались неподтверждёнными статическим аудитом. Не устанавливать этот pool как доверенный набор.
- **CMake + Ninja:** pinned roots `cmake` `4.4.4` и `ninja` `1.13.2`, required closure 22 пакета / 34 dependency alternatives. [Успешный hosted CI run 39086630210](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39086630210), head `d038f6080babd6f465cb6d1dbb0baf253ec65171`.
- **OpenJDK 17:** pinned root `openjdk-17` `17.0.20`, required runtime closure 36 пакетов / 46 dependency alternatives; recommendations не входят в required closure. [Успешный hosted CI run 39080124869](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39080124869), head `d58ede99b4b746d7a4ed4253d33b575ffd323d8a`.
- Кандидатные workflows выполняют source build, static audit и проверку временного подписанного APT feed с `signed-by` / `apt-get --simulate`; hosted CI не устанавливает пакеты на Android и не доказывает runtime, project build, upgrade или rollback. Эти пять Android проверок — **все NOT RUN**.
- CI моделирует app-private prefix; это не измерения реального APK/устройства. Ручной evidence review не является криптографической аттестацией, автоматического candidate → production promotion нет.
- Исторический Make device-test artifact истёк 2026-10-16; он не является новым каноническим кандидатом из 80 пакетов. GitHub Pages/production feed не объявляются в этом документе.

Остальные отдельные кандидаты сохраняются в `main`: Make `4.4.1-1` (1 пакет), gh `2.102.0` (1), Git `2.56.0` (14), curl `8.23.0` (9), wget `1.25.0-1` (11), pkg-config `0.29.2-3` (22), Python `3.14.6-1` (17), Node.js `26.4.0-1` + npm `11.20.0` (11). Это размеры отдельных required closures, не сумма уникальных пакетов и не разрешение объединять feeds. Полные версии/входы находятся в соответствующих `*candidate-package-set.json`.

Версии и package locks приведены в [CMake+Ninja manifest](cmake-ninja-candidate-package-set.json), [его closure](toolchain-candidate-source-closures/cmake-ninja-candidate.json), [OpenJDK manifest](openjdk17-candidate-package-set.json) и [его closure](toolchain-candidate-source-closures/openjdk17-candidate.json). Полный статус gate и практичная Android qualification matrix: [docs/PRODUCTION_GATE_RU.md](docs/PRODUCTION_GATE_RU.md). Настройка APT feed описана в [APT_REPO_SETUP_RU.md](APT_REPO_SETUP_RU.md); это не разрешение на публикацию.

До отдельного разрешения запрещены production publish, Pages/signing/pkg.ensure promotion, `trusted=yes` и любые insecure APT flags, использование stock `com.termux`, legacy debs как доверенной базы, fake/bypass packages и PocketForge. Успешный CI не равен Android proof или production approval.

## Локальные policy-проверки

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -v
bash scripts/test-device-test-artifact-staging.sh
bash scripts/test-candidate-feed-policy.sh
bash scripts/test-candidate-dependency-closure.sh
bash scripts/test-pinned-termux-recipe-closure.sh
bash scripts/test-signed-feed-smoke.sh
```

Handoff tests используют только synthetic fixtures и ephemeral signatures, ничего не устанавливают и не публикуют. Make-only staging связывает подписи с точными индексами и повторно проверяет candidate provenance policy. Для upgrade/downgrade на Android всё ещё нужны два проверенных набора версий; для native/Android project build — отдельно проверенные compiler/Gradle/SDK, если они нужны проекту. Существующие кандидаты этого не заменяют.
