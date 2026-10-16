# Production gate пакетного репозитория AI Builder

## Что подтверждено сейчас

- В `main` сохраняется legacy pool из 133 `.deb`. Полный pinned build provenance отсутствует; статический аудит оставил `fontconfig`, `libx11` и `termux-auth` неподтверждёнными. Это не доверенный install source.
- Отдельный signing smoke проходит на синтетическом fixture: закреплённый keyring, `Release`/`InRelease`, строгий `signed-by`, отказ при подмене индекса. Это не удостоверяет legacy-пакеты.
- Candidate CI закрепляет Termux source commit и builder image digest. Отдельно собираются GNU Make `4.4.1-1` и GitHub CLI `gh` `2.102.0`; Git workflow собрал Git `2.56.0` и его 14-пакетную source-built dependency closure (20 dependency alternatives; [run `38829235485`](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38829235485)). Добавленный curl workflow фиксирует кандидат `curl` `8.23.0` и closure из 9 пакетов/12 alternatives; результат — только CI check связанного PR, не device proof. Успешная сборка не означает production approval.
- В CI compile prefix моделируется как `/data/user/0/com.karat.aibuilder/files/usr`; это не измерение реального устройства.

## Что делает candidate pipeline

1. Сборки Make и `gh` проверяют точные source/recipe/archive locks; Git workflow проверяет pinned Git source и все 14 пакетов closure, curl workflow — pinned curl source, subpackage и все 9 пакетов closure. Dependency downloads отключены в Git/curl builds.
2. Каждый `.deb` проходит отдельный fail-closed static audit: control metadata, payload paths/links, embedded app paths, ELF ABI/interpreter/needed libraries, maintainer scripts и лицензии. Для `curl` subpackage отсутствие собственного copyright payload допускается только при наличии в том же closure прошедшего audit `libcurl` parent с идентичными pinned recipe/source/version/license; validator сверяет paths/hashes parent evidence с report для `curl`.
3. Package pool сверяется с manifest, build-result, audit report и APT indices; любое добавление, подмена или mismatch отклоняется.
4. Для кандидатов создаётся временный подписанный APT feed; CI использует `signed-by=<pinned public keyring>`, проверяет загрузку и `apt-get --simulate install`. Фактической установки нет.
5. Каждый `Depends`/`Pre-Depends` проверяется на точное разрешение в candidate allowlist с совместимой Debian-версией. Git closure содержит 14 source-built пакетов; curl closure включает 9 пакетов и 12 alternatives; `gh` не имеет обязательных `Depends` (`openssh` указан только как `Recommends`).
6. Обычные CI runs удаляют source tree, `.deb`, candidate feeds и signing workspace с runner. Единственный заранее одобренный marker push выдал публичный Actions artifact **только для Make**: `.deb`, временные подписанные APT metadata, публичный ephemeral keyring, manifest и build/audit provenance; Git, `gh`, `curl` и приватный ключ не включены. Artifact истекает **2026-10-16 17:29:27Z** ([Actions run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/38777394187)). Это handoff только для device smoke, не production publication.

## Остаточные условия до production

- Отдельно утвердить production allowlist и точный dependency closure; 133 legacy `.deb` не использовать как доверенный набор.
- CI уже собрал, статически проверил и смоделировал APT install для Git closure; production feed не опубликован. На `main` `curl`, `wget` и `openssh` из профиля `base` пока только inventory. Отдельный curl candidate pipeline проверяется в review PR: даже его CI pass не докажет Android install/runtime и не откроет production feed.
- Проверить конкретные APK/runtime на Android: получить реальный `applicationInfo.dataDir` и `filesDir/usr`, установить пакет через Builder, выполнить бинарник, удалить/откатить пакет и подтвердить отсутствие изменений внешнего Termux и проектов пользователя.
- Проверить импорт закреплённого feed key по exact fingerprint и keyring SHA-256; убедиться, что APT использует `signed-by` без insecure flags.
- После успешных device tests настроить HTTPS Pages, опубликовать только утверждённый allowlist и повторить download/index-signature checks с публичного URL.
- Отдельно изменить app-side fail-closed gate/`pkg.ensure`; успешный CI build сам по себе этот gate не открывает.

До закрытия всех пунктов запрещены `trusted=yes`, `AllowUnauthenticated`, `AllowInsecureRepositories`, stock `com.termux` feed/packages и любые сторонние package binaries. Cleanup в PR #2 ограничен шестью legacy workflow/script файлами; он не переписывает ветку `gh-pages` и не публикует пакеты.
