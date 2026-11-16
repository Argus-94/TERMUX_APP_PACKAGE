#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = new Map();
function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
function loadTs(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  cache.set(file, mod);
  mod.require = (request) => {
    const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
    return resolved ? loadTs(resolved) : createRequire(file)(request);
  };
  const js = typescript.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}

const { canOfferRuntimeInstall, canOfferRuntimePreparationAction, isRuntimeEnvironmentDetailVisible, projectRuntimeEnvironment } = loadTs(path.join(root, "lib/runtime-environment-projection.ts"));
const stale = {
  termuxReady: false,
  ubuntu: { installed: false, healthy: false, staleDiagnostic: "FOREIGN_UBUNTU_STALE_SENTINEL" },
  debian: { rootfsInstalled: true, healthy: false, staleDiagnostic: "FOREIGN_DEBIAN_STALE_SENTINEL" },
};

const termux = projectRuntimeEnvironment("termux", { ...stale, termuxReady: true });
assert.deepEqual(termux.statusRows.map((row) => row.id), ["termux"]);
assert.deepEqual(termux.statusRows.map((row) => row.ready), [true]);
assert.equal(termux.health, "ready");
assert.equal(termux.settingsPath, "/termux-settings");
assert.equal(termux.prepareAlias, null);
assert.doesNotMatch(JSON.stringify(termux), /Ubuntu|Debian|FOREIGN_/);

const ubuntu = projectRuntimeEnvironment("ubuntu-proot", {
  ...stale,
  ubuntu: { installed: true, healthy: true, staleDiagnostic: "SELECTED_UBUNTU_DETAIL" },
});
assert.deepEqual(ubuntu.statusRows.map((row) => row.id), ["ubuntu-rootfs"]);
assert.deepEqual(ubuntu.statusRows.map((row) => row.ready), [true]);
assert.equal(ubuntu.health, "ready");
assert.equal(ubuntu.settingsPath, null);
assert.equal(ubuntu.prepareAlias, "ubuntu");
assert.doesNotMatch(JSON.stringify(ubuntu), /Termux|Debian|FOREIGN_|SELECTED_UBUNTU_DETAIL/);

const debian = projectRuntimeEnvironment("ubuntu-proot", {
  ...stale,
  debian: { rootfsInstalled: true, healthy: false, staleDiagnostic: "SELECTED_DEBIAN_LOGIN_UNVERIFIED" },
});
assert.deepEqual(debian.statusRows.map((row) => row.id), ["debian-rootfs"]);
assert.deepEqual(debian.statusRows.map((row) => row.ready), [false]);
assert.equal(debian.health, "login-unverified");
assert.equal(debian.settingsPath, null);
assert.equal(debian.prepareAlias, "debian");
assert.doesNotMatch(JSON.stringify(debian), /Termux|Ubuntu|FOREIGN_|SELECTED_DEBIAN_LOGIN_UNVERIFIED/);

for (const target of ["termux", "ubuntu-proot", "ubuntu-proot"]) {
  for (const [sibling, label] of [["termux", "Termux"], ["ubuntu-proot", "Ubuntu"], ["ubuntu-proot", "Debian"]]) {
    if (sibling === target) continue;
    assert.equal(isRuntimeEnvironmentDetailVisible(target, `${label} rootfs login failed`), false,
      `${target} must suppress stale ${label} details`);
  }
  assert.equal(isRuntimeEnvironmentDetailVisible(target, "Shared application-level diagnostic"), true);
  assert.equal(isRuntimeEnvironmentDetailVisible(target, "unclassified proot rootfs state"), false,
    `${target} must not show ambiguous guest state`);
}

for (const target of ["termux", "ubuntu-proot", "ubuntu-proot"]) {
  assert.equal(canOfferRuntimeInstall(target, { target, status: "missing" }), target !== "termux");
  assert.equal(canOfferRuntimeInstall(target, { target, status: "ready" }), false);
  assert.equal(canOfferRuntimeInstall(target, { target, status: "error" }), false);
  const sibling = target === "ubuntu-proot" ? "ubuntu-proot" : "ubuntu-proot";
  assert.equal(canOfferRuntimeInstall(target, { target: sibling, status: "missing" }), false);
  assert.equal(canOfferRuntimeInstall(target, null), false);
  assert.equal(canOfferRuntimePreparationAction(target, { target, status: "missing" }), target !== "termux");
  assert.equal(canOfferRuntimePreparationAction(target, { target, status: "error" }), target !== "termux",
    "unknown/error keeps a guarded Prepare action for the selected Linux backend");
  assert.equal(canOfferRuntimePreparationAction(target, { target, status: "ready" }), false);
  assert.equal(canOfferRuntimePreparationAction(target, null), target !== "termux");
  assert.equal(canOfferRuntimePreparationAction(target, { target: sibling, status: "missing" }), target !== "termux",
    "stale sibling readiness cannot hide the selected target's safe preflight action");
}

const runtimeUi = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
const sidebar = fs.readFileSync(path.join(root, "components/PackagesRightMenu.tsx"), "utf8");
for (const relative of ["app/runtime.tsx", "components/PackagesRightMenu.tsx", "lib/package-menu-routing.ts", "lib/runtime-environment-projection.ts"]) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const parsed = typescript.transpileModule(source, {
    fileName: relative,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: typescript.JsxEmit.ReactJSX,
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  });
  const syntaxErrors = (parsed.diagnostics ?? []).filter((item) => item.category === typescript.DiagnosticCategory.Error);
  assert.equal(syntaxErrors.length, 0, `${relative} syntax: ${syntaxErrors.map((item) => item.code).join(",")}`);
}
assert.ok(/projectRuntimeEnvironment\(environmentBackend,/.test(runtimeUi));
assert.ok(/runtimeProjection\.statusRows\.map/.test(runtimeUi));
assert.ok(/runtimeProjection\.settingsPath/.test(runtimeUi));
assert.ok(!/rootfsStatusSummary\("Debian"[\s\S]{0,180}rootfsStatusSummary\("Ubuntu"/.test(runtimeUi),
  "the selected environment panel must not concatenate sibling rootfs statuses");
assert.ok(runtimeUi.includes('{environmentBackend !== "termux" && selectedReadiness?.status === "ready" ? ('),
  "selected Ubuntu/Debian rootfs archive actions are shown only for a verified-ready target");
assert.match(runtimeUi, /environmentBackend === "ubuntu-proot" && runtimeReadiness\?\.target === "ubuntu-proot" && runtimeReadiness\.status === "ready"/,
  "Ubuntu project actions are limited to the selected healthy Ubuntu runtime");
assert.doesNotMatch(runtimeUi, /ensureRootfs\("ubuntu"\)|const onInstallProotDistro\s*=|const onLinuxBootstrap\s*=/,
  "no secondary rootfs install entry point may bypass the confirmed-missing Install action");
assert.match(runtimeUi, /onPress=\{\(\) => void onInstallSelectedEnvironment\(\)\}/,
  "the one explicit Install/Prepare button invokes the selected-target action");
assert.match(runtimeUi, /runProotRuntimePreparationAction\(backend,[\s\S]{0,300}check:\s*\(\) => inspectProotRuntimeReadiness/,
  "every explicit button click runs the production read-only preflight again before mutation");
assert.match(runtimeUi, /canOfferRuntimePreparationAction\(environmentBackend, selectedReadiness\)/,
  "unknown/error can show Prepare without being treated as confirmed absence");
assert.match(runtimeUi, /runtimePreparationUiProgress\?\.phase[\s\S]{0,600}runtimePreparationUiProgress\?\.activeCommand/,
  "installation status reports real stages and active command labels rather than a percentage bar");
assert.doesNotMatch(runtimeUi.slice(runtimeUi.indexOf("runtimePreparationRunning && runtimeProjection.prepareAlias"), runtimeUi.indexOf("runtimePreparationRunning && runtimeProjection.prepareAlias") + 1200), /ProgressBar|percent|%/,
  "runtime preparation UI never fabricates a percentage");
assert.doesNotMatch(runtimeUi, /initUserspaceRuntime\(\)/,
  "opening Runtime Environment cannot probe all sibling backends");
assert.match(runtimeUi, /const refreshEnvironmentStatus = useCallback\(async \(\) => \{[\s\S]{0,400}const backend = await loadEnvironmentBackend\(\);[\s\S]{0,280}await runReadOnlyEnvironmentCheck\(backend, false\)/,
  "screen-open refresh loads and checks only the persisted active target without installing");
assert.match(runtimeUi, /if \(persistSelection\) \{\s*await runReadOnlyEnvironmentCheck\(backend, true\);\s*return;/,
  "selecting Ubuntu or Debian persists the choice and runs a read-only check only");
assert.match(sidebar, /setExpanded\(\{ \.\.\.COLLAPSED_SECTIONS \}\)/,
  "opening the right menu leaves all sections collapsed and performs no automatic scan");
assert.match(sidebar, /if \(section !== "custom" \|\| customToolsReadyRef\.current\) \{\s*void verifySection\(section\)/,
  "a section check begins only from its expansion action");
assert.match(sidebar, /expandedRef\.current\[section\][\s\S]{0,160}sectionExpansionGenerationRef\.current\[section\]/,
  "collapsed sections invalidate queued and late scan callbacks");
assert.doesNotMatch(sidebar, /resolveRightPackageMenuOpenScanPlan|startOpenScans/,
  "opening the drawer cannot start a full catalog scan");

console.log("AIB_V275_RUNTIME_ENVIRONMENT_UI_SELFTEST_OK");
