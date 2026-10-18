# CMake 4.4.4 + Ninja 1.13.2: private aarch64 candidate

This kit builds both real upstream tools from the pinned Termux recipe checkout `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`, using the digest-pinned official builder. It does not consume the stock Termux target feed or target binaries. The modeled private application identity/prefix is set in `scripts/properties.sh`. One SHA-locked controlled recipe overlay adds curl's supported `--without-zstd` flag: the first hosted build proved that curl auto-detected build-only zstd and otherwise acquired an undeclared `libzstd.so.1` runtime dependency. This disables only optional zstd HTTP content compression; the 22-package declared runtime contract is unchanged. Both original and effective libcurl recipe hashes and the exact two-file patch scope are verified. No ELF provider exception is added.

The exact required runtime closure contains 22 packages and 34 dependency alternatives. CMake's optional `cmake-curses-gui` subpackage and its ncurses UI dependency are build-time outputs, not members of this CLI candidate feed. CMake recommendations `clang` and `make` are excluded from the no-recommends installation simulation. Both independent roots are requested with exact versions; no synthetic metapackage is used.

## Verification

The hosted-only wrapper `build-cmake-ninja-private-aarch64.sh` requires a clean exact source commit, a pinned manifest and closure, at least 8 GiB free, the already-present pinned Docker image and the original restricted AppArmor profile. The complete 69-file runtime recipe-directory inventory is checked. Both source archives are SHA-256 verified, and CMake `LICENSE.rst` and Ninja `COPYING` are checked against source-backed hashes without extraction. The source license install script is independently hash-pinned.

`audit_cmake_ninja_closure.py --package-set ... --source-closure ... --packages-dir ... --prefix ... --report ...` streams every DEB control/payload archive. It enforces exact versions including Debian revisions, architecture and recipe license identity, private paths, in-prefix links, license payload/provider evidence, AArch64 ELF/linker/RPATH checks, unique shared-library providers and narrow exact no-SONAME provider paths. CMake, CTest, CPack and Ninja executable payloads are mandatory. CMake's packaged copyright must match its actual source license. Shared license links are limited to the previously byte-verified embedded bootstrap license inventory; that inventory is archive evidence, not an observation of an Android device.

`validate_cmake_ninja_feed.py` binds all 22 DEBs and index records to the successful build and static audit records. The workflow creates an ephemeral key, signs `Release`/`InRelease`, verifies signatures with an isolated `signed-by` keyring, checks exact APT planning for both `cmake=4.4.4` and `ninja=1.13.2`, and downloads and hash-compares both roots. Modified signature/feed smoke cases must fail. APT uses a temporary empty status database and performs no real installation.

The workflow uploads no binary artifacts, publishes no feed/Pages/Release and removes its temporary source, outputs, archives, feed and signing material. A green hosted run demonstrates only the recorded source/static/signed-simulation gates, not Android usability.

## Android release gate

Android installation, tool execution, a real project build with CMake/Ninja, upgrade and rollback remain **NOT RUN**. Production publication and Builder installation remain **BLOCKED** until verified device evidence passes those gates. No source inventory, host-only test or APT simulation substitutes for that proof.
