# Production gate пакетного репозитория AI Builder

## Что можно считать подтверждённым сейчас

- Репозиторий `Argus-94/TERMUX_APP_PACKAGE` содержит 133 legacy `.deb` в `main`. Это не доверенный install source: полный pinned build provenance отсутствует; статический аудит оставил `fontconfig`, `libx11` и `termux-auth` неподтверждёнными.
- APT signing smoke прошёл на GitHub Actions для синтетического fixture: закреплённый keyring, `Release`/`InRelease`, strict `signed-by`, отказ при hash mismatch. Этот результат не удостоверяет 133 legacy пакета.
- Текущий узкий candidate allowlist содержит GNU Make `4.4.1-1` и GitHub CLI `gh` `2.102.0`. Их source commit, recipe/patch (для Make), source archive SHA-256 и container image digest закреплены; наличие кандидатов не означает production approval.
- Candidate CI моделирует compile prefix из package ID как `/data/user/0/com.karat.aibuilder/files/usr`; это не device observation.

## Что делает candidate pipeline

1. Собирает ровно два allowlisted `.deb` (`make` и `gh`) для `aarch64` в pinned Termux builder container.
2. Применяет отдельный fail-closed static audit к control metadata, payload paths/links, embedded app paths, ELF ABI/interpreter/needed libraries, maintainer scripts и лицензии каждого пакета.
3. Сверяет каждый package pool с соответствующим manifest, build-result, audit report и APT indices; любое добавление, подмена или mismatch отклоняется.
4. Для каждого кандидата временно строит подписанный APT feed и проверяет его через `signed-by=<pinned public keyring>`, загрузку и `apt-get --simulate install`. Отдельный synthetic test отвергает подменённый индекс.
5. До подписи проверяет, что каждый `Depends` и `Pre-Depends` из candidate `Packages` разрешается точным allowlist-пакетом с подходящей Debian-версией; непроверенный внешний base-runtime dependency не считается удовлетворённым. У текущего `gh` candidate ноль обязательных Depends; `openssh` — только Recommends.
6. Обычные запуски удаляют source tree, `.deb`, candidate feeds и signing workspace с runner. Единственный заранее одобренный marker push уже выдал публичный Actions artifact **только для `make`** с его `.deb`, подписанными временными APT metadata, публичным ephemeral keyring, manifest и build/audit reports; `gh` и приватный ключ не включены. Artifact истекает `2026-10-16 17:29 UTC` ([Actions run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38777394187)). Это только handoff для device smoke, не production publication.

## Остаточные условия до production

- Собрать и принять dependency-closed allowlist с provenance для каждого пакета; не использовать текущий 133-package pool как доверенный набор.
- Первый следующий Builder scope — профиль `base` (`git`, `curl`, `wget`, `openssh`); эти корни пока не добавлены в feed: source recipes, транзитивные зависимости, лицензии и статические аудиты каждого `.deb` должны пройти до расширения allowlist.
- Проверить конкретный APK/runtime на Android: получить реальный `applicationInfo.dataDir` и `filesDir/usr`, поставить пакет через Builder, выполнить бинарник, удалить/откатить пакет и подтвердить отсутствие изменений внешнего Termux и project files.
- Проверить, что закреплённый feed key импортируется приложением по exact fingerprint и keyring SHA-256, а APT применяет `signed-by` без insecure flags.
- После успешных device tests настроить HTTPS Pages, опубликовать только прошедший allowlist и повторить download/index signature checks с публичного URL.
- Отдельно изменить app-side fail-closed gate/`pkg.ensure`; успешный CI build сам по себе этот gate не открывает.

До закрытия всех пунктов запрещены `trusted=yes`, `AllowUnauthenticated`, `AllowInsecureRepositories`, stock `com.termux` feed/packages и любые сторонние package binaries. Legacy workflow-файлы в текущем `main` пока не удалены; точный cleanup list будет отдельно подтверждён перед любым удалением. Ветка `gh-pages` не переписывается.
