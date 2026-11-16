#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
const { runProotRuntimePreparationAction } = loadTs(path.join(root, "lib/runtime-environment-action.ts"));
const { canOfferRuntimePreparationAction } = loadTs(path.join(root, "lib/runtime-environment-projection.ts"));
const { prepareProotRuntimeEnvironment, PROOT_RUNTIME_REQUIREMENTS } = loadTs(path.join(root, "lib/runtime-environment-preparation.ts"));
const { installProotDistroRootfsWithPrerequisite } = loadTs(path.join(root, "lib/proot-distro-bootstrap.ts"));
const {
  buildProotDistroInstallCommand,
  buildProotDistroProbeCommand,
  normalizeProotArchitecture,
  parseProotDistroProbe,
} = loadTs(path.join(root, "lib/proot-distro-state.ts"));
const { buildProotDistroRootfsCheckCommand, buildProotDistroRootfsInstallCommand } = loadTs(path.join(root, "lib/termux-bootstrap-install.ts"));
const { packageBackendTarget } = loadTs(path.join(root, "lib/package-command-routing.ts"));

const targets = [
  { backend: "ubuntu-proot", alias: "ubuntu", label: "Ubuntu" },
  { backend: "ubuntu-proot", alias: "debian", label: "Debian" },
];
const work = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v277-runtime-action-"));
const hostMachine = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
const otherMachine = hostMachine === "x86_64" ? "aarch64" : "x86_64";

const mockCli = `#!/bin/sh
set +e
cmd="$1"
shift
alias="${"$1"}"
printf '%s %s\\n' "$cmd" "$alias" >> "$MOCK_CALLS"
case "$cmd" in
  list)
    if [ "${"${MOCK_LIST_MODE:-normal}"}" = unknown ]; then
      printf 'Usage: proot-distro list\\nSupported distributions:\\n  Debian (debian)\\n  Ubuntu (ubuntu)\\n'
      exit 0
    fi
    if [ "${"${MOCK_LIST_MODE:-normal}"}" = permission ]; then echo 'Permission denied' >&2; exit 126; fi
    found=0
    for item in debian ubuntu; do
      if [ -f "$MOCK_STATE/$item.installed" ]; then
        if [ "$found" = 0 ]; then printf 'Installed containers:\\n\\n'; fi
        printf '  * %s\\n' "$item"
        found=1
      fi
    done
    if [ "$found" = 0 ]; then printf 'No containers are installed.\\n\\nInstall one with: proot-distro install ubuntu:24.04\\n'; fi
    exit 0
    ;;
  login)
    alias="$1"
    if [ "${"${MOCK_LOGIN_MODE:-normal}"}" = permission ]; then echo 'Permission denied' >&2; exit 126; fi
    if [ "${"${MOCK_LOGIN_MODE:-normal}"}" = unclassified ]; then echo 'storage state is unreadable' >&2; exit 1; fi
    if [ ! -f "$MOCK_STATE/$alias.installed" ] && [ "${"${MOCK_INITIAL_ALIAS:-}"}" != "$alias" ]; then echo "Error: container '$alias' is not installed." >&2; exit 1; fi
    if [ "${"${MOCK_LOGIN_MODE:-normal}"}" = fail ]; then echo 'guest login failed' >&2; exit 1; fi
    guest_uname="${"${MOCK_GUEST_UNAME:-}"}"
    if [ -z "$guest_uname" ]; then guest_uname=$(uname -m); fi
    printf 'AIB_PROBE_ID:%s\\nAIB_PROBE_UID:1000\\nAIB_PROBE_UNAME:%s\\n' "$alias" "$guest_uname"
    exit 0
    ;;
  install)
    alias="$1"
    printf 'install:%s\\n' "$alias" >> "$MOCK_CALLS"
    if [ "${"${MOCK_INSTALL_FAIL:-0}"}" = 1 ]; then echo 'mock installer failure' >&2; exit 17; fi
    touch "$MOCK_STATE/$alias.installed"
    echo 'mock rootfs installed'
    exit 0
    ;;
  reset|remove)
    printf 'FORBIDDEN:%s\\n' "$cmd" >> "$MOCK_CALLS"
    exit 99
    ;;
  *) echo "unexpected proot-distro command: $cmd" >&2; exit 64 ;;
esac
`;

function newMock({ initialAlias = null, listMode = "normal", loginMode = "normal", guestUname = "", installFail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(work, "case-"));
  const bin = path.join(dir, "bin");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(bin, "proot-distro"), mockCli, { mode: 0o755 });
  const callsFile = path.join(dir, "calls.txt");
  if (initialAlias) fs.writeFileSync(path.join(stateDir, `${initialAlias}.installed`), "fixture");
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: dir,
    MOCK_STATE: stateDir,
    MOCK_CALLS: callsFile,
    MOCK_INITIAL_ALIAS: initialAlias ?? "",
    MOCK_LIST_MODE: listMode,
    MOCK_LOGIN_MODE: loginMode,
    MOCK_GUEST_UNAME: guestUname,
    MOCK_INSTALL_FAIL: installFail ? "1" : "0",
  };
  return {
    dir,
    stateDir,
    env,
    callsFile,
    calls() { return fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split(/\r?\n/).filter(Boolean) : []; },
    execute(command, extraEnv = {}) {
      const result = spawnSync("/bin/bash", ["-c", command], { cwd: dir, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      return {
        exitCode: result.status ?? -1,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        ...(result.error?.code === "ETIMEDOUT" ? { timedOut: true } : {}),
      };
    },
    installed(alias) { return fs.existsSync(path.join(stateDir, `${alias}.installed`)); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function runResult(exitCode, extra = {}) { return { exitCode, stdout: "", stderr: "", ...extra }; }

function makeProductionRunner(target, mock, config = {}) {
  const alias = target === "ubuntu-proot" ? "ubuntu" : "debian";
  let hostAvailable = config.hostInitiallyAvailable !== false;
  let cancelAfterRootfs = false;
  let cancelled = false;
  const calls = [];
  const guestInstalled = new Set(config.guestInitiallyInstalled ?? PROOT_RUNTIME_REQUIREMENTS.map((item) => item.id).filter((id) => id !== (config.missingPackage ?? "curl")));
  const run = async (command, options) => {
    calls.push({ command, options });
    if (options.packageId === "proot-distro") {
      if (options.kind === "check") {
        if (config.hostFault && config.hostFault.once !== false && !config.hostFaultUsed) {
          config.hostFaultUsed = true;
          return config.hostFault.result;
        }
        if (config.hostFault && config.hostFault.once === false) return config.hostFault.result;
        return runResult(0, { stdout: `AIB_PROOT_TOOL:${hostAvailable ? "AVAILABLE" : "MISSING"}` });
      }
      if (options.kind === "install") {
        if (config.hostInstallMode === "timeout") return runResult(-1, { timedOut: true });
        if (config.hostInstallMode === "permission") return runResult(126, { stderr: "Permission denied" });
        hostAvailable = true;
        return runResult(0, { stdout: "proot-distro host prerequisite installed in mock" });
      }
    }
    if (options.packageId === `${alias}-rootfs`) {
      if (options.kind === "check") {
        if (config.rootfsFault && config.rootfsFault.once !== false && !config.rootfsFaultUsed) {
          config.rootfsFaultUsed = true;
          return config.rootfsFault.result;
        }
        if (config.rootfsFault && config.rootfsFault.once === false) return config.rootfsFault.result;
        return mock.execute(command);
      }
      if (options.kind === "install") {
        if (config.rootfsStageMode === "timeout") return runResult(-1, { timedOut: true });
        if (config.rootfsStageMode === "truncated") return runResult(0, { outputTruncated: true, stdout: "partial" });
        if (config.rootfsStageMode === "permission") return runResult(126, { stderr: "Permission denied" });
        const result = mock.execute(command, config.rootfsInstallEnv ?? {});
        if (config.cancelAfterRootfs) cancelled = true;
        cancelAfterRootfs = result.exitCode === 0;
        return result;
      }
    }
    if (PROOT_RUNTIME_REQUIREMENTS.some((item) => item.id === options.packageId) && options.kind === "check") {
      const fault = config.guestFaults?.[options.packageId];
      if (fault === "permission") return runResult(126, { stderr: "Permission denied" });
      if (fault === "timeout") return runResult(-1, { timedOut: true });
      if (fault === "truncated") return runResult(1, { outputTruncated: true, stdout: "partial" });
      if (fault === "throw") throw new Error("RUN_COMMAND_PERMISSION_MISSING");
      if (cancelled) return runResult(1);
      return runResult(guestInstalled.has(options.packageId) ? 0 : 1);
    }
    if (options.packageId === "runtime-guest-requirements" && options.kind === "update") {
      if (config.guestUpdateMode === "timeout") return runResult(-1, { timedOut: true });
      assert.equal(options.selectedBackend, target, `${alias} apt update must use the selected guest backend`);
      assert.match(command, /AIB_APT_SOURCE_UPDATE_CLASS/);
      assert.match(command, new RegExp(`aib-runtime-apt-update-${alias}`), "guest update capture path is scoped to the selected alias");
      return runResult(0, { stdout: "AIB_APT_SOURCE_UPDATE_CLASS:success\nAIB_APT_SOURCE_UPDATE_EXIT:0\nmock guest apt index update; no network used" });
    }
    if (options.packageId === "runtime-guest-requirements" && options.kind === "install") {
      assert.equal(options.selectedBackend, target, `${alias} apt install must use the selected guest backend`);
      assert.match(command, /apt-get \$AIB_APT_SECURITY_OPTIONS install -y/);
      assert.match(command, /AIB_APT_GUEST_INSTALL_CLASS/);
      if (config.guestInstallMode === "timeout") return runResult(-1, { timedOut: true });
      if (config.guestInstallMode === "truncated") return runResult(0, { outputTruncated: true, stdout: "partial" });
      for (const item of PROOT_RUNTIME_REQUIREMENTS) guestInstalled.add(item.id);
      return runResult(0, { stdout: "mock selected-guest apt install; no apt command executed" });
    }
    throw new Error(`Unexpected runner route ${options.kind}/${options.packageId}: ${command.slice(0, 120)}`);
  };
  return {
    calls,
    run,
    guestInstalled,
    get cancelled() { return cancelled; },
    async readiness() { return inspectProotRuntimeReadiness(target, { run }); },
    async prepare() {
      return prepareProotRuntimeEnvironment(target, {
        run,
        ensureRootfs: (selectedAlias, stagedRun, onProgress, shouldAbort) =>
          installProotDistroRootfsWithPrerequisite(selectedAlias, stagedRun, onProgress, shouldAbort),
        shouldAbort: () => cancelled,
      });
    },
  };
}

try {
  assert.equal(normalizeProotArchitecture("aarch64"), normalizeProotArchitecture("arm64"));
  assert.equal(normalizeProotArchitecture("amd64"), normalizeProotArchitecture("x86_64"));
  assert.equal(normalizeProotArchitecture("invalid"), null);

  for (const { backend, alias } of targets) {
    assert.equal(packageBackendTarget(backend, "proot-distro"), "termux", `${alias}: host proot tool remains Termux-routed`);
    assert.equal(packageBackendTarget(backend, `${alias}-rootfs`), "termux", `${alias}: rootfs remains Termux-routed`);
    assert.equal(packageBackendTarget(backend, "runtime-guest-requirements"), "linux", `${alias}: apt baseline remains guest-routed`);
    assert.equal(canOfferRuntimePreparationAction(backend, { target: backend, status: "error" }), true,
      `${alias}: visible action exists after an unknown/error Check`);
    assert.equal(canOfferRuntimePreparationAction(backend, null), true, `${alias}: unverified first render can offer guarded Prepare`);
    assert.equal(canOfferRuntimePreparationAction(backend, { target: backend, status: "ready" }), false,
      `${alias}: verified-ready UI hides the install/prepare action`);

    // The production generated shell performs the exact list/login/install/list/login sequence against a fake CLI.
    {
      const mock = newMock();
      try {
        const installCommand = buildProotDistroRootfsInstallCommand(alias);
        const result = mock.execute(installCommand);
        assert.equal(result.exitCode, 0, `${alias}: actual generated rootfs install shell succeeds with a mock CLI: ${result.stderr}`);
        assert.match(result.stdout, new RegExp(`AIB_${alias.toUpperCase()}_ROOTFS_OK`));
        assert.match(result.stdout, new RegExp(`${alias.toUpperCase()}_INSTALL_OK`));
        assert.equal(mock.installed(alias), true, `${alias}: only the selected alias is installed`);
        assert.deepEqual(mock.calls().filter((line) => line.startsWith("install:")), [`install:${alias}`]);
        assert.ok(mock.calls().some((line) => line === `list `), `${alias}: authoritative list is consulted`);
        assert.ok(mock.calls().some((line) => line.startsWith(`login ${alias}`)), `${alias}: login identity is checked`);
        assert.ok(!mock.calls().some((line) => /^(?:install|reset|remove):(?:debian|ubuntu)$/.test(line) && line !== `install:${alias}`),
          `${alias}: no sibling install/reset/remove command was issued`);
        assert.ok(!mock.calls().some((line) => line.startsWith("FORBIDDEN:")), `${alias}: destructive reset/remove never occurs`);

        const finalCheck = mock.execute(buildProotDistroProbeCommand(alias));
        const parsed = parseProotDistroProbe(alias, finalCheck.stdout, finalCheck.exitCode);
        assert.equal(parsed.healthy, true, `${alias}: final complete list/login/OS/UID/arch readback is healthy`);
        assert.equal(parsed.architectureMatches, true);
        assert.equal(parsed.osReleaseId, alias);
        const rootfsReadback = mock.execute(buildProotDistroRootfsCheckCommand(alias));
        assert.equal(rootfsReadback.exitCode, 0);
        assert.match(rootfsReadback.stdout, new RegExp(`AIB_${alias.toUpperCase()}_ROOTFS_OK`));
      } finally { mock.cleanup(); }
    }

    // A healthy alias plus a missing guest package skips the actual rootfs install and continues in that guest.
    {
      const mock = newMock({ initialAlias: alias });
      try {
        const runner = makeProductionRunner(backend, mock, { missingPackage: "curl" });
        const before = await runner.readiness();
        assert.equal(before.status, "missing");
        assert.equal(before.rootfs, "healthy");
        const action = await runProotRuntimePreparationAction(backend, {
          check: () => runner.readiness(),
          prepare: () => runner.prepare(),
        });
        assert.equal(action.kind, "prepared");
        assert.equal(action.readiness.rootfs, "healthy");
        assert.equal(action.result.ok, true, `${alias}: guest baseline is prepared after healthy-rootfs preflight: ${JSON.stringify(action.result)}`);
        const rootfsStage = runner.calls.find((call) => call.options.packageId === `${alias}-rootfs` && call.options.kind === "install");
        assert.ok(rootfsStage, `${alias}: guarded rootfs stage performs post-readback`);
        assert.match(rootfsStage.command, new RegExp(`ROOTFS_ALREADY_HEALTHY:${alias}`));
        assert.equal(mock.calls().filter((line) => line === `install:${alias}`).length, 0,
          `${alias}: a healthy existing rootfs is not installed again`);
        const aptInstall = runner.calls.find((call) => call.options.packageId === "runtime-guest-requirements" && call.options.kind === "install");
        assert.ok(aptInstall, `${alias}: missing baseline package is installed`);
        assert.equal(aptInstall.options.selectedBackend, backend);
        assert.match(aptInstall.command, /apt-get \$AIB_APT_SECURITY_OPTIONS install -y/);
        assert.match(aptInstall.command, /curl/);
        const finalReadiness = await runner.readiness();
        assert.equal(finalReadiness.status, "ready", `${alias}: complete guest baseline verifies after apt`);
        const retry = await runProotRuntimePreparationAction(backend, {
          check: () => runner.readiness(),
          prepare: async () => { throw new Error("healthy retry must never reach preparation"); },
        });
        assert.equal(retry.kind, "already-ready", `${alias}: subsequent click is retry-safe and performs no install`);
      } finally { mock.cleanup(); }
    }

    // When a previous Check is unknown but the click-time recheck confirms exact absence, the same button may safely prepare.
    {
      const mock = newMock();
      try {
        let checkCount = 0;
        const runner = makeProductionRunner(backend, mock, {
          missingPackage: "curl",
          rootfsFault: { once: true, result: runResult(-1, { timedOut: true }) },
        });
        const previousCheck = await runner.readiness();
        assert.equal(previousCheck.status, "error", `${alias}: previous rootfs timeout remains unknown`);
        assert.equal(canOfferRuntimePreparationAction(backend, previousCheck), true,
          `${alias}: user still has an explicit Prepare action after unknown Check`);
        const action = await runProotRuntimePreparationAction(backend, {
          check: async () => { checkCount += 1; return runner.readiness(); },
          prepare: () => runner.prepare(),
        });
        assert.equal(checkCount, 1, `${alias}: click runs its own fresh read-only check`);
        assert.equal(action.kind, "prepared", `${alias}: only the fresh confirmed missing state proceeds`);
        assert.equal(action.readiness.status, "missing");
        assert.equal(action.result.ok, true);
        assert.equal(mock.calls().filter((line) => line === `install:${alias}`).length, 1);
      } finally { mock.cleanup(); }
    }

    // Persisting unknown/error, a permission failure, timeout, truncation, corrupt list, or unhealthy rootfs never invokes preparation.
    for (const fault of [
      { name: "host permission", hostFault: { once: false, result: runResult(126, { stderr: "Permission denied" }) } },
      { name: "host timeout", hostFault: { once: false, result: runResult(-1, { timedOut: true }) } },
      { name: "host truncated", hostFault: { once: false, result: runResult(0, { outputTruncated: true }) } },
      { name: "rootfs permission", rootfsFault: { once: false, result: runResult(126, { stderr: "Permission denied" }) } },
      { name: "rootfs timeout", rootfsFault: { once: false, result: runResult(-1, { timedOut: true }) } },
      { name: "rootfs truncated", rootfsFault: { once: false, result: runResult(0, { outputTruncated: true }) } },
      { name: "guest permission", guestFaults: { git: "permission" } },
      { name: "guest timeout", guestFaults: { wget: "timeout" } },
      { name: "guest truncated", guestFaults: { curl: "truncated" } },
      { name: "guest bridge exception", guestFaults: { "zip-unzip": "throw" } },
    ]) {
      const mock = newMock({ initialAlias: fault.guestFaults ? alias : null });
      try {
        const runner = makeProductionRunner(backend, mock, fault);
        const state = await runner.readiness();
        assert.equal(state.status, "error", `${alias}/${fault.name} remains unknown/error`);
        assert.equal(canOfferRuntimePreparationAction(backend, state), true, `${alias}/${fault.name} keeps Prepare visible`);
        let prepareCalled = false;
        const action = await runProotRuntimePreparationAction(backend, {
          check: () => runner.readiness(),
          prepare: async () => { prepareCalled = true; return runner.prepare(); },
        });
        assert.equal(action.kind, "blocked", `${alias}/${fault.name} is blocked after fresh preflight`);
        assert.equal(prepareCalled, false, `${alias}/${fault.name} never reaches the mutating callback`);
        assert.equal(mock.calls().filter((line) => line.startsWith("install:")).length, 0);
      } finally { mock.cleanup(); }
    }

    // A listed installed-but-unhealthy or architecture-mismatched rootfs is not missing and cannot be overwritten.
    for (const broken of [
      { loginMode: "fail", guestUname: "" },
      { loginMode: "normal", guestUname: otherMachine },
    ]) {
      const mock = newMock({ initialAlias: alias, ...broken });
      try {
        const runner = makeProductionRunner(backend, mock, { missingPackage: "curl" });
        const state = await runner.readiness();
        assert.equal(state.status, "error");
        assert.equal(state.rootfsState.installed, true, `${alias}: existing listed rootfs stays present`);
        assert.equal(canOfferRuntimePreparationAction(backend, state), true);
        const action = await runProotRuntimePreparationAction(backend, {
          check: () => runner.readiness(),
          prepare: () => runner.prepare(),
        });
        assert.equal(action.kind, "blocked");
        const guardedInstall = mock.execute(buildProotDistroInstallCommand(alias));
        assert.equal(guardedInstall.exitCode, 78, `${alias}: explicit repair install builder stops on unhealthy existing rootfs`);
        assert.match(guardedInstall.stdout, /ROOTFS_(?:STATE_UNVERIFIED|INSTALLED_LOGIN_FAILED)/);
        assert.equal(mock.calls().filter((line) => line === `install:${alias}`).length, 0);
        assert.equal(mock.calls().filter((line) => line.startsWith("FORBIDDEN:")).length, 0);
      } finally { mock.cleanup(); }
    }

    // A valid but unknown installed-list envelope stays unknown, not `missing`.
    {
      const mock = newMock({ listMode: "unknown", loginMode: "unclassified" });
      try {
        const runner = makeProductionRunner(backend, mock, { missingPackage: "curl" });
        const state = await runner.readiness();
        assert.equal(state.status, "error");
        assert.equal(state.rootfs, "unknown");
        let prepareCalled = false;
        const action = await runProotRuntimePreparationAction(backend, {
          check: () => runner.readiness(),
          prepare: async () => { prepareCalled = true; return runner.prepare(); },
        });
        assert.equal(action.kind, "blocked");
        assert.equal(prepareCalled, false);
        const guarded = mock.execute(buildProotDistroInstallCommand(alias));
        assert.equal(guarded.exitCode, 78);
        assert.match(guarded.stdout, /ROOTFS_STATE_UNVERIFIED/);
        assert.equal(mock.calls().filter((line) => line.startsWith("install:")).length, 0);
      } finally { mock.cleanup(); }
    }

    // The rootfs stage's permission/timeout/truncation or cancellation must stop before guest apt/update.
    for (const mode of ["permission", "timeout", "truncated", "cancelAfterRootfs"]) {
      const mock = newMock();
      try {
        const runner = makeProductionRunner(backend, mock, { missingPackage: "curl", [mode]: true, rootfsStageMode: mode });
        const action = await runProotRuntimePreparationAction(backend, {
          check: () => runner.readiness(),
          prepare: () => runner.prepare(),
        });
        assert.equal(action.kind, "prepared");
        assert.equal(action.result.ok, false, `${alias}/${mode}: rootfs stage cannot be marked ready`);
        assert.equal(action.result.stage, "rootfs");
        if (mode === "cancelAfterRootfs") assert.equal(action.result.cancelled, true);
        assert.equal(runner.calls.some((call) => call.options.packageId === "runtime-guest-requirements"), false,
          `${alias}/${mode}: guest baseline checks/apt never run after failed/cancelled rootfs stage`);
      } finally { mock.cleanup(); }
    }

    // Timeout or truncation in guest apt update/install prevents final readiness confirmation.
    for (const scenario of [
      { guestUpdateMode: "timeout", stage: "guest-index-update", error: /TIMEOUT/ },
      { guestInstallMode: "timeout", stage: "guest-install", error: /TIMEOUT/ },
      { guestInstallMode: "truncated", stage: "guest-install", error: /OUTPUT_INCOMPLETE/ },
    ]) {
      const mock = newMock({ initialAlias: alias });
      try {
        const runner = makeProductionRunner(backend, mock, { missingPackage: "curl", ...scenario });
        const action = await runProotRuntimePreparationAction(backend, {
          check: () => runner.readiness(),
          prepare: () => runner.prepare(),
        });
        assert.equal(action.kind, "prepared");
        assert.equal(action.result.ok, false);
        assert.equal(action.result.stage, scenario.stage);
        assert.match(action.result.error, scenario.error);
      } finally { mock.cleanup(); }
    }
  }

  // The production Runtime handler must bind its visible action to the fresh classifier and only commit ready after final rootfs readback.
  const runtimeSource = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
  assert.match(runtimeSource, /runProotRuntimePreparationAction\(backend,[\s\S]{0,250}check:\s*\(\) => inspectProotRuntimeReadiness/);
  assert.match(runtimeSource, /const finalStatus = await getRuntimeFacade\(\)\.linuxStatus\("debian"\)/);
  assert.match(runtimeSource, /finalRootfsState = await inspectTermuxProotDistro\("debian"\)/);
  assert.match(runtimeSource, /finalRootfsState\.architectureMatches !== true/);
  assert.match(runtimeSource, /finalRootfsState = await inspectTermuxProotDistro\("ubuntu"\)/);
  assert.match(runtimeSource, /finalRootfsState\.healthy !== true \|\| finalRootfsState\.osReleaseId !== "ubuntu"/);
  assert.match(runtimeSource, /setRuntimeReadiness\(\{ target: backend, status: "ready"/);

  console.log("AIB_V277_RUNTIME_ACTION_E2E_SELFTEST_OK aliases=ubuntu,debian actual-generated-shell=fake-proot-list/login/install/post-readback host-vs-guest-arch=verified guarded-action=ready|missing|unknown UI=PASS guest-routing=selected apt=mock-only timeout/permission/truncation/cancel/retry-safe=PASS destructive-reset=0");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
