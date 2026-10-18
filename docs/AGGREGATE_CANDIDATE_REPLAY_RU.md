# Общая проверка кандидатов без публикации

Эти инструменты проверяют только **candidate-only** набор. Они не устанавливают пакеты, не включают Pages/production feed/Builder installer и не разрешают публикацию. `qualified=false` и `productionAllowed=false` сохраняются даже при успешной проверке.

## Сначала — происхождение и одинаковые байты

Каждый исходный CI bundle необходимо проверить через `scripts/verify-retained-candidate-bundle.py`: точный producer commit, внешний fingerprint из журнала соответствующего CI run, подписи, checksum inventory, manifests и package bytes. Затем повторно выполнить профильные аудиторы.

Перед объединением повторяющиеся `(Package, Version, Architecture)` должны иметь **одинаковый SHA-256 во всех профилях**. Разные бинарники нельзя выбирать по принципу «первый подошёл». Только после полного совпадения можно оставить одну побайтно идентичную копию. Старые неподтверждённые `.deb` не являются допустимыми входами.

Общий manifest должен содержать точные `name`, `version`, `architecture`, `sha256`, `channel: candidate-only`, закрытый `releaseGate.publicationAllowed` и ложные `qualified`/`productionAllowed`. Его `target` и все 79 identities должны совпасть с producer `unified-candidate-input-lock.json`.

## Подписанный общий feed и одна APT simulation

```bash
python3 scripts/build-unified-candidate-feed.py \
  --repo-root /path/to/immutable-producer-checkout \
  --package-set /path/to/aggregate-manifest.json \
  --packages-dir /path/to/canonical-packages \
  --output /path/to/new-candidate-feed
```

Инструмент повторно проверяет package controls и точные SHA-256, требует все 12 корней и полный source-locked набор, создаёт новый тестовый ephemeral signer вне output, проверяет обе подписи Release, fingerprint, индексы и выполняет одну exact-version APT simulation для всех корней. Пакеты только скачиваются/симулируются; `apt install` не выполняется. Private key не сохраняется в output. Не следует вручную изменять staged `.deb`: для экономии места они могут быть hardlinks к проверенным входам.

Это воспроизводимая процедура проверки; новый случайный тестовый ключ, подписи и время Release не обязаны быть побайтно одинаковыми. `validation-report.json` с `valid=true` означает только перечисленные проверки feed/APT, а не подтверждённое происхождение произвольных входов, установку или production trust.

## Символы ELF и Android API

```bash
TMPDIR=/path/to/spacious-temp python3 scripts/audit-unified-elf-symbols.py \
  --packages-dir /path/to/canonical-packages \
  --platform-stubs-dir /path/to/verified-aarch64-api24-stubs \
  --report /path/to/static-elf-symbols.json
```

API stubs должны происходить из точного SHA-проверенного NDK archive закреплённого producer source. Для текущего source `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7` это NDK r30, archive SHA-256 `753611f410d002cfcd3f3dc2ef49aad532089d3180b436c060a90bf0fcb64df2`, AArch64/API24. Это интерфейсные stubs, **не runtime libraries для установки**. Официальные linker scripts не считаются ELF providers. Отдельно сохраняются archive/stub hashes и происхождение; случайный каталог `.so` не является доверенным входом.

Аудитор читает только dynamic symbols (`--dyn-syms`, не `.symtab`), проверяет AArch64 ELF64 little-endian, interpreter, SONAME/NEEDED, версии сильных импортов, TLS, конфликты провайдеров и транзитивную цепочку NEEDED. Candidate SONAME имеет приоритет: недостающие exports нельзя незаметно взять из одноимённого platform stub. Неразрешённые weak imports отмечаются отдельно. Символы, найденные лишь вне цепочки зависимостей, остаются `runtimeLoaderContextRequired`; это не PASS.

Даже symbol coverage PASS не доказывает фактическую достижимость RUNPATH/RPATH, namespace/dlopen поведение, совместимость структур C/C++, nested/static archives или runtime. Relocatable ELF сейчас отклоняются fail-closed. В отчёте остаются `loaderReachability=NOT_PROVEN`, `completeElfAbiQualification=false`, `android=NOT_RUN`. Нужны реальные Android install/upgrade/rollback и проверка исходного APK именно `com.karat.aibuilder`, а также отдельно доверенный production key/fingerprint. До их получения production остаётся закрытым.

## Регрессии

`test_unified_candidate_feed.py` использует только временные явно помеченные TEST-ONLY fixtures: настоящие GPG signatures, mixed native/Architecture: all и несколько корней одной APT simulation. Эти fixtures не устанавливаются и не сохраняются как кандидаты. `test_unified_elf_symbols.py` проверяет parser/provider/version/weak/TLS/empty-input cases; host ELF используется только как отрицательный wrong-architecture input, без выполнения.
