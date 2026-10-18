# Проверка пакета Android evidence

## Это подготовка, а не выполненные Android-тесты

`scripts/validate-android-qualification.py` проверяет структуру, подпись и целостность будущего evidence bundle. Сейчас реального Android evidence нет: установка, runtime, project build, upgrade и rollback остаются **NOT RUN**. Скрипт не устанавливает пакеты, не подключает feed, не меняет manifests, не открывает `pkg.ensure`, Pages или production.

Успешный результат означает только: предоставленные файлы согласованы и заявление подписано заранее выбранным ключом. Он **не доказывает**, что команды выполнялись на Android, логи правдивы, APK имеет заявленный certificate или candidate feed корректно подписан. Эти проверки требуют отдельного review исходных журналов и APK/feed и реального прогона [qualification matrix](PRODUCTION_GATE_RU.md). Файлы-снимки состояния должны содержать фактические версии пакетов: различие их хэшей само по себе не доказывает обновление версии.

## Независимый ключ доверия

Подпись evidence — detached GPG signature точных байтов JSON. Публичный keyring и ожидаемый fingerprint подписанта передаются **отдельно**, из заранее проверенного доверенного источника. Нельзя объявлять ключ доверенным только потому, что он лежит рядом с evidence, и нельзя использовать candidate feed keyring как authority для evidence. В рамках этой работы production/evidence signer не назначается и секреты не создаются.

Валидатор проверяет успешный `gpgv` и точный primary fingerprint `VALIDSIG`, включая случай подписи subkey. Случайный ключ из bundle и подмена fingerprint приводят к отказу. Подпись удостоверяет автора заявления, а не достоверность наблюдений устройства.

## Содержимое JSON версии 1

Неизвестные и повторяющиеся JSON-поля запрещены. Обязательные верхнеуровневые поля:

- `schemaVersion: 1`, `applicationId: "com.karat.aibuilder"` и `candidateManifestSha256` точного файла candidate manifest.
- `apk`: `artifact` с путём/хэшем APK, `signingCertificateSha256`, непустой `versionName`.
- `device`: `apiLevel` (целое, не ниже 24), `abi: "aarch64"`, непустой `buildFingerprint`, наблюдённые `observedDataDir` и `observedPrefix`. Допускается `/data/user/<userId>/com.karat.aibuilder` либо `/data/data/com.karat.aibuilder`; prefix строго равен `<dataDir>/files/usr`.
- `feed`: HTTPS `url` без credentials/query/fragment, `keyFingerprint` и ссылки `keyring`, `release`, `inRelease` на сохранённые файлы. Это сохранённые свидетельства, не разрешение подключать URL.
- `projectSourceSnapshot`: ссылка на архив/снимок точных исходников проекта.
- `checks`: ровно `install`, `runtime`, `projectBuild`, `upgrade`, `rollback`.

Каждая ссылка на artifact — ровно `{ "path": "relative/path", "sha256": "64 lowercase hex characters" }`. Путь относительный и канонический, без `..` и symlink-компонентов; SHA-256 проверяется по файлу. APK, feed metadata/keyring, исходники, журналы и снимки состояния должны существовать. JSON не должен содержать приватных ключей, токенов, персональных данных устройства или пользовательских проектов без разрешения.

Каждая проверка содержит ровно `status: "PASS"`, UTC `timestamp` в ISO-формате с `Z` и непустой `commands`. Каждая command record содержит `command`, целочисленный `exitCode: 0`, ссылку `log`. Невыполненная или неуспешная проверка не подходит для полного bundle и должна остаться NOT RUN/FAIL во внешнем рабочем журнале — нельзя заполнять PASS ради прохождения валидатора.

Для `upgrade` и `rollback` дополнительно обязательны `beforeSnapshot` и `afterSnapshot`. Хэши до/после должны различаться; rollback начинается с upgrade-after и возвращает точные байты upgrade-before. Это связь сохранённых package-state snapshots, а не сравнение исходников проекта. Перед тестом отдельно утвердить две реальные source-built версии и определить нормализованный формат снимков package state; изменение timestamp в одном и том же наборе не считается upgrade.

Переданный candidate manifest должен сохранять `channel: "candidate-only"`, целевой app/ABI и `releaseGate.publicationAllowed: false`. Даже согласованный bundle не меняет эти поля.

## Запуск после реального прогона и review ключа

```sh
python3 scripts/validate-android-qualification.py \
  --evidence /path/to/evidence.json \
  --signature /path/to/evidence.json.sig \
  --artifact-root /path/to/artifacts \
  --candidate-manifest /path/to/exact-candidate-package-set.json \
  --trusted-keyring /separately-reviewed/evidence-signers.gpg \
  --expected-fingerprint UPPERCASE_PRIMARY_KEY_FINGERPRINT
```

Пример содержит placeholders, не готовый ключ/пакет. Exit code `0` сопровождается `EVIDENCE_BUNDLE_CONSISTENT device_claims_independently_verified=0 production_publication=blocked pkg_ensure=blocked`; любой отказ возвращает `2`. Ни `0`, ни ручная правка JSON не являются production approval.

## Regression tests

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p 'test_android_qualification.py' -v
```

Тесты создают временные локальные ключи и искусственные байты/заявления, проверяют действительную криптографическую подпись и негативные случаи. Они не запускают Android, не собирают APK и не публикуют artifacts. Секретный тестовый ключ удаляется вместе с временным каталогом; он никогда не используется как production trust anchor.
