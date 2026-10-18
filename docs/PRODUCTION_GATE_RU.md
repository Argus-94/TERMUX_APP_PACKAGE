# Production gate пакетного репозитория AI Builder

## Текущий статус: production закрыт

- Целевое приложение — приватный AI Builder `com.karat.aibuilder`, архитектура `aarch64`; это не feed для stock Termux. В `main` (`2a2dd775`, merge PR #9; PR #8 добавил Java) остаётся legacy pool из 133 `.deb` без полного pinned build provenance. Статический аудит оставил `fontconfig`, `libx11` и `termux-auth` неподтверждёнными. Не считать legacy pool доверенным источником установки.
- Кандидатные workflows закрепляют версии исходников/рецептов и builder image и выполняют статический аудит и проверку временного подписанного APT feed с `signed-by` и `apt-get --simulate`. Это hosted CI, а не Android install/runtime proof; симуляция не устанавливает пакеты.
- **CMake + Ninja:** `cmake` `4.4.4` и `ninja` `1.13.2`; required pinned closure — 22 пакета / 34 dependency alternatives. Источники: Termux packages commit `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`, CMake archive SHA-256 `bd24c30d80a7744ae84b845ff080cc8453b06c622ef01066564108e9cefc44cf`, Ninja archive SHA-256 `974d6b2f4eeefa25625d34da3cb36bdcebe7fbce40f4c16ac0835fd1c0cbae17`. Успешный CI: [run 39086630210](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39086630210), head `d038f6080babd6f465cb6d1dbb0baf253ec65171`.
- **OpenJDK 17:** root `openjdk-17` `17.0.20`; required pinned runtime closure — 36 пакетов / 46 dependency alternatives. Успешный CI: [run 39080124869](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39080124869), head `d58ede99b4b746d7a4ed4253d33b575ffd323d8a`. В этот required набор не включены рекомендации; не подменять этим фактом самостоятельные device tests.
- Полные package/version/recipe/archive locks см. в [CMake+Ninja manifest](../cmake-ninja-candidate-package-set.json), [CMake+Ninja source closure](../toolchain-candidate-source-closures/cmake-ninja-candidate.json), [OpenJDK manifest](../openjdk17-candidate-package-set.json) и [OpenJDK source closure](../toolchain-candidate-source-closures/openjdk17-candidate.json). Выше приведены root versions и точные closure sizes, а не утверждение, что все пакеты уже проверены на устройстве.
- CI моделирует prefix `/data/user/0/com.karat.aibuilder/files/usr`; это не наблюдённые `applicationInfo.dataDir` или `filesDir/usr` реального устройства. Ручной просмотр evidence не является криптографической аттестацией: **никакой автоматической promotion** candidate → production нет.
- Ранее опубликованный Make Actions artifact истёк **2026-10-16**; его доступность не обещается. Нет основания считать, что старый artifact даёт актуальный install source.

## Qualification matrix — Android обязательно

Все проверки выполняются на отдельном тестовом устройстве/API-профиле для точного APK приложения и точного candidate manifest; фиксируются устройство/API, APK и manifest hashes, команды, exit codes и журналы. До получения и review полного evidence каждая ячейка остаётся **NOT RUN**.

| Область | Практическая проверка | Минимальное evidence / критерий |
|---|---|---|
| Установка | На чистом тестовом состоянии импортировать закреплённый ключ; сверить fingerprint и SHA-256 keyring; настроить только HTTPS candidate feed с `signed-by`; установить allowlist из manifest через Builder/APT. | APK identity, реальные `applicationInfo.dataDir` и `filesDir/usr`, manifest/keyring/feed hashes, APT logs; ни `trusted=yes`, ни insecure flags, ни stock Termux feed. |
| Runtime | Проверить `cmake --version`, `ninja --version`, `java -version`/`javac -version` для разрешённых компонентов; запустить минимальный CMake configure/build с Ninja и Java smoke test в app-private каталоге. | Exit codes и logs; ELF/ABI и реальные пути; отсутствие записи за пределы приватного каталога и доступа к чужому Termux. |
| Project build | Собрать репрезентативный проект приложения с зафиксированными исходниками/инструкцией, используя именно установленные кандидаты; проверить чистую сборку и повторный запуск. | Commit/hash проекта, команды/версии, build outputs и logs; успешный результат должен быть воспроизводим на заявленной конфигурации. |
| Upgrade | Применить заранее описанное обновление candidate версии/closure, затем проверить бинарники, проект и сохранность пользовательских данных. | До/после manifest и package versions; успешные runtime/project checks; отсутствие неожиданных изменений данных. |
| Rollback/uninstall | Вернуться к предыдущему закреплённому набору либо удалить candidate packages штатным механизмом; проверить runtime и проекты после отката, остаточные файлы и отсутствие изменений внешнего Termux. | Команды и exit codes, package state до/после, проверка файлов/данных; rollback должен быть документирован и успешен. |

Сейчас Android install, runtime, project build, upgrade и rollback — **все NOT RUN**. Hosted CI green не меняет этот статус.

### Что подготовить перед device-прогоном

- Нужен доступный авторизованный Android test runtime с точным APK. В текущей среде нет доступного Android-устройства, `adb` или эмулятора; команда на Linux не считается Android-тестом.
- CMake/Ninja не предоставляют автоматически C/C++ compiler, а OpenJDK не предоставляет Gradle и Android SDK. Для native/Android project build сначала отдельно закрепить и проверить необходимые инструменты и исходники проекта; не подгружать stock/legacy binaries ради зелёного smoke. Java-only smoke можно выполнить через `javac`/`java`; он не докажет Android APK build.
- Не склеивать отдельные feeds по совпадению package/version. В CMake-профиле [локальный libcurl patch](../termux-private-package-kit/cmake-ninja/libcurl-disable-optional-zstd.patch) меняет effective recipe и отключает необъявленную zstd linkage, хотя upstream recipe hash совпадает с другими профилями. Для объединённого набора нужен единый reviewed lock, однозначный выбор каждого `.deb`, повторные source/path/ABI/provider/conflict/dependency audits и signed APT checks.
- Для настоящего upgrade/downgrade нужны два разрешённых, source-built и проверенных набора версий. Переустановка той же версии, `--simulate` и synthetic fixtures не закрывают upgrade/rollback gate. Проверка удаления отдельно не доказывает возврат к предыдущей версии.

### Проверки безопасности handoff

Make-only `scripts/stage-device-test-artifact.py` повторно вызывает существующий candidate-policy validator, сверяет plaintext `InRelease` с `Release`, root Release с distribution Release, exact SHA-256/размеры двух подписанных индексов и срок действия metadata. Это проверка целостности handoff, не сборка новых пакетов и не Android evidence. Она не расширяет ранее разрешённый allowlist публикации artifacts.

`scripts/test-device-test-artifact-staging.sh` проверяет реальные временные подписи и отказы при подмене; `scripts/tests/test_device_handoff_validation.py` покрывает metadata edge cases. Fixtures синтетические и никогда не предназначены для установки. Новый workflow `device-handoff-policy.yml` выполняет только эти policy/regression tests, без upload-artifact, production keys, Pages и package installation.

## Gate перед публикацией

1. Сохранить/утвердить allowlist и точное dependency closure по pinned manifests; не использовать 133 legacy `.deb` как доверенную базу.
2. Завершить и независимо просмотреть Android qualification matrix и подписанное evidence; ручной review не заменяет криптографическую аттестацию и сам по себе ничего не продвигает автоматически.
3. Проверить app-side fail-closed gate и `pkg.ensure` отдельно; кандидатный CI не открывает их.
4. Только после явного отдельного разрешения на публикацию настроить HTTPS Pages, опубликовать утверждённый набор и повторить download/index/signature checks с публичного URL. В рамках текущей работы публикация не выполняется.

Запрещены `trusted=yes`, `AllowUnauthenticated`, `AllowInsecureRepositories`, stock `com.termux` feed/packages, legacy debs как доверенная база, fake/bypass packages и PocketForge. Успешный CI не означает production approval и не является Android proof.
