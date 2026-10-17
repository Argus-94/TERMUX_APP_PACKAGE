# OpenJDK 17 app-private candidate

This kit is candidate-only. It does not publish an APT feed, upload binary artifacts, enable Pages, install into Builder, or provide Android runtime evidence.

## Exact inputs

The Termux recipe tree is locked to `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`, and the official builder is locked by OCI SHA-256 digest. The required runtime inventory contains 36 packages and 46 dependency alternatives. The source closure SHA-256 is `378bf846bf86255a89c94510b4cb52a945b22e1df06c3624919badd85f6c402a`. An additional input lock covers all 138 files in the runtime recipes' directories, including OpenJDK patches and subpackage definitions.

OpenJDK is exactly `17.0.20`; the recipe archive must match `ba3ac4b9d7f2c050f46ddcec39b4258660a3f09836f5a71617fd3f7311d06c0b`. The upstream `jdk-17.0.20-ga` tag object is locked to `54877207ef029d155cb3a6bd02bfe6bace8b6c9c`, and its peeled commit to `8cbbca61432426a3441aa08838d930ef954ea1ba`. Source verification downloads the archive on the hosted runner, verifies its complete hash and all three license notice hashes, then deletes it without extraction. A tag or notice change fails closed.

The documentation-only patch sets OpenJDK `TERMUX_PKG_LICENSE_FILE` to preserve `LICENSE`, `ADDITIONAL_LICENSE_INFO`, and `ASSEMBLY_EXCEPTION`; it also includes the pinned parent recipe GPL-2.0 shared-license reference in the split `libltdl` package. It does not alter compiled source or dependencies. Eight shared-license payload hashes, including LGPL-2.0 and NCSA, were compared against the existing embedded bootstrap archive and pinned license source. App-private properties are modeled for `com.karat.aibuilder`, not observed on a device. The digest-pinned builder must contain the Java 17 host bootstrap; the preflight records `java`/`javac` versions and executable hashes. These are host-build inputs, not Android Java execution results.

## Hosted gates

The workflow builds dependencies from source with binary dependency downloads disabled. The candidate requires exact package identities, declared dependency closure, source recipe hashes, private payload paths and links, license evidence, AArch64/Android ELF properties and shared-library providers. After a successful audit, CI creates an ephemeral signing key and temporary feed, verifies package/index hashes and signed metadata, and runs an exact APT simulation. No actual package installation occurs. All build, feed, source and private signing material is removed at the end of the hosted job, including on failure.

`ca-certificates-java`, `openjdk-17-x`, and `resolv-conf` are recommendations, not part of this required closure. A passing headless candidate does not prove TLS trust configuration or GUI support. Build-only dependencies are not promoted to runtime packages unless already required by the pinned runtime graph.

## Production remains blocked

Android install, `java -version`, `javac`/JAR execution, app-private paths and permissions, JNI/library loading, certificate behavior, upgrade and rollback have **NOT RUN**. Those gates must be verified on the target Android application before production publication or enabling Builder installation. CI success alone cannot open the release gate.

See the candidate PR and its exact workflow run for actual gate outcomes. The presence of this kit or its inventory is not a claim that compilation, static audit or signed APT simulation has passed.
