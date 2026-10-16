# Production gate пакетного репозитория AI Builder

## Что подтверждено сейчас

- В `main` сохраняется legacy pool из 133 `.deb`. Полный pinned build provenance отсутствует; статический аудит оставил `fontconfig`, `libx11` и `termux-auth` неподтверждёнными. Это не доверенный install source.
- Отдельный signing smoke проходит на синтетическом fixture: закреплённый keyring, `Release`/`InRelease`, строгий `signed-by`, отказ при подмене индекса. Это не удостоверяет legacy-пакеты.
- Candidate CI закрепляет Termux source commit и builder image digest. Отдельно собираются GNU Make `4.4.1-1` и GitHub CLI `gh` `2.102.0`; отдельный Git workflow собирает Git `2.56.0` и его 14-пакетную source-built dependency closure (20 dependency alternatives). Успешная сборка не означает production approval.
- В CI compile prefix моделируется как `/data/user/0/com.karat.aibuilder/files/usr`; это не измерение реального устройства.

## Что делает candidate pipeline

1. Сборки Make и `gh` проверяют точные source/recipe/archive locks; Git workflow проверяет pinned Git source и все 14 пакетов closure. Dependency downloads в Git build отключены.
2. Каждый `.deb` проходит отдельный fail-closed static audit: control metadata, payload paths/links, embedded app paths, ELF ABI/interpreter/needed libraries, maintainer scripts и лицензии.
3. Package pool сверяется с manifest, build-result, audit report и APT indices; любое добавление, подмена или mismatch отклоняется.
4. Для кандидатов создаётся временный подписанный APT feed; CI использует `signed-by=<pinned public keyring>`, проверяет загрузку и `apt-get --simulate install`. Фактической установки нет.
5. Каждый `Depends`/`Pre-Depends` проверяется на точное разрешение в candidate allowlist с совместимой Debian-версией. В частности, Git closure содержит 14 source-built пакетов; `gh` не имеет обязательных `Depends` (`openssh` указан только как `Recommends`).
6. Обычные CI runs удаляют source tree, `.deb`, candidate feeds и signing workspace с runner. Единственный заранее одобренный marker push выдал публичный Actions artifact **только для Make**: `.deb`, временные подписанные APT metadata, публичный ephemeral keyring, manifest и build/audit provenance; Git, `gh` и приватный ключ не включены. Artifact истекает **2026-10-16 17:29 UTC** ([Actions run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38777394187)). Это handoff только для device smoke, не production publication.

## Остаточные условия до production

- Отдельно утвердить production allowlist и точный dependency closure; 133 legacy `.deb` не использовать как доверенный набор.
- CI уже собрал, статически проверил и смоделировал APT install для Git closure; production feed не опубликован. `curl`, `wget` и `openssh` из профиля `base` пока только инвентаризированы по закреплённым recipes, но не прошли полный build/audit pipeline.
- Проверить конкретные APK/runtime на Android: получить реальный `applicationInfo.dataDir` и `filesDir/usr`, установить пакет через Builder, выполнить бинарник, удалить/откатить пакет и подтвердить отсутствие изменений внешнего Termux и проектов пользователя.
- Проверить импорт закреплённого feed key по exact fingerprint и keyring SHA-256; убедиться, что APT использует `signed-by` без insecure flags.
- После успешных device tests настроить HTTPS Pages, опубликовать только утверждённый allowlist и повторить download/index-signature checks с публичного URL.
- Отдельно изменить app-side fail-closed gate/`pkg.ensure`; успешный CI build сам по себе этот gate не открывает.

До закрытия всех пунктов запрещены `trusted=yes`, `AllowUnauthenticated`, `AllowInsecureRepositories`, stock `com.termux` feed/packages и любые сторонние package binaries. Cleanup в PR #2 ограничен шестью legacy workflow/script файлами; он не переписывает ветку `gh-pages` и не публикует пакеты.
