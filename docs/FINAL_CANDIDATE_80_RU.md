# Кандидат из 80 пакетов: воспроизводимость подтверждена, production закрыт

**Набор собран и сохранён для проверки, но не допущен к установке или публикации.** Итоговый статус — `REPRODUCIBLE_CANDIDATE_ELF_RUNTIME_BLOCKED`: ELF-аудитор остаётся `FAIL`, Android-проверки — `NOT_RUN`. Эти ограничения не заменены зелёным CI.

## Что готово

Канонический набор содержит 79 основных пакетов и дополнительный `termux-licenses 2.2`: всего **80 пакетов**, из них 75 `aarch64` и 5 `all`, для моделируемого приватного runtime `com.karat.aibuilder`. Legacy pool из 133 `.deb` не использовался как вход этих сборок и не становится доверенным.

Воспроизводимость подтверждена для **80/80** пакетов. Все 36 пакетов OpenJDK-профиля побайтно совпали в [первой](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39177655402) и [второй](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39177662093) независимых CI-сборках. Остальные девять профилей повторно собраны, проверены по подписям и сопоставлены с ранее независимо проверенными байтами; неизменность их effective source inputs проверена отдельно. Для пакета лицензий [один CI run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39178098496) сравнил две чистые сборки и подписал результат.

| Проверка | Фактический результат |
|---|---|
| Payload, типы, modes, ссылки и общая dependency closure | PASS |
| Debian control metadata и maintainer scripts | PASS в пределах статического аудитора |
| Один подписанный APT transaction всех 13 точных корней | PASS; без установки |
| Общие / package-kit unit tests | 270 / 149 прошли |
| Инвентаризация 490 candidate ELF против закреплённых API-24 stubs | Нет отсутствующих в общем inventory strong symbols; есть два runtime-context требования |
| Полный ELF/ABI и Android runtime qualification | Не подтверждены |

Машинные результаты: [итоговая сводка](evidence/candidate80/final-audit-summary.json), [80 точных package identities и SHA-256](evidence/candidate80/aggregate-manifest.json), [покрытие повторными сборками](evidence/candidate80/full-reproducibility-coverage.json).

## Что исправлено в исходниках

Общие рецепты libcurl используют одинаковое отключение неявной zstd; ncurses сохраняет исходный `COPYING`. Packaging policy задаёт детерминированный `Installed-Size` и приватные directory modes. Для API 24 отключён только optional AAudio backend PulseAudio, требующий API 26; OpenSLES сохранён. OpenJDK использует фиксированный source date, штатный reproducible compiler seed и `gzip -n`.

Producer commit — `9acaf2fe959f728680569b7794ee5234f01b7954`; pinned Termux source — `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`. [PR #26](https://github.com/Argus-94/TERMUX_APP_PACKAGE/pull/26) merged как `4033e8fad9ca6f7fda5d40a84301b8d733e6196c`; его source tree совпадает с producer. Никакие готовые stock `com.termux` пакеты не подставлялись.

## Почему ELF gate остаётся красным

В `lib/pulseaudio/modules/libwebrtc-util.so` два импорта — `pa_echo_canceller_get_capture_volume` и `pa_echo_canceller_set_capture_volume` — требуют контекста загрузки `module-echo-cancel.so`, где эти symbols действительно экспортируются. Их наличие в наборе не доказывает доступность для конкретного Android process. Также отдельно сохранены 89 unresolved weak imports; их фактическое runtime поведение не проверено.

Исходный аудитор **не изменён для получения PASS**: его `FAIL` и exit code 2 сохранены. Retention replay лишь сохраняет доказательства с этими двумя явно перечисленными блокерами; он не квалифицирует ABI. Install, runtime, project build, upgrade и rollback на реальном APK/устройстве не выполнялись: APK/device недоступны.

## Где сохранены доказательства

В существующем **draft/prerelease**, без публикации, сохранены 12 новых исходных CI ZIP, финальный архив и inventory. GitHub REST asset digests сверены; архив повторно прочитан с проверкой всех **283 файлов**. Внутри — точные 80 `.deb`, подписанный candidate feed, публичные keyrings, provenance, отчёты и analysis-only API-24 stubs. Private signing material не включён.

Архив: `aggregate80-static-reproducible-evidence-9acaf2f.tar.gz`.

```text
SHA-256: 46f3341b8933ad76fa62b9a6713172e997ee65b02186446e62ae237f6a74dd76
```

См. [archive inventory](evidence/candidate80/aggregate-archive-inventory.json) и [REST retention proof](evidence/candidate80/final-candidate-retention-proof.json). Доступ к draft требует прав владельца репозитория; это не публичный feed URL. После скачивания сначала сверяется внешний SHA-256, затем внутренний `SHA256SUMS`, а подписи отдельных source bundles проверяются с fingerprint из соответствующих CI logs, не из самого bundle. Команды independent verifier описаны в [source/candidate guide](UNIFIED_CANDIDATE_INPUTS_RU.md).

**Дальнейший допуск:** нужны реальные Android/loader-context проверки, отдельно доверенный production signer/fingerprint и отдельное разрешение публикации. Inventory lock остаётся source-only; `qualified=false`, `productionAllowed=false`. Pages, production feed и Builder `pkg.ensure` не включались; [снимок GitHub](evidence/candidate80/github-publication-state.json) показывает Pages выключенными и отсутствие опубликованных releases.
