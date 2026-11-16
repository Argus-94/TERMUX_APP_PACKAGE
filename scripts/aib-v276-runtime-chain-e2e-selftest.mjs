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
  const output = typescript.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(output, file);
  return mod.exports;
}

const { inspectProotRuntimeReadiness } = loadTs(path.join(root, "lib/runtime-environment-check.ts"));
const {
  canOfferRuntimeInstall,
  canOfferRuntimePreparationAction,
  projectProotRootfsReadiness,
  projectRuntimeEnvironment,
} = loadTs(path.join(root, "lib/runtime-environment-projection.ts"));
const { prepareProotRuntimeEnvironment, PROOT_RUNTIME_REQUIREMENTS } = loadTs(path.join(root, "lib/runtime-environment-preparation.ts"));
const { installProotDistroRootfsWithPrerequisite } = loadTs(path.join(root, "lib/proot-distro-bootstrap.ts"));
const { buildProotAptFallbackInstallCommand } = loadTs(path.join(root, "lib/proot-apt-mirror-fallback.ts"));
const { buildProotDistroProbeCommand } = loadTs(path.join(root, "lib/proot-distro-state.ts"));
const { packageBackendTarget } = loadTs(path.join(root, "lib/package-command-routing.ts"));

const runtimeSource = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
const sidebarSource = fs.readFileSync(path.join(root, "components/PackagesRightMenu.tsx"), "utf8");
const packageMenuRoutingSource = fs.readFileSync(path.join(root, "lib/package-menu-routing.ts"), "utf8");

// Static integration assertions bind this mock to the real Runtime screen action path.
assert.match(runtimeSource, /onPress=\{\(\) => void selectEnvironment\(id\)\}/,
  "selecting a backend invokes the production selected-environment handler");
assert.match(runtimeSource, /if \(persistSelection\) \{\s*await runReadOnlyEnvironmentCheck\(backend, true\);\s*return;/,
  "selection persists the target and performs a read-only Check, not Install");
assert.match(runtimeSource, /onPress=\{\(\) => void onCheckSelectedEnvironment\(\)\}/,
  "the visible Check button invokes the production handler");
assert.match(runtimeSource, /const result = await inspectProotRuntimeReadiness\(backend,/,
  "the production handler runs the readiness classifier");
assert.match(runtimeSource, /const result = await runPackageCommand\(command, \{ \.\.\.options, traceId \}\)/,
  "readiness commands flow through the production package runner/router");
assert.match(runtimeSource, /setRuntimeReadiness\(result\)/,
  "the classified result is committed to screen state");
assert.match(runtimeSource, /const activeProotStatus = projectProotRootfsReadiness\(selectedReadiness\)/,
  "the selected-only rootfs row uses rootfs evidence rather than overall readiness");
assert.match(runtimeSource, /const canPrepareSelected = runtimeProjection\.prepareAlias !== null && canOfferRuntimePreparationAction\(environmentBackend, selectedReadiness\)/,
  "Prepare visibility remains available for selected unknown/error without treating them as absent");
assert.match(runtimeSource, /onPress=\{\(\) => void onInstallSelectedEnvironment\(\)\}/,
  "the visible Install/Prepare button invokes the production handler");
assert.match(runtimeSource, /runProotRuntimePreparationAction\(backend,[\s\S]{0,300}check:\s*\(\) => inspectProotRuntimeReadiness/,
  "each explicit click reruns the production read-only classifier before mutation");
assert.match(sidebarSource, /const buildBackend = RIGHT_PACKAGE_MENU_BACKEND/);
assert.match(packageMenuRoutingSource, /RIGHT_PACKAGE_MENU_BACKEND:\s*AgentShellBackend\s*=\s*"termux"/);
assert.match(sidebarSource, /setExpanded\(\{ \.\.\.COLLAPSED_SECTIONS \}\)/,
  "opening the package drawer remains lazy; sections start collapsed");

const targets = [
  { target: "ubuntu-proot", alias: "ubuntu", label: "Ubuntu" },
  { target: "ubuntu-proot", alias: "debian", label: "Debian" },
];
function hostResult(state = "AVAILABLE", extra = {}) {
  return { exitCode: 0, stdout: `AIB_PROOT_TOOL:${state}`, stderr: "", ...extra };
}
function rootfsResult(alias, state = "healthy", extra = {}) {
  const list = state === "missing"
    ? "No containers are installed."
    : `Installed containers:\n  * ${alias}`;
  const loginExit = state === "healthy" || state === "wrong-id" ? 0 : 1;
  const login = state === "healthy"
    ? `AIB_PROBE_ID:${alias}\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:aarch64`
    : state === "wrong-id"
      ? `AIB_PROBE_ID:${alias === "debian" ? "ubuntu" : "debian"}\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:aarch64`
      : state === "missing"
        ? `Error: container '${alias}' is not installed.`
        : "login failed";
  let stdout = [
    "AIB_PROBE_BEGIN", "AIB_PROOT_TOOL:AVAILABLE", "AIB_HOST_UNAME:aarch64", "AIB_LIST_EXIT:0", "AIB_LIST_BEGIN",
    list, "AIB_LIST_END", `AIB_LOGIN_EXIT:${loginExit}`, "AIB_LOGIN_BEGIN", login,
    "AIB_LOGIN_END", "AIB_PROBE_END",
  ].join("\n");
  if (state === "incomplete") stdout = stdout.replace("AIB_PROBE_END", "");
  if (state === "corrupt-list") stdout = stdout.replace(list, "Installed distributions:\n  unreadable/truncated data");
  return { exitCode: 0, stdout, stderr: "", ...extra };
}
function makeReadinessRunner(alias, config = {}) {
  const calls = [];
  const run = async (command, options) => {
    calls.push({ command, options });
    if (options.packageId === "proot-distro") {
      if (config.hostThrow) throw new Error(config.hostThrow);
      return hostResult(config.hostState === "missing" ? "MISSING" : "AVAILABLE", config.hostExtra);
    }
    if (options.packageId === "debian-rootfs" || options.packageId === "ubuntu-rootfs") {
      if (config.rootfsThrow) throw new Error(config.rootfsThrow);
      return rootfsResult(alias, config.rootfsState, config.rootfsExtra);
    }
    const state = config.packageStates?.[options.packageId] ?? "installed";
    if (state === "permission") return { exitCode: 1, stdout: "", stderr: "Permission denied" };
    if (state === "throw") throw new Error("RUN_COMMAND_PERMISSION_MISSING");
    if (state === "timeout") return { exitCode: -1, stdout: "", stderr: "", timedOut: true };
    if (state === "truncated") return { exitCode: 1, stdout: "", stderr: "", outputTruncated: true };
    return { exitCode: state === "missing" ? 1 : 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}
async function productionCheckAndScreen(target, alias, config = {}) {
  const runner = makeReadinessRunner(alias, config);
  const readiness = await inspectProotRuntimeReadiness(target, { run: runner.run });
  const selectedReadiness = readiness.target === target ? readiness : null;
  const activeRootfs = projectProotRootfsReadiness(selectedReadiness);
  const runtimeProjection = projectRuntimeEnvironment(target, {
    ubuntu: target === "ubuntu-proot" ? activeRootfs : null,
    debian: target === "ubuntu-proot" && activeRootfs
      ? { rootfsInstalled: activeRootfs.installed, healthy: activeRootfs.healthy }
      : null,
  });
  const installButtonVisible = runtimeProjection.prepareAlias !== null
    && canOfferRuntimePreparationAction(target, selectedReadiness);
  return { readiness, selectedReadiness, activeRootfs, runtimeProjection, installButtonVisible, calls: runner.calls };
}

for (const { target, alias } of targets) {
  // Healthy existing rootfs + complete baseline: selected UI is ready and hides Install.
  {
    const flow = await productionCheckAndScreen(target, alias);
    assert.equal(flow.readiness.status, "ready", `${target}: full read-only Check becomes ready`);
    assert.equal(flow.runtimeProjection.statusRows.length, 1, "only the selected runtime row is rendered");
    assert.equal(flow.runtimeProjection.statusRows[0].id, `${alias}-rootfs`);
    assert.equal(flow.runtimeProjection.statusRows[0].ready, true);
    assert.equal(flow.installButtonVisible, false);
    assert.equal(flow.calls.length, 7, "host + selected rootfs + five selected guest checks");
    assert.ok(flow.calls.every(({ options }) => options.kind === "check"), "Check never installs or updates");
    assert.equal(flow.calls[0].options.selectedBackend, "termux");
    assert.equal(flow.calls[1].options.selectedBackend, "termux");
    assert.ok(flow.calls.slice(2).every(({ options }) => options.selectedBackend === target));
  }

  // Missing host tool is actionable, but the rootfs row stays unknown (not falsely absent).
  {
    const flow = await productionCheckAndScreen(target, alias, { hostState: "missing" });
    assert.equal(flow.readiness.status, "missing");
    assert.deepEqual(flow.readiness.missingItems, ["proot-distro (Termux host)"]);
    assert.equal(flow.installButtonVisible, true, `${target}: host prerequisite absence exposes selected Install`);
    assert.deepEqual(flow.activeRootfs, { installed: null, healthy: false });
    assert.equal(flow.runtimeProjection.health, "unverified");
    assert.equal(flow.calls.length, 1, "a confirmed missing host tool stops before rootfs/guest probes");
  }

  // Missing rootfs and missing each baseline package independently expose Install for the selected alias.
  {
    const flow = await productionCheckAndScreen(target, alias, { rootfsState: "missing" });
    assert.equal(flow.readiness.status, "missing");
    assert.deepEqual(flow.readiness.missingItems, [`${alias} rootfs`]);
    assert.equal(flow.installButtonVisible, true);
    assert.deepEqual(flow.activeRootfs, { installed: false, healthy: false });
    assert.equal(flow.runtimeProjection.health, "confirmed-absent");
  }
  for (const requirement of PROOT_RUNTIME_REQUIREMENTS) {
    const flow = await productionCheckAndScreen(target, alias, {
      packageStates: { [requirement.id]: "missing" },
    });
    assert.equal(flow.readiness.status, "missing", `${target}/${requirement.id}: confirmed baseline miss remains actionable`);
    assert.deepEqual(flow.readiness.missingItems, [requirement.name]);
    assert.equal(flow.installButtonVisible, true, `${target}/${requirement.id}: selected Install button is visible`);
    assert.deepEqual(flow.activeRootfs, { installed: true, healthy: true },
      `${target}/${requirement.id}: missing guest package must not render a healthy rootfs as absent`);
    assert.equal(flow.runtimeProjection.statusRows[0].ready, true);
    assert.equal(flow.runtimeProjection.health, "ready");
  }

  // An installed-but-unhealthy rootfs is an error, never an Install trigger or false absence.
  {
    const flow = await productionCheckAndScreen(target, alias, { rootfsState: "login-failed" });
    assert.equal(flow.readiness.status, "error");
    assert.equal(flow.readiness.rootfsState.installed, true);
    assert.deepEqual(flow.activeRootfs, { installed: true, healthy: false });
    assert.equal(flow.runtimeProjection.health, "login-unverified");
    assert.equal(flow.installButtonVisible, true, `${target}: installed-but-unhealthy shows Prepare, but fresh preflight must block mutation`);
  }
  for (const state of ["wrong-id", "incomplete", "corrupt-list"]) {
    const flow = await productionCheckAndScreen(target, alias, { rootfsState: state });
    assert.equal(flow.readiness.status, "error", `${target}/${state} is unverified`);
    assert.equal(flow.installButtonVisible, true, `${target}/${state}: error shows safe Prepare, not confirmed absence`);
  }
  for (const config of [
    { hostThrow: "RUN_COMMAND_PERMISSION_MISSING" },
    { hostExtra: { timedOut: true } },
    { hostExtra: { outputTruncated: true } },
    { hostExtra: { stdout: "unframed" } },
    { rootfsExtra: { timedOut: true } },
    { rootfsExtra: { outputTruncated: true } },
    { packageStates: { git: "permission" } },
    { packageStates: { wget: "throw" } },
    { packageStates: { curl: "timeout" } },
    { packageStates: { "zip-unzip": "truncated" } },
  ]) {
    const flow = await productionCheckAndScreen(target, alias, config);
    assert.equal(flow.readiness.status, "error", `${target}: inconclusive result ${JSON.stringify(config)} must remain error`);
    assert.equal(flow.installButtonVisible, true, `${target}: error/unknown exposes only a fresh-preflight Prepare action`);
  }
}

// Stale results from the sibling alias cannot enable Install or leak into the selected-only row.
{
  const stale = { target: "ubuntu-proot", status: "missing", rootfs: "missing", rootfsState: null };
  const selectedTarget = "ubuntu-proot";
  const selected = stale.target === selectedTarget ? stale : null;
  const rootfs = projectProotRootfsReadiness(selected);
  const projection = projectRuntimeEnvironment(selectedTarget, { debian: rootfs });
  assert.equal(canOfferRuntimeInstall(selectedTarget, selected), false);
  assert.equal(canOfferRuntimePreparationAction(selectedTarget, selected), true,
    "unknown selected runtime keeps a fresh-preflight Prepare action even if sibling state is stale");
  assert.equal(rootfs, null);
  assert.deepEqual(projection.statusRows.map((row) => row.id), ["debian-rootfs"]);
  assert.equal(projection.statusRows[0].ready, null);
}
assert.equal(canOfferRuntimeInstall("termux", { target: "termux", status: "missing" }), false);
assert.throws(() => buildProotDistroProbeCommand("kali"), /PROOT_DISTRO_ALIAS_NOT_ALLOWED/);
assert.throws(() => buildProotAptFallbackInstallCommand("kali", ["curl"]), /PROOT_DISTRO_ALIAS_NOT_ALLOWED/);
for (const { target } of targets) {
  assert.equal(packageBackendTarget(target, "proot-distro"), "termux");
  assert.equal(packageBackendTarget(target, `${target === "ubuntu-proot" ? "ubuntu" : "debian"}-rootfs`), "termux");
  assert.equal(packageBackendTarget(target, "curl"), "linux");
}

// End-to-end mock preparation for each selected OS, including the real guarded host/rootfs bootstrap helper.
async function runPreparation(target, { missingId = "curl", updateClass = "success" } = {}) {
  const alias = target === "ubuntu-proot" ? "ubuntu" : "debian";
  let guestInstalled = false;
  const calls = [];
  const run = async (command, options) => {
    calls.push({ command, options });
    if (options.packageId === "proot-distro" && options.kind === "check") return hostResult("AVAILABLE");
    if (options.packageId === `${alias}-rootfs` && options.kind === "install") {
      return { exitCode: 0, stdout: `AIB_${alias.toUpperCase()}_ROOTFS_OK\n${alias.toUpperCase()}_ROOTFS_OK\n${alias.toUpperCase()}_INSTALL_OK`, stderr: "" };
    }
    if (PROOT_RUNTIME_REQUIREMENTS.some((item) => item.id === options.packageId) && options.kind === "check") {
      return { exitCode: guestInstalled || options.packageId !== missingId ? 0 : 1, stdout: "", stderr: "" };
    }
    if (options.packageId === "runtime-guest-requirements" && options.kind === "update") {
      return { exitCode: updateClass === "success" ? 0 : 100, stdout: `AIB_APT_SOURCE_UPDATE_CLASS:${updateClass}`, stderr: "" };
    }
    if (options.packageId === "runtime-guest-requirements" && options.kind === "install") {
      if (command.includes("AIB_APT_FALLBACK_RESULT")) {
        guestInstalled = true;
        return { exitCode: 0, stdout: "AIB_APT_FALLBACK_RESULT:installed", stderr: "" };
      }
      guestInstalled = true;
      return { exitCode: 0, stdout: "AIB_APT_GUEST_INSTALL_CLASS:success", stderr: "" };
    }
    throw new Error(`Unexpected mock command category: ${options.kind}/${options.packageId}`);
  };
  const result = await prepareProotRuntimeEnvironment(target, {
    run,
    ensureRootfs: (aliasArg, stageRun, onProgress, shouldAbort) =>
      installProotDistroRootfsWithPrerequisite(aliasArg, stageRun, onProgress, shouldAbort),
  });
  return { result, calls, guestInstalled, alias };
}
for (const { target, alias } of targets) {
  const prepared = await runPreparation(target);
  assert.equal(prepared.result.ok, true, `${target} mock install chain succeeds`);
  assert.equal(prepared.result.alias, alias);
  assert.deepEqual(prepared.result.installed, ["curl"]);
  assert.equal(prepared.guestInstalled, true);
  assert.equal(prepared.calls.filter(({ options }) => options.packageId === `${alias}-rootfs`).length, 1);
  assert.equal(prepared.calls.filter(({ options }) => options.packageId === "runtime-guest-requirements" && options.kind === "update").length, 1);

  // The final read-only production Check confirms ready and removes Install after preparation.
  const after = await productionCheckAndScreen(target, alias);
  assert.equal(after.readiness.status, "ready");
  assert.equal(after.installButtonVisible, false);
}

// Transport gets one bounded official fallback; signature failure fails closed before fallback/install.
{
  const prepared = await runPreparation("ubuntu-proot", { updateClass: "transport" });
  assert.equal(prepared.result.ok, true);
  assert.equal(prepared.calls.filter(({ options }) => options.packageId === "runtime-guest-requirements" && options.kind === "install").length, 1);
  assert.match(prepared.calls.find(({ options }) => options.kind === "install" && options.packageId === "runtime-guest-requirements").command,
    /AIB_APT_FALLBACK_RESULT/);
}
{
  const prepared = await runPreparation("ubuntu-proot", { updateClass: "signature" });
  assert.equal(prepared.result.ok, false);
  assert.equal(prepared.result.stage, "guest-index-update");
  assert.equal(prepared.calls.filter(({ options }) => options.packageId === "runtime-guest-requirements" && options.kind === "install").length, 0);
  const errorState = {
    target: "ubuntu-proot", status: "error", rootfs: "unknown", rootfsState: null,
  };
  assert.equal(canOfferRuntimeInstall("ubuntu-proot", errorState), false);
  assert.deepEqual(projectProotRootfsReadiness(errorState), { installed: null, healthy: false });
}

console.log("AIB_V276_RUNTIME_CHAIN_E2E_SELFTEST_OK check-to-button=ubuntu,debian host/rootfs/baseline-matrix=PASS rootfs-only-projection=PASS install-chain/fallback/signature=PASS stale-target/permission/timeout/truncation/alias=PASS");
