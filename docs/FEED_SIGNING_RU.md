# Подпись APT candidate feed для AI Builder

Этот код предназначен для изолированного CI smoke/candidate теста, а не для автоматического production deployment.

## Что проверяется

- публичный keyring и SHA-256/fingerprint закреплены в `keys/feed-signing.json`;
- candidate и synthetic CI создают одноразовый локальный RSA-ключ; production private key и GitHub Actions secrets в этих workflow не используются;
- генератор строит `Release`, `InRelease` и `Release.gpg`, проверяет SHA-256/размеры индекса и состав package pool;
- локальный APT использует `signed-by=<одноразовый keyring>`, принимает корректный индекс и отвергает изменённый `Packages.gz`;
- candidate pipeline дополнительно строит один pinned GNU Make package, делает статический аудит и проверяет подписанный временный feed через `apt-get --simulate`.

## Границы

- Все тестовые/candidate данные создаются во временном каталоге GitHub Actions runner. Обычные запуски всё удаляют; явный `workflow_dispatch` с `retain_candidate_artifacts=true` сохраняет проверяемый allowlisted candidate bundle на 7 дней. Исторический marker-push Make handoff остаётся отдельным однодневным механизмом.
- Candidate CI не проверяет production keypair из `keys/feed-signing.json`; production-подпись должна быть подключена отдельным защищённым workflow после отдельного допуска.
- Retained bundle содержит только новые candidate `.deb`, подписанные индексы/Release, публичный ephemeral keyring/fingerprint, manifest, build/audit reports и hash-bound provenance. Приватный signing key и его GNUPGHOME не копируются; production private key не используется. В публичном репозитории artifact не конфиденциален. Self-signed ephemeral evidence не назначает доверенного production signer и не разрешает установку.
- Candidate `.deb`, индексы и подписи не коммитятся, не прикрепляются к GitHub Release и не выкладываются на Pages.
- Существующий legacy pool из 133 `.deb` не подписывается и не становится доверенным от факта smoke-теста.
- Legacy build/Pages workflow-файлы в `main` пока не удалены; их cleanup требует отдельного подтверждения.
- Нет Android install/rollback evidence; production gate и `pkg.ensure` остаются закрыты.
- Включение Pages, публикация подписанного production feed и переключение приложения требуют отдельного изменения после проверенного целевого Android smoke.

**Не использовать** `trusted=yes`, insecure APT flags, официальный `com.termux` feed или сторонние бинарники. Подпись защищает APT metadata от подмены, но не заменяет provenance, dependency closure и runtime test.
