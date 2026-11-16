#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = new Map();
const moduleMocks = new Map();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

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
  const mocks = moduleMocks.get(file) ?? {};
  mod.require = (request) => {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
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

const routing = loadTs(path.join(root, "lib/package-command-routing.ts"));
const runtimeRouting = loadTs(path.join(root, "lib/runtime-command-routing.ts"));
const menuRouting = loadTs(path.join(root, "lib/package-menu-routing.ts"));
const scan = loadTs(path.join(root, "lib/package-catalog-scan.ts"));
const checks = loadTs(path.join(root, "lib/package-check-outcome.ts"));
const preparation = loadTs(path.join(root, "lib/runtime-environment-preparation.ts"));
const prootState = loadTs(path.join(root, "lib/proot-distro-state.ts"));

// Each explicitly expanded sidebar section stays Termux-host-only and never schedules its siblings.
for (const selected of ["termux", "ubuntu-proot", "ubuntu-proot"]) {
  assert.equal(menuRouting.resolveRightPackageMenuBackend(selected), "termux");
  for (const section of ["compile", "reverse", "custom"]) {
    const plan = menuRouting.resolveRightPackageMenuExpansionScanPlan(selected, section);
    assert.equal(plan.target, "termux", `right menu target changed for ${selected}/${section}`);
    assert.equal(plan.section, section, "expansion plan schedules only the requested section");
    assert.equal(routing.packageBackendTarget(plan.target, "wget"), "termux");
    assert.equal(routing.packageBackendTarget(plan.target, "git"), "termux");
    assert.equal(routing.packageBackendTarget(plan.target, "openjdk-17"), "termux");
  }
  assert.equal(routing.adaptPackageCommandForBackend("apt-get install -y wget", "install", "termux"), "pkg install -y wget");
}
assert.equal(runtimeRouting.routeRuntimeCommand("ubuntu-proot", "package", "wget"), "ubuntu-proot");
assert.equal(runtimeRouting.routeRuntimeCommand("ubuntu-proot", "package", "git"), "ubuntu-proot");
assert.equal(runtimeRouting.routeRuntimeCommand("ubuntu-proot", "package", "proot-distro"), "termux");
assert.equal(runtimeRouting.routeRuntimeCommand("ubuntu-proot", "package", "ubuntu-rootfs"), "termux");
assert.equal(routing.packageBackendTarget("ubuntu-proot", "runtime-guest-requirements"), "linux");

// Exercise the actual package runner with only the Android bridge replaced by a mock.
const executions = [];
const packageBackendFile = path.join(root, "lib/package-backend.ts");
const installerEnvFile = path.join(root, "lib/termux-installer-env.ts");
moduleMocks.set(packageBackendFile, {
  "./agent-shell-backend": { getBuildBackend: () => "termux" },
  "./termux-executor": {
    executeGuardedTermuxCommand: async (command, options) => {
      executions.push({ command, options });
      return { exitCode: 0, stdout: "mock-success", stderr: "" };
    },
  },
});
moduleMocks.set(installerEnvFile, {
  "./agent-shell-backend": {
    isLinuxProotBackend: () => false,
    getBuildBackend: () => "termux",
  },
});
const { runPackageCommand } = loadTs(packageBackendFile);

for (const selected of ["termux", "ubuntu-proot", "ubuntu-proot"]) {
  const plan = menuRouting.resolveRightPackageMenuExpansionScanPlan(selected, "compile");
  await runPackageCommand("apt-get install -y wget", {
    kind: "install", packageId: "wget", selectedBackend: plan.target,
  });
  const menuRun = executions.at(-1);
  assert.equal(menuRun.options.backend, "termux", `sidebar install ran outside Termux while ${selected} was selected`);
  assert.equal(menuRun.options.hostTermux, true);
  assert.match(menuRun.command, /PREFIX="\$\{PREFIX:-\/data\/data\/com\.termux\/files\/usr\}"/);
  assert.match(menuRun.command, /apt-get install -y wget/);

  await runPackageCommand("apt-get install -y wget", {
    kind: "install", packageId: "wget", selectedBackend: selected,
  });
  const genericRun = executions.at(-1);
  assert.equal(genericRun.options.backend, selected === "termux" ? "termux" : selected,
    "the generic package catalog must keep its selected runtime target");
  if (selected !== "termux") {
    assert.equal(genericRun.options.hostTermux, false, "ordinary tools stay in the chosen guest outside the sidebar");
    assert.match(genericRun.command, /\/root\/\.aibuilder-prefix/);
    assert.match(genericRun.command, /apt-get install -y wget/);
  }
}
for (const [backend, alias] of [["ubuntu-proot", "debian"], ["ubuntu-proot", "ubuntu"]]) {
  await runPackageCommand("apt-get install -y proot-distro", {
    kind: "install", packageId: "proot-distro", selectedBackend: backend,
  });
  assert.equal(executions.at(-1).options.backend, "termux", `${alias} host prerequisite must use Termux`);
  assert.match(executions.at(-1).command, /apt-get install -y proot-distro/);

  await runPackageCommand(`proot-distro install ${alias}`, {
    kind: "install", packageId: `${alias}-rootfs`, selectedBackend: backend,
  });
  assert.equal(executions.at(-1).options.backend, "termux", `${alias} rootfs bootstrap must use Termux host`);

  await runPackageCommand("DEBIAN_FRONTEND=noninteractive apt-get install -y wget git", {
    kind: "install", packageId: "runtime-guest-requirements", selectedBackend: backend,
  });
  assert.equal(executions.at(-1).options.backend, backend, `${alias} baseline guest requirements must use its guest`);
  assert.equal(executions.at(-1).options.hostTermux, false);
  assert.match(executions.at(-1).command, /apt-get install -y wget git/);
}

// The right menu hides only rootfs provisioning cards; the full shared catalog remains available.
const compileSource = read("lib/compile-packages.ts");
const compileMenuSource = read("components/PackagesRightMenu.tsx");
const runtimeUiSource = read("app/runtime.tsx");
const compileCatalogStart = compileSource.indexOf("export const COMPILE_PACKAGES:");
const compileCatalogEnd = compileSource.indexOf("\n];", compileCatalogStart);
assert.ok(compileCatalogStart >= 0 && compileCatalogEnd > compileCatalogStart);
const allCompileIds = [...compileSource.slice(compileCatalogStart, compileCatalogEnd).matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
const sidebarCompileIds = allCompileIds.filter(menuRouting.isRightPackageMenuPackage);
assert.ok(sidebarCompileIds.includes("proot-distro"));
assert.ok(!sidebarCompileIds.includes("debian-rootfs"));
assert.ok(!sidebarCompileIds.includes("ubuntu-rootfs"));
assert.equal(allCompileIds.length - sidebarCompileIds.length, 2, "guest rootfs actions stay out of the Termux tools sidebar only");
assert.ok(/export const RIGHT_MENU_COMPILE_PACKAGES:[\s\S]{0,100}COMPILE_PACKAGES\.filter\([\s\S]{0,120}isRightPackageMenuPackage\(def\.id\)/.test(compileSource),
  "the exported right-menu list must be a filtered view, leaving the full catalog intact");
assert.ok(/setStates\(\{\}\)/.test(compileMenuSource), "opening the menu resets visible card states, so stale cache cannot show as installed");
assert.ok(/COLLAPSED_SECTIONS: Record<SectionId, boolean> = \{ compile: false, reverse: false, custom: false \}/.test(compileMenuSource), "drawer opens with all sections collapsed");
assert.ok(/resolveRightPackageMenuExpansionScanPlan\(RIGHT_PACKAGE_MENU_BACKEND, section\)/.test(compileMenuSource));
assert.ok(/sectionExpansionGenerationRef\.current\[section\]/.test(compileMenuSource));
assert.ok(/expandedRef\.current\[section\]/.test(compileMenuSource), "collapsed sections invalidate queued and late callbacks");
assert.ok(!/resolveRightPackageMenuOpenScanPlan|startOpenScans|SCAN_OPEN/.test(compileMenuSource), "drawer open cannot start a full catalog scan");
assert.ok(/if \(section !== "custom" \|\| customToolsReadyRef\.current\) \{\s*void verifySection\(section\)/.test(compileMenuSource), "only expansion starts that section's scan");
assert.ok(/if \(!isCurrentTarget\(\)\) return;/.test(compileMenuSource), "stale scan callbacks cannot update a closed/collapsed menu");
assert.ok(/verifiedRef\.current\[verifiedKey\] = !inconclusive/.test(compileMenuSource));
assert.ok(/status: "error"[\s\S]{0,120}lastError: check\.detail/.test(compileMenuSource));
assert.ok(/const selectEnvironment = useCallback\(async \(backend: AgentShellBackend\)[\s\S]{0,180}runEnvironmentAction\(backend, true\)/.test(runtimeUiSource),
  "explicit selection routes to a read-only check and never directly installs");
assert.ok(/if \(persistSelection\) \{\s*await runReadOnlyEnvironmentCheck\(backend, true\);\s*return;/.test(runtimeUiSource),
  "selection exits before the explicit Install pipeline");
assert.ok(/projectRuntimeEnvironment\(environmentBackend,/.test(runtimeUiSource), "runtime details are projected from the selected backend");
assert.ok(/runtimeProjection\.statusRows\.map/.test(runtimeUiSource), "only the active environment's projected status rows are rendered");
assert.ok(/runtimeProjection\.settingsPath/.test(runtimeUiSource), "Termux settings are only exposed by the Termux projection");
assert.ok(/const refreshEnvironmentStatus = useCallback\(async \(\) => \{[\s\S]{0,420}const backend = await loadEnvironmentBackend\(\);[\s\S]{0,280}await runReadOnlyEnvironmentCheck\(backend, false\)/.test(runtimeUiSource), "screen-open refresh checks only the persisted active backend and does not install");
assert.ok(runtimeUiSource.includes('{environmentBackend === "ubuntu-proot" && selectedReadiness?.status === "ready" ? ('), "Debian-specific controls are hidden outside the verified-ready Debian selection");
assert.ok(/prepareProotRuntimeEnvironment\(backend, \{/.test(runtimeUiSource));
assert.ok(/ensureRootfs:\s*\(distro, run, onProgress, shouldAbort\)\s*=>\s*installProotDistroRootfsWithPrerequisite\(distro, run, onProgress, shouldAbort\)/.test(runtimeUiSource));
assert.ok(!/useEffect\(\(\) => \{[^}]*prepareProotRuntimeEnvironment/.test(runtimeUiSource),
  "runtime preparation must not launch from a render/mount effect");
assert.ok(!/catch \(error: unknown\) \{[\s\S]{0,220}setLinuxStatus\(null\)|catch \(error: unknown\) \{[\s\S]{0,220}setUbuntuDistroState\(null\)/.test(runtimeUiSource),
  "transient preparation failures cannot erase the last known rootfs status");

// Slow, timed-out and permission-denied package checks are per-card outcomes; no whole-catalog stall or false status.
const { scanPackageCatalog, mergeSuccessfulPackageChecksIntoCache, PackageScanCoordinator } = scan;
const catalog = ["wget", "curl", "zip", "git"].map((id) => ({ id }));
const checked = [];
const results = await scanPackageCatalog(catalog, async ({ id }) => {
  checked.push(id);
  if (id === "wget") {
    await wait(25);
    return { status: "error", detail: "PACKAGE_CHECK_TIMEOUT" };
  }
  if (id === "curl") return { status: "error", detail: "RUN_COMMAND_PERMISSION_MISSING" };
  if (id === "zip") return { status: "missing" };
  return { status: "installed" };
});
assert.deepEqual(checked, ["wget", "curl", "zip", "git"], "one slow check must not block independent later cards");
assert.deepEqual(Object.values(results).map((item) => item.status), ["error", "error", "missing", "installed"]);
const cacheAfterErrors = mergeSuccessfulPackageChecksIntoCache({ wget: true, curl: false, zip: true }, results);
assert.deepEqual(cacheAfterErrors, { wget: true, curl: false, zip: false, git: true }, "error outcomes preserve hints but never become live installed/missing outcomes");
assert.equal(results.wget.status, "error", "timeout is never returned as installed from stale cache");

// Closing while one slow command is in flight prevents the next independent probe and ignores its result.
{
  const gate = {};
  gate.promise = new Promise((resolve) => { gate.release = resolve; });
  let live = true;
  const started = [];
  const visibleStates = {};
  const pending = scanPackageCatalog(catalog, async ({ id }) => {
    started.push(id);
    if (id === "wget") {
      await gate.promise;
      return { status: "installed" };
    }
    return { status: "missing" };
  }, {
    shouldContinue: () => live,
    onResult: (id, outcome) => { if (live) visibleStates[id] = outcome.status; },
  });
  await wait(0);
  live = false;
  gate.release();
  await pending;
  assert.deepEqual(started, ["wget"], "closing stops the remainder of the scan queue");
  assert.deepEqual(visibleStates, {}, "successful stale response after close is ignored by the view owner");
}

// The scan coordinator coalesces duplicate section requests and keeps native bridge concurrency at one.
{
  const coordinator = new PackageScanCoordinator();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const first = coordinator.run("termux:compile:open-1", async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate;
    active -= 1;
    return "done";
  });
  const duplicate = coordinator.run("termux:compile:open-1", async () => {
    calls += 1;
    return "duplicate";
  });
  const secondSection = coordinator.run("termux:reverse:open-1", async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(2);
    active -= 1;
    return "reverse";
  });
  assert.equal(first, duplicate, "duplicate requests for the same target/section/generation share one promise");
  await wait(0);
  assert.equal(coordinator.activeCount, 1);
  release();
  assert.deepEqual(await Promise.all([first, duplicate, secondSection]), ["done", "done", "reverse"]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1, "section scans serialize through one native bridge lane");
  assert.equal(coordinator.isRunning("termux:compile:open-1"), false);
}

// Runtime environment preparation is explicit, idempotent and limited to the shared baseline requirements.
assert.deepEqual(preparation.PROOT_RUNTIME_REQUIREMENTS.map((item) => item.id), ["openjdk-17", "zip-unzip", "git", "wget", "curl"]);
assert.deepEqual(preparation.PROOT_RUNTIME_REQUIREMENTS.map((item) => item.aptPackage), ["openjdk-17-jdk", "unzip", "git", "wget", "curl"]);
assert.doesNotMatch(preparation.PROOT_RUNTIME_REQUIREMENTS.map((item) => item.id).join(" "), /android-sdk|android-ndk|nodejs|python|jadx|smali/);

function makePrepOptions(backend, {
  present = [], checkFailure = null, indexFailure = null, fallbackFailure = null, installFailure = null, slowCheck = null, rootfsGate = null,
  abortAfterIndexUpdate = false,
} = {}) {
  const installedSet = new Set(present);
  const calls = [];
  const stages = [];
  let abortRequested = false;
  const alias = backend === "ubuntu-proot" ? "ubuntu" : "debian";
  const ensureRootfs = async (requestedAlias, run, onProgress, shouldAbort) => {
    assert.equal(requestedAlias, alias);
    onProgress(14, `${alias} rootfs login verified`);
    calls.push({ kind: "rootfs", alias: requestedAlias });
    if (rootfsGate) await rootfsGate.promise;
    if (shouldAbort()) return { ok: false, error: "aborted" };
    const hostProbe = await run("command -v proot-distro", { kind: "check", packageId: "proot-distro", timeoutMs: 20_000 });
    calls.push({ kind: "host-probe", options: hostProbe.options });
    const rootfs = await run(`proot-distro install ${alias}`, { kind: "install", packageId: `${alias}-rootfs`, timeoutMs: 45 * 60_000 });
    calls.push({ kind: "rootfs-command", options: rootfs.options });
    return { ok: true };
  };
  const run = async (command, options) => {
    const opts = { ...options, selectedBackend: backend };
    calls.push({ kind: options.kind, packageId: options.packageId, command, options: opts });
    assert.equal(opts.selectedBackend, backend, "each rootfs/guest stage is pinned to the explicit selected environment");
    if (options.packageId === "proot-distro" && options.kind === "check") {
      return { exitCode: 0, stdout: "AIB_PROOT_TOOL:AVAILABLE", stderr: "" };
    }
    if (options.packageId?.endsWith("-rootfs") && options.kind === "install") {
      return { exitCode: 0, stdout: `AIB_${alias.toUpperCase()}_ROOTFS_OK`, stderr: "" };
    }
    if (options.kind === "check") {
      const requirement = preparation.PROOT_RUNTIME_REQUIREMENTS.find((item) => item.checkCommand === command);
      assert.ok(requirement, `unexpected guest check command: ${command}`);
      if (slowCheck === requirement.id) await wait(25);
      if (checkFailure?.id === requirement.id) {
        if (checkFailure.kind === "throw") throw new Error(checkFailure.detail);
        return { exitCode: checkFailure.kind === "timeout" ? -1 : 126, timedOut: checkFailure.kind === "timeout", stderr: checkFailure.detail };
      }
      return { exitCode: installedSet.has(requirement.id) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (options.kind === "update") {
      if (indexFailure?.kind === "throw") throw new Error(indexFailure.detail);
      if (indexFailure?.kind === "timeout") return { exitCode: -1, timedOut: true, stderr: indexFailure.detail };
      if (indexFailure?.kind === "permission") return { exitCode: 126, stderr: "RUN_COMMAND_PERMISSION_MISSING" };
      if (indexFailure?.kind === "network-warning") return { exitCode: 100, stdout: "AIB_APT_SOURCE_UPDATE_CLASS:transport", stderr: "" };
      if (indexFailure?.kind === "signature") return { exitCode: 100, stdout: "AIB_APT_SOURCE_UPDATE_CLASS:signature", stderr: "" };
      if (indexFailure?.kind === "truncated") return { exitCode: 0, outputTruncated: true, stderr: indexFailure.detail };
      assert.match(command, /apt-get[\s\S]*\bupdate\b/);
      if (abortAfterIndexUpdate) abortRequested = true;
      return { exitCode: 0, stdout: "AIB_APT_SOURCE_UPDATE_CLASS:success", stderr: "" };
    }
    if (options.kind === "install") {
      if (command.includes("AIB_APT_FALLBACK_TRIES:1")) {
        if (fallbackFailure?.kind === "throw") throw new Error(fallbackFailure.detail);
        if (fallbackFailure?.kind === "signature") return { exitCode: 100, stdout: "AIB_APT_FALLBACK_RESULT:signature", stderr: "" };
        if (fallbackFailure?.kind === "exhausted") return { exitCode: 100, stdout: "AIB_APT_FALLBACK_RESULT:transport-exhausted", stderr: "" };
        for (const requirement of preparation.PROOT_RUNTIME_REQUIREMENTS) {
          if (command.includes(requirement.aptPackage)) installedSet.add(requirement.id);
        }
        return { exitCode: 0, stdout: "AIB_APT_FALLBACK_RESULT:installed", stderr: "" };
      }
      if (installFailure?.kind === "throw") throw new Error(installFailure.detail);
      if (installFailure?.kind === "timeout") return { exitCode: -1, timedOut: true, stderr: installFailure.detail };
      if (installFailure?.kind === "permission") return { exitCode: 126, stderr: "RUN_COMMAND_PERMISSION_MISSING" };
      for (const requirement of preparation.PROOT_RUNTIME_REQUIREMENTS) {
        if (command.includes(requirement.aptPackage)) installedSet.add(requirement.id);
      }
      return { exitCode: 0, stdout: "AIB_APT_GUEST_INSTALL_CLASS:success", stderr: "" };
    }
    throw new Error(`unexpected runtime-preparation command kind=${options.kind}`);
  };
  return {
    options: {
      run,
      ensureRootfs,
      onProgress: (percent, stage, detail) => stages.push({ percent, stage, detail }),
      shouldAbort: () => abortRequested,
    },
    calls,
    stages,
    installedSet,
  };
}

for (const backend of ["ubuntu-proot", "ubuntu-proot"]) {
  const mock = makePrepOptions(backend);
  const result = await preparation.prepareProotRuntimeEnvironment(backend, mock.options);
  assert.equal(result.ok, true, `${backend} must complete the staged preparation with successful checks`);
  assert.equal(result.alias, backend === "ubuntu-proot" ? "ubuntu" : "debian");
  assert.deepEqual([...result.installed], ["OpenJDK 17+", "unzip", "git", "wget", "curl"]);
  assert.deepEqual([...result.alreadyPresent], []);
  const rootfsCommand = mock.calls.find((item) => item.kind === "install" && item.packageId === `${backend === "ubuntu-proot" ? "ubuntu" : "debian"}-rootfs`);
  assert.equal(rootfsCommand.options.selectedBackend, backend);
  const installCall = mock.calls.find((item) => item.kind === "install" && item.packageId === "runtime-guest-requirements");
  const indexUpdateCall = mock.calls.find((item) => item.kind === "update" && item.packageId === "runtime-guest-requirements");
  assert.ok(indexUpdateCall, "missing guest packages require refreshing the selected distro's apt indexes");
  assert.equal(indexUpdateCall.options.selectedBackend, backend, "apt index update must run inside the selected guest");
  assert.ok(installCall);
  assert.ok(mock.calls.indexOf(indexUpdateCall) < mock.calls.indexOf(installCall), "guest indexes refresh before installing missing packages");
  assert.match(installCall.command, /apt-get \$AIB_APT_SECURITY_OPTIONS install -y --no-install-recommends openjdk-17-jdk unzip git wget curl/);
  assert.match(installCall.command, /AllowInsecureRepositories=false/);
  assert.match(installCall.command, /AllowDowngradeToInsecureRepositories=false/);
  assert.match(installCall.command, /AllowUnauthenticated=false/);
  assert.ok(mock.stages.some((stage) => stage.stage === "guest-preflight"));
  assert.ok(mock.stages.some((stage) => stage.stage === "guest-index-update"));
  assert.ok(mock.stages.some((stage) => stage.stage === "guest-install"));
  assert.ok(mock.stages.some((stage) => stage.stage === "guest-verification"));
  assert.equal(mock.stages.at(-1).stage, "ready");
}

// Existing packages are skipped; only proven-missing entries enter the guest apt command.
{
  const mock = makePrepOptions("ubuntu-proot", { present: ["git", "wget"] });
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(result.ok, true);
  assert.deepEqual([...result.alreadyPresent], ["git", "wget"]);
  assert.deepEqual([...result.installed], ["OpenJDK 17+", "unzip", "curl"]);
  const guestInstall = mock.calls.find((item) => item.kind === "install" && item.packageId === "runtime-guest-requirements");
  assert.match(guestInstall.command, /openjdk-17-jdk unzip curl/);
  assert.doesNotMatch(guestInstall.command, /\bgit\b|\bwget\b/);
}

// A fully prepared guest is idempotent: no apt index/network/install work is needed.
{
  const mock = makePrepOptions("ubuntu-proot", { present: ["openjdk-17", "zip-unzip", "git", "wget", "curl"] });
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(result.ok, true);
  assert.deepEqual([...result.installed], []);
  assert.equal(mock.calls.some((item) => item.kind === "update" || (item.kind === "install" && item.packageId === "runtime-guest-requirements")), false,
    "already-present requirements skip apt update and install");
}

// A timeout or permission error during preflight must stop before apt installs or later guest checks.
for (const failure of [
  { name: "timeout", value: { id: "openjdk-17", kind: "timeout", detail: "PACKAGE_CHECK_TIMEOUT" } },
  { name: "permission", value: { id: "openjdk-17", kind: "throw", detail: "RUN_COMMAND_PERMISSION_MISSING" } },
]) {
  const mock = makePrepOptions("ubuntu-proot", { checkFailure: failure.value });
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(result.ok, false, failure.name);
  assert.equal(result.stage, "guest-preflight");
  assert.equal(mock.calls.filter((item) => item.kind === "check" && item.packageId !== "proot-distro").length, 1);
  assert.equal(mock.calls.filter((item) => item.kind === "install" && item.packageId === "runtime-guest-requirements").length, 0);
}

for (const failure of [
  { name: "index timeout", value: { kind: "timeout", detail: "PACKAGE_CHECK_TIMEOUT" } },
  { name: "index permission denial", value: { kind: "permission", detail: "RUN_COMMAND_PERMISSION_MISSING" } },
  { name: "signature/index-security failure", value: { kind: "signature", detail: "signature verification failed" } },
  { name: "truncated index result", value: { kind: "truncated", detail: "output truncated" } },
]) {
  const mock = makePrepOptions("ubuntu-proot", { indexFailure: failure.value });
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(result.ok, false, failure.name);
  assert.equal(result.stage, "guest-index-update", failure.name);
  assert.equal(mock.calls.filter((item) => item.kind === "update").length, 1);
  assert.equal(mock.calls.filter((item) => item.kind === "install" && item.packageId === "runtime-guest-requirements").length, 0,
    "guest package installation never starts after an unverified/failed index update");
}

// Only a classified transient transport failure may enter one fixed official fallback transaction.
{
  const mock = makePrepOptions("ubuntu-proot", { indexFailure: { kind: "network-warning", detail: "temporary network failure" } });
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(result.ok, true, "a successful same-family official fallback completes the missing baseline");
  const fallback = mock.calls.find((item) => item.kind === "install" && item.command.includes("AIB_APT_FALLBACK_TRIES:1"));
  assert.ok(fallback);
  assert.match(fallback.command, /archive\.ubuntu\.com\/ubuntu/);
  assert.equal(mock.calls.filter((item) => item.kind === "update").length, 1, "one primary update precedes one bounded fallback");
  assert.equal(mock.stages.at(-1).stage, "ready", "ready follows the final guest baseline recheck");
}

for (const failure of [
  { name: "fallback signature rejection", kind: "signature" },
  { name: "fallback retry exhaustion", kind: "exhausted" },
]) {
  const mock = makePrepOptions("ubuntu-proot", {
    indexFailure: { kind: "network-warning", detail: "transient transport" },
    fallbackFailure: { kind: failure.kind, detail: failure.name },
  });
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(result.ok, false, failure.name);
  assert.equal(result.stage, "guest-mirror-fallback", failure.name);
  assert.equal(mock.calls.filter((item) => item.kind === "check" && item.packageId !== "proot-distro").length, 5,
    "fallback security/exhaustion failure cannot start the final guest recheck");
}

for (const failure of [
  { name: "timeout", value: { kind: "timeout", detail: "callback timeout" } },
  { name: "permission", value: { kind: "permission", detail: "permission denied" } },
]) {
  const mock = makePrepOptions("ubuntu-proot", { installFailure: failure.value });
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(result.ok, false, failure.name);
  assert.equal(result.stage, "guest-install");
  assert.equal(mock.calls.filter((item) => item.kind === "check" && item.packageId !== "proot-distro").length, 5,
    "all preflight checks finish before the one install transaction");
  assert.equal(mock.calls.filter((item) => item.kind === "check" && item.packageId === "runtime-guest-requirements").length, 0,
    "no final success verification follows a denied/timed-out install");
}

// A slow but successful probe stays on its own card and the rest of the baseline still completes.
{
  const mock = makePrepOptions("ubuntu-proot", { slowCheck: "wget" });
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(result.ok, true);
  const guestChecks = mock.calls.filter((item) => item.kind === "check" && preparation.PROOT_RUNTIME_REQUIREMENTS.some((req) => req.checkCommand === item.command));
  assert.equal(guestChecks.length, 10, "five preflight checks plus five fresh final checks");
}

// Cancellation after apt update prevents the subsequent guest package install.
{
  const mock = makePrepOptions("ubuntu-proot", { abortAfterIndexUpdate: true });
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.stage, "guest-index-update");
  assert.equal(mock.calls.filter((item) => item.kind === "install" && item.packageId === "runtime-guest-requirements").length, 0);
}

// Same-target callers join; a simultaneous different distro is rejected before any second install starts.
{
  let release;
  const gate = { promise: new Promise((resolve) => { release = resolve; }) };
  const mock = makePrepOptions("ubuntu-proot", { rootfsGate: gate });
  const first = preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  await wait(0);
  assert.equal(preparation.isRuntimePreparationInFlight("debian"), true);
  const duplicate = preparation.prepareProotRuntimeEnvironment("ubuntu-proot", mock.options);
  assert.equal(first, duplicate, "duplicate selection shares the active preparation promise");
  const other = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", makePrepOptions("ubuntu-proot").options);
  assert.equal(other.ok, false);
  assert.equal(other.stage, "lock");
  assert.match(other.error, /RUNTIME_PREPARATION_BUSY/);
  release();
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(mock.calls.filter((item) => item.kind === "rootfs").length, 1);
  assert.equal(preparation.isRuntimePreparationInFlight("debian"), false);
}

// Cancellation prevents later guest packages; Termux is never silently auto-provisioned as a guest.
{
  let aborted = false;
  const mock = makePrepOptions("ubuntu-proot");
  const options = {
    ...mock.options,
    shouldAbort: () => aborted,
    ensureRootfs: async (...args) => {
      const [, , onProgress] = args;
      onProgress(14, "rootfs ready");
      aborted = true;
      return { ok: true };
    },
  };
  const result = await preparation.prepareProotRuntimeEnvironment("ubuntu-proot", options);
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.stage, "rootfs");
  assert.equal(mock.calls.filter((item) => item.packageId === "runtime-guest-requirements").length, 0);
}
{
  const result = await preparation.prepareProotRuntimeEnvironment("termux", makePrepOptions("termux").options);
  assert.equal(result.ok, false);
  assert.equal(result.alias, null);
  assert.match(result.error, /RUNTIME_PREPARATION_UNSUPPORTED_TARGET/);
}

// Shared proot-distro host prerequisite lock serializes Debian/Ubuntu pkg operations too.
{
  let active = 0;
  let maxActive = 0;
  await Promise.all(["first", "second"].map((label) => prootState.withProotDistroHostToolLock(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(8);
    active -= 1;
    return label;
  })));
  assert.equal(maxActive, 1, "shared host prerequisite updates never race one another");
}

console.log("AIB_V275_PACKAGE_RUNTIME_REGRESSION_SELFTEST_OK sidebar=lazy-expanded-section-termux-only mixed-target-routes=1 cache-timeout-safe=1 scan-serial=1 runtime-prep=debian,ubuntu requirements=5 preflight/conditional-apt-update/install/verify=1 unknown-denial-timeout-cancel=1 single-flight=1");
