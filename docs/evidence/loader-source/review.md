# Review: actionable issues и scope approval

## Actionable issues

1. **Android test identity is instruction-only, not enforced by either test.** `android-module-loader-probe.c` prints `getuid()` but accepts any UID. Smoke script validates `PREFIX` and a caller-settable `TERMUX_APP_PACKAGE` environment variable, not the actual app UID/package. A run from another shell/UID could therefore produce a passing probe/smoke despite the handoff requiring same-app execution. Before treating output as Android evidence, require captured independently verified package UID / app process context (or mark result operator-attested and verify externally); retain `android=NOT_RUN` absent that evidence.
2. **Smoke PASS is deliberately narrow and should not be elevated.** It checks module/source/sink names, process liveness and nonzero capture bytes; it does not verify non-silent signal, successful completion/status of playback/record clients, or physical audio/AGC callbacks. Handoff already limits the meaning to module init/null-audio processing; preserve that boundary in any subsequent summary. No false positive in this limited scope established.

## Findings / no change requested

- API-24 Bionic source supports the stated **conditional parent-root/local-group** argument: root plus `DT_NEEDED` dependency closure form a local group, and the same group is supplied during each member's link; lookup visits global then local group. This supports the exact parent-first candidate topology, not arbitrary isolated helper loading, path/namespace access, nor actual app execution. The documents preserve those caveats and leave Android unrun.
- No evidence found here that either test installs packages, touches the production feed, stops an existing daemon, uses a microphone, or weakens signatures/gates. Smoke's private server/socket/config and null sinks are appropriately scoped; its retained temporary evidence is intentional.
- Weak-import conclusions are appropriately qualified: 68 `memfd_create` records are not generalized from the Abseil sample; coverage and source guards are presented as source/binary contracts rather than Android safety qualification. `weak-final-classification.json` keeps `safetyQualified=false`, `android=NOT_RUN`, and non-fully-classified memfd entries. No inaccurate broad source conclusion identified in the reviewed material.

## Approval scope

**Approve source-analysis and static-evidence deliverables only, with the identity-enforcement caveat above; do not approve Android qualification or release.** Keep ELF auditor `FAIL`, Android `NOT_RUN`, `qualified=false`, `productionAllowed=false`, production signer/feed/publication gates unchanged. No device was available; no test was run and no reviewed file was modified.
## Исправление после review

Оба Android harness теперь fail-closed проверяют совпадение текущего app UID (>=10000) с владельцем `/data/user/0/com.karat.aibuilder`; C probe также требует точный путь module-echo-cancel. C собран на host с `-Werror`; отрицательный wrong-target контроль вернул 65. Это не Android execution и не замена отдельной проверке APK/package identity. Smoke прошёл `bash -n`, но на Android не запускался.
