# Подпись APT feed AI Builder — ограниченный smoke test

Эта ветка проверяет только, что repository Actions secret соответствует закреплённому публичному keyring, генератор выпускает `Release` с SHA-256 для `Packages`/`Packages.gz`, `InRelease` и `Release.gpg` проходят `gpgv`, APT принимает локальный `signed-by=<keyring>` источник и отказывается от изменённого `Packages` index.

## Границы

- Workflow запускается только при изменениях в ветке `work/feed-signing-smoke-20261015`.
- Он собирает один синтетический тестовый `.deb` в каталоге runner, проверяет подпись и integrity, затем удаляет всё. Никакие `.deb`/index/signature не загружаются как Actions artifact, не коммитятся и не публикуются.
- Actions secret `AIB_TERMUX_FEED_SIGNING_KEY` содержит private key; private key не хранится в Git. В Git помещаются только публичный keyring и fingerprint/hash manifest.
- Smoke test **не** строит production feed, не подтверждает происхождение старых пакетов и не выполняет установку пакета.
- Текущие production gate остаются закрытыми: не включать GitHub Pages, не включать Builder source и не открывать `pkg.ensure`, пока не выбран package manifest с подтверждённым source/build provenance и dependency closure, не исключены непроверенные записи и не выполнен Android install/rollback smoke.

## Локальный интерфейс генератора

```sh
./scripts/create-signed-feed-release.sh /path/to/apt/termux-main aarch64
```

Перед вызовом в `GNUPGHOME` должен быть импортирован ровно соответствующий private signing key. Скрипт проверяет fingerprint и SHA-256 публичного keyring из `keys/feed-signing.json`, сверяет все `.deb` из `pool/` с `Packages`, проверяет размеры и SHA-256, формирует `Valid-Until` и подписывает release metadata. Он не копирует и не публикует feed.
