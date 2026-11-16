# AI Builder v512 source-only snapshot

Version: `1.10.112` / Android `versionCode 512` (`com.karat.aibuilder`).

This branch contains the app source, build configuration, dependency lockfile, ordinary public app assets, public X.509 certificate, and the source scripts/metadata for the bundled package features. It intentionally excludes all prebuilt package and release payloads, signed feed artifacts, the bootstrap ZIP, APK/AAB outputs, and Android release-signing lineage or private signing material.

**Build limitation:** this branch is not independently buildable. Native prebuild validation requires the omitted 82 full-feed `.deb` payloads, the candidate-probe `.deb`, signed feed files, and the Termux bootstrap ZIP. They must be supplied separately from an authorized non-public build environment; none are present here. The target repository has no Android app build workflow, so this source-only push does not run an app build or produce artifacts.

No secrets, local environment files, dependency caches, or generated verification outputs are included.
