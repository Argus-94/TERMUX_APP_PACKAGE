#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const checks = [
  ["v505 Android MainApplication plugin callback order, registration uniqueness and supported forms", ["scripts/aib-v502-main-application-package-registration-selftest.mjs"]],
  ["v505 explicit AIB_TOOL calls route to Agent and never silently downgrade to ordinary chat", ["scripts/aib-v505-explicit-agent-tool-routing-selftest.mjs"]],
  ["v505 exact AIB_TOOL runtime.packages dispatch, durable workspace checkpoint and per-call GitHub authorization", ["scripts/aib-v502-agent-dispatch-selftest.mjs"]],
  ["v505 bounded, fail-closed ZIP/APK central-directory metadata inspection", ["scripts/aib-file-intake-zip-selftest.mjs"]],
  ["v506 bounded DOCX/XLSX/APK/ZIP content extraction and hostile-input rejection", ["scripts/aib-document-content-extractors-selftest.mjs"]],
  ["v507 Karat-signed offline package archive validation, bounded extraction and explicit install flow", ["scripts/aib-offline-package-bundle-selftest.mjs"]],
  ["v507 native Karat verification, exact dependency/index match and app-private local APT transaction boundaries", ["scripts/aib-offline-package-native-boundary-selftest.mjs"]],
  ["v511 online feed anti-replay concurrency, aligned limits, streamed download, size/hash checks and cancellation", ["scripts/aib-online-package-feed-hardening-selftest.mjs"]],
  ["v512 GitHub Release single-archive/per-package feed transport and no-hang timeout recovery", ["scripts/aib-online-package-feed-runtime-selftest.mjs"]],
  ["v506 PDF native extractor source pin, drift guard and resource limits", ["scripts/aib-apply-pdf-extractor-patch-selftest.mjs"]],
  ["v506 production signing, release-only R8/resource hardening and pinned signer/hook policy use local credentials and leave debug unchanged", ["scripts/aib-android-release-signing-selftest.mjs"]],
  ["v511 V1 API18-23, legacy V2 API24-27 and current V3 API28-36 with pinned lineage", ["scripts/aib-release-lineage-signing-selftest.mjs"]],
  ["v505 attachment filename and materialized-URI privacy across chat logs, export and agent diagnostics", ["--experimental-strip-types", "scripts/aib-attachment-log-privacy-selftest.mjs"]],
  ["v505 embedded runtime canonical roots, tracked cancellation, descendant cleanup and bounded output readers", ["scripts/aib-v502-termux-runtime-lifecycle-selftest.mjs"]],
  ["v502 automatic bounded candidate failure details in ordinary logs, exact transaction and no share UI", ["scripts/aib-v502-candidate-failure-log-selftest.mjs"]],
  ["v503 typed offline-only embedded-private assembleDebug, cached toolchain and no installer/fallback", ["scripts/aib-v503-offline-private-build-selftest.mjs"]],
  ["v497 evidence paths only after native marker and clearly separated from failure cause", ["scripts/aib-v497-candidate-evidence-path-selftest.mjs"]],
  ["v496 actual generated Kotlin staging path/account guards, host JVM equivalent", ["scripts/aib-v496-candidate-stage-jvm-selftest.mjs"]],
  ["v496 exact private runtime Android aliases", ["scripts/aib-v496-private-runtime-path-selftest.mjs"]],
  ["v496 package menu opt-in versus bridge diagnostics", ["scripts/aib-v496-package-menu-availability-selftest.mjs"]],
  ["v496 safe native-stage diagnostic code vocabulary", ["scripts/full-candidate-diagnostic-selftest.mjs"]],
  ["v496 actual Console PTY/Termux toggle, busy guards and back navigation", ["scripts/aib-v496-terminal-mode-selftest.mjs"]],
  ["v499 terminal session snapshots use app-private storage, never shared HOME metadata", ["--experimental-strip-types", "scripts/aib-v499-private-terminal-session-store-selftest.mjs"]],
  ["v500 exact project path survives terminal open, cd, save, restore and runtime hooks", ["scripts/aib-terminal-session-selftest.mjs"]],
  ["v495 actual embedded queue burst, failure release and queued abort", ["scripts/aib-v495-exec-queue-selftest.mjs"]],
  ["v495 runtime/sidebar generation guards and modeled stale-response races", ["scripts/aib-v495-runtime-selection-selftest.mjs"]],
  ["v495 package button feedback with fail-closed mutation guards", ["scripts/aib-v495-menu-actions-selftest.mjs"]],
  ["v495 actual signed82 panel press, confirm, dispatch and inventory actions", ["scripts/aib-v495-full-panel-actions-selftest.mjs"]],
  ["v495 signed82 expiry before native I/O, actual API and invalid date", ["scripts/aib-v495-signed82-expiry-selftest.mjs"]],
  ["embedded exec source template, cwd/layout/environment and serial dispatch contract", ["scripts/aib-embedded-termux-exec-selftest.mjs"]],
  ["v494 candidate Android asset mapping, exact source bytes, collision/idempotence and pin rejection", ["scripts/aib-v494-candidate-asset-mapping-selftest.mjs"]],
  ["v493 fixed native candidate boundary and bounded private deadline", ["scripts/aib-v493-candidate-native-boundary-selftest.mjs"]],
  ["v493 private Python archive without hidden package installs", ["--experimental-strip-types", "scripts/aib-v493-private-archive-selftest.mjs"]],
  ["v493 full signed coherent 82 assets, API/UI and 42-case host transaction safety (no live APT)", ["scripts/aib-v493-full-candidate-gates-selftest.mjs"]],
  ["v493 generated full-feed Kotlin host-JVM staging: exact assets, Android alias, cache integrity and bounded partials", ["python3", "scripts/aib-v493-full-feed-native-selftest.py"]],
  ["v493 exact signed candidate assets, private API and test-only make boundary", ["scripts/aib-v493-candidate-api-selftest.mjs"]],
  ["v493 generated candidate-evidence Kotlin host-JVM fixtures: bytes, ownership, limits and concurrency", ["python3", "scripts/aib-v493-candidate-jvm-selftest.py"]],
  ["v493 actual generated custom command failures and raw-check policy bypass", ["scripts/aib-v493-custom-outcomes-selftest.mjs"]],
  ["custom package injection, distribution checks and reviewed commands", ["scripts/aib-custom-package-safety-selftest.mjs"]],
  ["package catalog shell syntax and unqualified private feed fixture", ["scripts/aib-package-menu-install-selftest.mjs"]],
  ["package installer UI strict outcomes and private transport regression", ["scripts/aib-package-installer-ui-regression-selftest.mjs"]],
  ["generic Termux APT operations fail closed before network, install body, source changes, or mirror retry", ["--experimental-strip-types", "scripts/aib-termux-apt-install-regression-selftest.mjs"]],
  ["v492 private manual package mutation gate and actual catalog APIs", ["scripts/aib-v492-private-package-mutation-selftest.mjs"]],
  ["v492 right sidebar private target and qualified install controls", ["scripts/aib-v492-sidebar-selftest.mjs"]],
  ["v492 script artifact outcomes and history boundaries", ["scripts/aib-v492-script-artifact-selftest.mjs"]],
  ["v492 private-only cache cleanup and strict outcomes", ["scripts/aib-v492-cache-cleanup-selftest.mjs"]],
  ["v492 build runner preserves native timeout and recovery result", ["scripts/aib-v492-build-result-selftest.mjs"]],
  ["v492 shared private bootstrap initialization and retry routing", ["scripts/aib-v492-bootstrap-routing-selftest.mjs"]],
  ["v492 embedded readiness UI and internal terminal navigation", ["scripts/aib-v492-ui-runtime-selftest.mjs"]],
  ["v491 native failure-code privacy and real JS exports with mocked bridge", ["scripts/aib-v491-runtime-diagnostics-selftest.mjs"]],
  ["v490 public SDK workspace APIs and no-follow directory validation (host fixtures)", ["scripts/aib-v490-workspace-sdk-selftest.mjs"]],
  ["v489 generated Kotlin workspace Android API imports", ["scripts/aib-termux-bridge-workspace-imports-selftest.mjs"]],
  ["v489 scoped chat image/file picker without broad media permissions", ["scripts/aib-chat-attachment-picker-selftest.mjs"]],
  ["v489 balance-only diagnostic privacy and validator classification", ["scripts/aib-v489-balance-diagnostic-selftest.mjs"]],
  ["v488 exact project root, ambient override denial and truncated proof rejection", ["scripts/aib-v488-project-root-selftest.mjs"]],
  ["v488 package profile private dispatch (mock runtime)", ["scripts/aib-v488-routing-selftest.mjs"]],
  ["v488 UI embedded-only flows and no external setup", ["scripts/aib-v488-ui-selftest.mjs"]],
  ["v488 native exact-root workspace and embedded dispatch", ["scripts/aib-v488-native-selftest.mjs"]],
  ["v488 core embedded transport and qualification boundaries", ["scripts/aib-v488-core-selftest.mjs"]],
  ["v488 standalone autobuild fails closed before I/O (real bash)", ["scripts/aib-v488-autobuild-boundary-selftest.mjs"]],
  ["v488 whole-source embedded boundary and v507-pinned dependency/build settings", ["scripts/aib-v487-embedded-boundary-selftest.mjs"]],
  ["v487 native descriptor-rooted nested workspace safety (host fixtures)", ["scripts/aib-v487-native-workspace-selftest.mjs"]],
  ["v487 nested workspace JS flow, hostile native replies and approved cwd", ["scripts/aib-v487-workspace-flow-selftest.mjs"]],
  ["v487 durable workspace.write checkpoint and project confinement", ["scripts/aib-v487-workspace-checkpoint-selftest.mjs"]],
  ["embedded-only first-launch permission flow", ["scripts/aib-permissions-onboarding-selftest.mjs"]],
  ["localized embedded-only guidance key parity", ["scripts/aib-i18n-parity-selftest.mjs"]],
  ["v486 embedded-only routing, foreign-private-path denial and blocked install I/O", ["--experimental-strip-types", "scripts/aib-v486-private-only-selftest.mjs"]],
  ["v485 credit response fixtures and explicit refresh schedule", ["scripts/aib-v485-manus-credits-selftest.mjs"]],
  ["v485 saved+verified credit lifecycle, stale data and API failures", ["scripts/aib-v485-manus-balance-lifecycle-selftest.mjs"]],
  ["v485 settings balance visibility and honest time display", ["scripts/aib-v485-manus-card-selftest.mjs"]],
  ["embedded bootstrap readiness, private live probe and no external discovery", ["scripts/aib-v484-termux-readiness-selftest.mjs"]],
  ["v483 native cloud mode switch and blocked-state feedback", ["scripts/aib-v483-cloud-mode-switch-selftest.mjs"]],
  ["cloud key settings lifecycle and failure isolation", ["scripts/aib-v482-manus-settings-selftest.mjs"]],
  ["v482 cloud API v2 contract and task lifecycle", ["scripts/aib-v482-manus-selftest.mjs"]],
  ["v482 cloud key storage and pinned native route integration", ["scripts/aib-v482-manus-integration-selftest.mjs"]],
  ["identity/release contract", ["scripts/aib-release-selftest.mjs"]],
  ["protected compilation baseline/version synchronization", ["scripts/aib-compilation-settings-guard-selftest.mjs"]],
  ["console composer remains editable without an active session and opens one on send", ["scripts/aib-terminal-composer-selftest.mjs"]],
  ["embedded private one-shot cancellation contract", ["--experimental-strip-types", "scripts/aib-embedded-termux-cancel-selftest.mjs"]],
  ["private runtime provider routing and fail-closed contract", ["scripts/aib-private-runtime-provider-selftest.mjs"]],
  ["agent TERMUX_RUN private-target dispatch, fail-closed behavior and legacy isolation", ["scripts/aib-agent-private-shell-selftest.mjs"]],
  ["AIB_TOOL private capability gate, bounded runtime.status probe and legacy isolation", ["scripts/aib-private-agent-tools-selftest.mjs"]],
  ["embedded-private read-only dpkg package inventory, fixed argv and bounds", ["--experimental-strip-types", "scripts/aib-private-package-inventory-selftest.mjs"]],
  ["v476 pinned embedded-Termux package plan; source-only/no-binary guard", ["scripts/aib-termux-package-plan-selftest.mjs"]],
  ["v479 signed package-feed gate and runtime-derived package-builder workflow inputs", ["--experimental-strip-types", "scripts/aib-v479-termux-feed-selftest.mjs"]],
  ["Android MANAGE_EXTERNAL_STORAGE explicit Settings flow and exact-root workspace gate", ["scripts/aib-workspace-all-files-access-selftest.mjs"]],
  ["storage permission merge and restricted-permission policy disclosure", ["scripts/aib-storage-permission-selftest.mjs"]],
  ["v501 generated TerminalView private-layout/session-ID guards and Android bridge Kotlin template", ["scripts/aib-termux-bridge-kotlin-template-selftest.mjs", "scripts/aib-embedded-terminal-view-selftest.mjs"]],
  ["embedded command I/O, stdin EOF and background output persistence", ["--experimental-transform-types", "scripts/aib-v478-termux-command-execution-selftest.mjs"]],
  ["v480 Termux result-wait status is honest after 30 seconds", ["--experimental-strip-types", "scripts/aib-v480-termux-command-wait-selftest.mjs"]],
  ["embedded readiness smoke, no external version floor and diagnostic privacy", ["--experimental-strip-types", "scripts/aib-v481-termux-callback-capability-selftest.mjs"]],
  ["private workspace exact-root SAF boundary, metadata-only access and no fallback", ["scripts/aib-private-workspace-selftest.mjs"]],
  ["workspace.read typed all-files denial, native-file dispatch and no SAF fallback", ["scripts/aib-private-workspace-read-selftest.mjs"]],
  ["agent private-only readiness routing and legacy isolation", ["scripts/aib-agent-shell-readiness-selftest.mjs"]],
  ["source routing and hostile archive preflight", ["scripts/aib-project-source-routing-selftest.mjs"]],
  ["v385 missing-utility archive recovery and build continuation", ["--experimental-transform-types", "scripts/aib-v385-build-recovery-selftest.mjs"]],
  ["backend-private temporary build runner and offline recovery simulations", ["--experimental-strip-types", "scripts/aib-project-build-runner-selftest.mjs"]],
  ["v387 atomic source-proof recovery and mocked native runner", ["--experimental-transform-types", "scripts/aib-v386-project-build-handoff-selftest.mjs"]],
  ["dormant recipe package-manager adapter fixture (not install qualification)", ["scripts/aib-autobuild-package-manager-selftest.mjs"]],
  ["wrapped autobuild qualification refusal and parser contract (real bash)", ["--experimental-strip-types", "scripts/aib-v389-autobuild-selftest.mjs"]],
  ["generated runner refuses unqualified build without primary execution", ["--experimental-strip-types", "scripts/aib-v409-runner-e2e-selftest.mjs"]],
  ["v389 autobuild body in sync with shell source", ["scripts/aib-gen-autobuild.mjs", "--check"]],
  ["v389 unrestricted agent shell with catastrophic floor", ["--experimental-strip-types", "scripts/aib-v389-guard-selftest.mjs"]],
  ["source compile/API contract", ["scripts/aib-source-compile-audit-selftest.mjs"]],
  ["backend-aware recovery/toolchain policy", ["scripts/aib-recovery-toolchain-layer-selftest.mjs"]],
  ["single APK toolchain policy across prompts/repairs", ["scripts/aib-apk-policy-consistency-selftest.mjs"]],
  ["deterministic repair safety", ["scripts/aib-build-recovery-hardening-selftest.mjs"]],
  ["generic script-runner recovery remains fail-closed", ["scripts/aib-script-runner-recovery-selftest.mjs"]],
  ["APK/AAB ZIP/signature gate behavior", ["--experimental-strip-types", "scripts/aib-apk-validation-selftest.mjs"]],
  ["build log repair regression", ["scripts/aib-build-log-repair-selftest.mjs"]],
  ["recorded-format fake agent/recovery scenarios", ["--experimental-strip-types", "scripts/aib-sim-agent-scenarios.mjs"]],
  ["antigravity native-priority / tools / settings", ["scripts/aib-native-priority-selftest.mjs"]],
  ["post-antigravity priorities wiring", ["scripts/aib-priorities-v395-selftest.mjs"]],
  ["GitHub fetch exact-host and API-path allowlist", ["scripts/aib-github-url-policy-selftest.mjs"]],
  ["agent tool registry parity", ["scripts/aib-agent-tool-registry-selftest.mjs"]],
  ["documentation completeness", ["scripts/aib-docs-selftest.mjs"]],
  ["shell-comment and full-source syntax", ["scripts/aib-ts-shell-comment-syntax-selftest.mjs"]],
  ["full source syntax audit", ["scripts/aib-full-source-syntax-selftest.mjs"]],
];

console.log(`AIBuilder-Expo pre-release checks (${process.version})`);
console.log("Evidence is source/static/hermetic only; no Android device, emulator, live model, or APK build is implied.\n");
const results = [];
for (const [label, args] of checks) {
  console.log(`\n=== ${label} ===`);
  const python = args[0] === "python3";
  const result = spawnSync(python ? "python3" : process.execPath, python ? args.slice(1) : args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const code = result.status ?? 1;
  results.push({ label, code });
  console.log(`[${code === 0 ? "PASS" : "FAIL"}] ${label} (exit=${code})`);
}

console.log("\n=== Summary ===");
for (const row of results) console.log(`${row.code === 0 ? "PASS" : "FAIL"}  ${row.label}`);
const failed = results.filter((row) => row.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${failed.length} failed.`);
console.log("Android device smoke status remains NOT RUN unless separately recorded in DEVICE_SMOKE.md.");
if (failed.length) process.exitCode = 1;
