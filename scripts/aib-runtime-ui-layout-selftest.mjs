#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /actionFull/);
assert.match(ui, /actionHint/);
assert.match(ui, /Цепочка внутри контейнера|In-container pipeline/);
assert.match(ui, /recreate_session/);
assert.match(ui, /Пересоздать сессию builder/);
assert.match(ui, /folder-open-outline/);
assert.match(ui, /construct-outline/);
assert.doesNotMatch(ui, /onWorkspaceBuild[\s\S]{0,120}flexDirection: "row"/);

const checkStart = ui.indexOf("const onCheckSelectedEnvironment");
const installStart = ui.indexOf("const onInstallSelectedEnvironment", checkStart);
assert.ok(checkStart >= 0 && installStart > checkStart, "selected environment has separate read-only Check and guarded Prepare handlers");
const checkHandler = ui.slice(checkStart, installStart);
assert.doesNotMatch(checkHandler, /bootstrapDebian|bootstrapUbuntu|runEnvironmentAction|prepareProotRuntimeEnvironment|installProotDistroRootfsWithPrerequisite/,
  "Check remains read-only");
assert.match(ui, /onPress=\{\(\) => void onCheckSelectedEnvironment\(\)\}/);
assert.match(ui, /\{canPrepareSelected \? \(/, "Prepare remains visible for selected unknown/error and relies on fresh preflight");
assert.match(ui, /const canPrepareSelected = runtimeProjection\.prepareAlias !== null && canOfferRuntimePreparationAction\(environmentBackend, selectedReadiness\)/);
assert.match(ui, /onPress=\{\(\) => void onInstallSelectedEnvironment\(\)\}/);
assert.match(ui, /onPress=\{\(\) => void selectEnvironment\(id\)\}/);
assert.match(ui, /await runEnvironmentAction\(backend, true\)/, "selection routes to read-only check, not installation");
assert.match(ui, /if \(persistSelection\) \{\s*await runReadOnlyEnvironmentCheck\(backend, true\);\s*return;/);
assert.match(ui, /runProotRuntimePreparationAction\(backend,[\s\S]{0,300}check:\s*\(\) => inspectProotRuntimeReadiness/,
  "Prepare fails closed based on a fresh selected-target read-only classification");
assert.match(ui, /prepareProotRuntimeEnvironment\(backend, \{/);
assert.match(ui, /installProotDistroRootfsWithPrerequisite\(distro, run, onProgress, shouldAbort\)/);
assert.doesNotMatch(ui, /const onInstallProotDistro\s*=|const onLinuxBootstrap\s*=|ensureRootfs\("ubuntu"\)/,
  "there is no second app-level installer path");
assert.doesNotMatch(ui, /useEffect\(\(\) => \{[^}]*prepareProotRuntimeEnvironment/, "mount cannot silently install");
assert.match(ui, /await loadEnvironmentBackend\(\)[\s\S]{0,350}runReadOnlyEnvironmentCheck\(backend, false\)/,
  "screen-open refresh loads and checks only the persisted selected target");
assert.match(ui, /runtimePreparationUiProgress\?\.phase[\s\S]{0,600}runtimePreparationUiProgress\?\.activeCommand/);
const prepUiStart = ui.indexOf("runtimePreparationRunning && runtimeProjection.prepareAlias");
assert.ok(prepUiStart >= 0);
assert.doesNotMatch(ui.slice(prepUiStart, prepUiStart + 1200), /ProgressBar|percent|%/,
  "preparation progress displays actual stages and active-command labels, never a synthetic percentage");
assert.doesNotMatch(ui, /initUserspaceRuntime\(\)/, "no automatic multi-backend userspace probe on Runtime Environment open");
assert.match(ui, /projectRuntimeEnvironment\(environmentBackend,/);
assert.match(ui, /runtimeProjection\.statusRows\.map/);
assert.match(ui, /runtimeProjection\.settingsPath/);
assert.match(ui, /environmentBackend === "termux" \? \(/, "Termux-only status/health cards are hidden for Ubuntu/Debian");
assert.match(ui, /environmentBackend !== "termux" && selectedReadiness\?\.status === "ready" \? \(/,
  "selected guest archive controls stay inside the active ready Ubuntu/Debian view");
assert.match(ui, /environmentBackend === "ubuntu-proot" && runtimeReadiness\?\.target === "ubuntu-proot" && runtimeReadiness\.status === "ready"/);
assert.doesNotMatch(ui, /rootfsStatusSummary\("Debian"[\s\S]{0,180}rootfsStatusSummary\("Ubuntu"/);
assert.doesNotMatch(ui, /Target selected; rootfs presence is unknown\.|Выбрана цель; наличие rootfs неизвестно\./);
console.log("aib-runtime-ui-layout-selftest: OK");
