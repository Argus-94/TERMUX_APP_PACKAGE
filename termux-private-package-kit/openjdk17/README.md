# OpenJDK 17 app-private candidate

This kit is candidate-only. It does not publish a feed, upload binary artifacts, enable Pages, install into Builder, or provide Android runtime evidence.

## Exact inputs

The Termux recipe tree is locked to `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`, and the official builder is locked by OCI SHA-256 digest. The required runtime inventory contains 36 packages and 46 dependency alternatives. The source closure SHA-256 is `378bf846bf86255a89c94510b4cb52a945b22e1df06c3624919badd85f6c402a`. An input lock covers all 138 runtime recipe directory files, including patches and subpackage definitions.

OpenJDK is exactly `17.0.20`; its archive must match `ba3ac4b9d7f2c050f46ddcec39b4258660a3f09836f5a71617fd3f7311d06c0b`. The upstream `jdk-17.0.20-ga` tag object is locked to `54877207ef029d155cb3a6bd02bfe6bace8b6c9c`, and its peeled commit to `8cbbca61432426a3441aa08838d930ef954ea1ba`. Hosted verification checks the full archive and three license notice hashes, then deletes the archive without extraction.

The controlled overlay preserves OpenJDK `LICENSE`, `ADDITIONAL_LICENSE_INFO`, and `ASSEMBLY_EXCEPTION`, and includes the pinned parent recipe GPL-2.0 shared-license reference in split `libltdl`. Eight shared-license files were compared byte-for-byte against the existing embedded bootstrap ZIP and pinned source. This proves archive contents, not device state. App-private properties are modeled for `com.karat.aibuilder`, not observed on a device. Host Java/Javac versions and hashes are recorded; these are build inputs, not Android execution results.

## Source-only build-cycle correction

Hosted run [39066933456](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39066933456) stopped at PulseAudio's unresolved `sndfile` pkg-config dependency. The pinned recipes expose a source build cycle: `libmpg123` build-depends on `pulseaudio`, which depends on `libsndfile`, which depends on `libmpg123`.

The overlay selects mpg123's supported decoder-only build: `--disable-components --enable-libmpg123`, removes the console player's PulseAudio build dependency, and excludes the optional console subpackage on aarch64 using the standard architecture gate. These switches were checked in `configure.ac` from exact mpg123 1.33.7 source matching recipe SHA-256. This is a real decoder library build, not a placeholder package. Optional console player/output components are not included in this candidate.

PulseAudio's mutable `v17.0` git reference is replaced by the archive of peeled commit `1f020889c9aa44ea0f63d7222e8c2b62c3f45f68`, SHA-256 `0ccee8a0c9653badc668cf11f0eaad97a1febb85afa82c24c2d1935926446e3b`. The standard `.tarball-version` file is seeded from pinned recipe version 17.0, as required by upstream `git-version-gen` when `.git` metadata is absent. Hosted run 39070715062 exposed this archive version-metadata requirement before dependency detection. Package versions and required runtime inventory remain unchanged. The manifest locks the overlay and additional source evidence.

## Hosted gates

Before compilation, a metadata-only preflight checks the controlled 120-package source build order and requires `libmpg123` before `libsndfile` before `pulseaudio`, with no optional console subpackage. This build-only ordering set is distinct from the 36-package runtime inventory.

CI builds dependencies from source with binary dependency downloads disabled. It requires exact identities and dependencies, source recipe hashes, private payload/link paths, license evidence, AArch64/Android ELF properties and proven library providers. After a successful audit, CI creates an ephemeral signing key and temporary feed, verifies hashes and signatures, and runs an exact APT simulation. No package installation occurs. Temporary source, packages, feed, container and signing material are removed even on failure.

The restricted AppArmor profile is preserved. No privileged alternatives mutation or local build is used. No binary artifacts are uploaded. Recommended `ca-certificates-java`, `openjdk-17-x`, and `resolv-conf` remain excluded. A headless candidate does not prove TLS trust or GUI support. Declared build-only dependencies remain separate unless already required by the runtime graph.

## Production remains blocked

Android installation, `java -version`, `javac`/JAR execution, private paths and permissions, JNI/library loading, certificate behavior, upgrade and rollback are **NOT RUN**. They must pass on the target Android application before production publication or Builder installation. CI success cannot open this gate.

See the candidate PR and exact workflow run for actual outcomes. The presence of this kit is not a claim that compilation, static audit or signed APT simulation has passed.
