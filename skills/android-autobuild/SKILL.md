---
name: android-autobuild
version: 1.0.0
platforms: [android, termux, ubuntu-proot]
---

# Android autobuild (self-healing build loop)

Use for every task of the form "build an APK from this archive / folder" or "create an app from scratch and build it".

1. Inspect: find the project root and stack (Gradle, Expo/React Native, Capacitor/Cordova, Flutter, Maven, CMake/NDK) from manifests and settings. Read compileSdk, AGP/Gradle versions, ndkVersion, package manager and lockfile.
2. New app: write the whole source tree into `<AIBuilderTermux>/projects/<name>/`, run lsp.diagnostics and fix every error before the first build.
3. Run build.run. It saves `build-apk-<name>.sh` into the project folder and runs it in the selected backend (Termux or Ubuntu guest). The script is self-healing: it installs JDK 17, cmdline-tools, platforms, build-tools, CMake, NDK (sdkmanager), accepts licenses, writes local.properties and user-level gradle.properties (heap, aapt2 override on ARM), restores the Gradle wrapper jar, installs node/pnpm deps, reads the Gradle log and rebuilds up to 10 times.
4. Read the result markers: `AIB_AUTOBUILD_RESULT=ok` (done), or `AIB_AUTOBUILD_NEEDS_LLM=1` with `AIB_AUTOBUILD_FIRST_ERROR` and `AIB_AUTOBUILD_LOG`. In the second case fix the real cause (source code, dependency, path), regenerate the script and run it again. Repeat; never stop after one or two failures.
5. Verify the APK/AAB exists, is non-empty and signed (V1+V2+V3), then report its path.

Keep the project's compilation settings and lockfiles as written; machine-specific values go to `~/.gradle/gradle.properties` and `local.properties`. Never install x86_64-only helpers expecting them to run on ARM; use the Termux/Ubuntu ARM packages (`aapt2`, `openjdk-17`).
