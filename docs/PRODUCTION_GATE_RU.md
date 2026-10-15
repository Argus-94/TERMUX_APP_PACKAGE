# Production gate пакетного репозитория AI Builder

## Что можно считать подтверждённым сейчас

- Репозиторий `Argus-94/TERMUX_APP_PACKAGE` содержит 133 legacy `.deb` в `main`. Это не доверенный install source: полный pinned build provenance отсутствует; статический аудит оставил `fontconfig`, `libx11` и `termux-auth` неподтверждёнными.
- APT signing smoke прошёл на GitHub Actions для синтетического fixture: закреплённый keyring, `Release`/`InRelease`, strict `signed-by`, отказ при hash mismatch. Этот результат не удостоверяет 133 legacy пакета.
- GNU Make `4.4.1-1` — единственный текущий build candidate. Исходный commit, recipe/patch, GNU Make archive SHA-256 и container image digest закреплены в manifest.
- Candidate CI моделирует compile prefix из package ID как `/data/user/0/com.karat.aibuilder/files/usr`; это не device observation.

## Что делает candidate pipeline

1. Собирает ровно один `make` `.deb` для `aarch64` в pinned Termux builder container.
2. Применяет fail-closed static audit к control metadata, payload paths/links, embedded app paths, ELF ABI/interpreter/needed libraries, maintainer scripts и лицензии.
3. Сверяет package pool с `candidate-package-set.json`, build-result, audit report, `Packages` и `Packages.gz`; любое добавление, подмена или mismatch отклоняется.
4. Временно строит подписанный APT candidate и проверяет его через `signed-by=<pinned public keyring>`, `apt-get update` и `apt-get --simulate install`. Отдельный synthetic test отвергает подменённый индекс.
5. Обычные запуски удаляют source tree, `.deb`, candidate feed и signing workspace с runner. Только один заранее одобренный marker push может выдать публичный Actions artifact на 1 день с `.deb`, подписанными временными APT metadata, публичным ephemeral keyring, manifest и build/audit reports; приватный ключ не копируется. Это только handoff для device smoke, не production publication.

## Остаточные условия до production

- Собрать и принять dependency-closed allowlist с provenance для каждого пакета; не использовать текущий 133-package pool как доверенный набор.
- Проверить конкретный APK/runtime на Android: получить реальный `applicationInfo.dataDir` и `filesDir/usr`, поставить пакет через Builder, выполнить бинарник, удалить/откатить пакет и подтвердить отсутствие изменений внешнего Termux и project files.
- Проверить, что закреплённый feed key импортируется приложением по exact fingerprint и keyring SHA-256, а APT применяет `signed-by` без insecure flags.
- После успешных device tests настроить HTTPS Pages, опубликовать только прошедший allowlist и повторить download/index signature checks с публичного URL.
- Отдельно изменить app-side fail-closed gate/`pkg.ensure`; успешный CI build сам по себе этот gate не открывает.

До закрытия всех пунктов запрещены `trusted=yes`, `AllowUnauthenticated`, `AllowInsecureRepositories`, stock `com.termux` feed/packages и любые сторонние package binaries. Legacy workflow-файлы в текущем `main` пока не удалены; точный cleanup list будет отдельно подтверждён перед любым удалением. Ветка `gh-pages` не переписывается.
