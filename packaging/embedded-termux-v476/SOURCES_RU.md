# Источники и границы доказательств — v476

Дата проверки: 14.10.2026. Источники ниже открывались и читались; их URL сохранены, чтобы pins можно было независимо перепроверить.

## Termux build recipes и framework

- [Pinned upstream commit](https://github.com/termux/termux-packages/commit/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7) и [GitHub commit API](https://api.github.com/repos/termux/termux-packages/commits/master): recipe revision `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`; GitHub API сообщает, что commit не имеет verified signature. Это source provenance pin, не подтверждение feed signing.
- [`scripts/properties.sh`](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/scripts/properties.sh): default app ID — `com.termux`; documented safe fork variables include app package name, app data directory and prefix/layout variables. Upstream repo identity/defaults также существуют и требуют отдельной настройки для локального fork.
- [`build-package.sh`](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/build-package.sh): поддерживается `./build-package.sh -a aarch64 PACKAGE...`; `-i/-I` загружают/извлекают зависимости вместо их сборки. Для этого плана эти flags запрещены.
- [`CONTRIBUTING.md`](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/CONTRIBUTING.md): source inputs должны быть детерминированными и проверяться `TERMUX_PKG_SHA256`; Android packages рассчитаны на Android/NDK, а path placeholders/patches важны для prefix compatibility.
- [`scripts/Dockerfile`](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/scripts/Dockerfile): builder image `ubuntu:26.04`; устанавливает host dependencies через `apt-get update` и `apt-get upgrade`. Tag и host package snapshot не являются immutable pins в этой версии.

## Точные package recipes

Все строки — исходные значения рецептов из одного pinned commit. Архивы пакетов не скачивались; значения `TERMUX_PKG_SHA256` не пересчитывались заново в этой задаче.

- [nodejs-lts](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/packages/nodejs-lts/build.sh): `24.18.0-1`; отдельный `npm` начиная с Node `24.13.0`; дополнительные build inputs: ICU 78.3 SHA-256 `3a2e7a47604ba702f345878308e6fefeca612ee895cf4a5f222e7955fabfe0c0` и Google-host LLVM tarball SHA-256 `790fcc5b04e96882e8227ba7994161ab945c0e096057fc165a0f71e32a7cb061`; рецепт предупреждает о длительной ARM64 сборке.
- [npm](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/packages/npm/build.sh): `11.20.0`, recipe declares `nodejs | nodejs-lts`.
- [openjdk-17](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/packages/openjdk-17/build.sh): `17.0.20`; recipe contains `$TERMUX_PREFIX`-based RPATH/JAVA_HOME and Bionic libraries.
- [python](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/packages/python/build.sh): `3.14.6-1`, two source archives and hashes.
- [cmake](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/packages/cmake/build.sh): `4.4.4`.
- [ninja](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/packages/ninja/build.sh): `1.13.2`.
- [git](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/packages/git/build.sh): `2.56.0`.
- [make](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/packages/make/build.sh): `4.4.1-1`.
- [pkg-config](https://raw.githubusercontent.com/termux/termux-packages/505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/packages/pkg-config/build.sh): `0.29.2-3`.

## Android/React Native compatibility evidence

- [React Native 0.81 environment setup](https://reactnative.dev/docs/0.81/set-up-your-environment): Node minimum `20.19.4`, JDK `17`, Android SDK/Build Tools guidance. The guide does not demonstrate that SDK/AGP host tools execute on an Android Bionic/ARM64 runtime.
- [Android Studio install requirements](https://developer.android.com/studio/install) and [Android NDK downloads/revisions](https://developer.android.com/ndk/downloads/revision_history): used to distinguish supported Linux host toolchains from Android-target native packages. IDE host requirements alone do not prove command-line compatibility or impossibility on Android.
- [Android SDK terms](https://developer.android.com/studio/terms): SDK provisioning and redistribution must respect Google's terms; v476 does not bundle Google SDK files.
- Existing project evidence: `IMPLEMENTATION_STATUS_TERMUX_RU.md`, `v475-pre-release.log` and the archived v475 report. These state source/static checks passed but APK/native compile/device smoke were not run.

## Что источники не доказывают

Они не подтверждают, что Gradle, Android Gradle Plugin, SDK Manager, Build Tools (`aapt2`, D8, apksigner), NDK, Java и весь RN/Expo project toolchain запускаются внутри AI Builder's app-private Bionic environment; не подтверждают точный `$PREFIX` для пакетной сборки; не дают .deb для `com.karat.aibuilder`; не проверяют независимый binary provenance/rebuild; и не являются разрешением на распространение или установку.
