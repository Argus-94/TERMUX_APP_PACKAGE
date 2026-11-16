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
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}
const { installProotDistroRootfsWithPrerequisite } = loadTs(path.join(root, "lib/proot-distro-bootstrap.ts"));
const productionInstaller = fs.readFileSync(path.join(root, "lib/compile-packages.ts"), "utf8");
assert.match(productionInstaller, /installProotDistroRootfsWithPrerequisite/);
assert.match(productionInstaller, /def\.id === "debian-rootfs" \|\| def\.id === "ubuntu-rootfs"/);

const okRootfs = (alias, extra = {}) => ({
  exitCode: 0,
  stdout: `AIB_${alias.toUpperCase()}_ROOTFS_OK\n${alias.toUpperCase()}_ROOTFS_OK\n${alias.toUpperCase()}_INSTALL_OK`,
  stderr: "",
  ...extra,
});
const toolResult = (status, extra = {}) => ({ exitCode: 0, stdout: `AIB_PROOT_TOOL:${status.toUpperCase()}`, stderr: "", ...extra });
function makeRunner(alias, { initiallyAvailable = false, onRootfs, onHostInstall } = {}) {
  let available = initiallyAvailable;
  const calls = [];
  const run = async (command, options) => {
    calls.push({ command, options });
    if (options.kind === "check" && options.packageId === "proot-distro") {
      return toolResult(available ? "available" : "missing");
    }
    if (command.includes("apt-get install -y proot-distro")) {
      onHostInstall?.();
      available = true;
      return { exitCode: 0, stdout: "AIB_APT_EXIT:0\nproot-distro installed", stderr: "" };
    }
    if (command.includes(`proot-distro install ${alias}`)) {
      onRootfs?.();
      return okRootfs(alias);
    }
    throw new Error(`Unexpected command ${command.slice(0, 140)}`);
  };
  return { run, calls, isAvailable: () => available };
}

for (const alias of ["debian", "ubuntu"]) {
  // Missing host tool is installed and verified before the guarded rootfs command.
  {
    const mock = makeRunner(alias);
    const progress = [];
    const logs = [];
    const result = await installProotDistroRootfsWithPrerequisite(alias, mock.run, (p, d) => progress.push([p, d]), () => false, (l, m) => logs.push([l, m]));
    assert.deepEqual(result, { ok: true }, `${alias} bootstrap should complete with successful evidence`);
    assert.equal(mock.calls.length, 4, "expected host probe, pkg install, host verification, rootfs operation");
    assert.ok(mock.calls[0].command.includes("command -v proot-distro"));
    assert.equal(mock.calls[0].options.timeoutMs, 20_000);
    assert.equal(mock.calls[1].options.packageId, "proot-distro");
    assert.equal(mock.calls[1].options.timeoutMs, 180_000);
    assert.equal(mock.calls[1].options.honorExplicitTimeout, true);
    assert.match(mock.calls[1].command, /apt-get install -y proot-distro/);
    assert.equal(mock.calls[2].options.kind, "check");
    assert.equal(mock.calls[3].options.packageId, `${alias}-rootfs`);
    assert.equal(mock.calls[3].options.timeoutMs, 45 * 60_000);
    assert.match(mock.calls[3].command, new RegExp(`proot-distro install ${alias}`));
    assert.match(mock.calls[3].command, /Installed distributions/);
    assert.match(mock.calls[3].command, new RegExp(`ROOTFS_INSTALLED_LOGIN_FAILED:${alias}`));
    assert.doesNotMatch(mock.calls[3].command, /proot-distro\s+(?:reset|remove)/i);
    assert.ok(progress.some(([, label]) => /Установка host-пакета/.test(label)));
    assert.ok(progress.some(([, label]) => new RegExp(`установка ${alias} rootfs`, "i").test(label)));
    assert.ok(logs.some(([, line]) => line.includes("phase=host-tool-install result=verified")));
    assert.ok(logs.some(([, line]) => line.includes("phase=rootfs-install result=healthy-login-confirmed")));
  }

  // Existing host tool (including an already-healthy rootfs) is not reinstalled.
  {
    const mock = makeRunner(alias, { initiallyAvailable: true });
    const result = await installProotDistroRootfsWithPrerequisite(alias, mock.run, () => undefined);
    assert.deepEqual(result, { ok: true });
    assert.equal(mock.calls.length, 2, "host package install and second tool probe must be skipped");
    assert.ok(mock.calls[1].command.includes("ROOTFS_ALREADY_HEALTHY:" + alias));
    assert.equal(mock.calls.filter((call) => call.command.includes("apt-get install -y proot-distro")).length, 0);
  }

  // Host package/network failure and post-install missing command must stop before rootfs work.
  {
    const mock = makeRunner(alias);
    const calls = [];
    const run = async (command, options) => {
      calls.push({ command, options });
      if (calls.length === 1) return toolResult("missing");
      if (command.includes("apt-get install -y proot-distro")) return { exitCode: 100, stdout: "[aib] APT_UPDATE_DIAGNOSTIC_BEGIN\nTemporary failure resolving packages.termux.dev\n[aib] APT_UPDATE_DIAGNOSTIC_END", stderr: "" };
      throw new Error("rootfs must not start after host package failure");
    };
    const result = await installProotDistroRootfsWithPrerequisite(alias, run, () => undefined);
    assert.equal(result.ok, false);
    assert.match(result.error, /apt-get update failed|Temporary failure resolving/i);
    assert.equal(calls.length, 2);
    assert.equal(mock.calls.length, 0);
  }
  {
    let probes = 0;
    const calls = [];
    const run = async (command, options) => {
      calls.push(command);
      if (options.kind === "check" && options.packageId === "proot-distro") {
        probes++;
        return toolResult(probes === 1 ? "missing" : "missing");
      }
      if (command.includes("apt-get install -y proot-distro")) return { exitCode: 0, stdout: "AIB_APT_EXIT:0", stderr: "" };
      throw new Error("rootfs must not start when command verification fails");
    };
    const result = await installProotDistroRootfsWithPrerequisite(alias, run, () => undefined);
    assert.equal(result.ok, false);
    assert.match(result.error, /PROOT_TOOL_INSTALL_NOT_VERIFIED/);
    assert.equal(probes, 2);
    assert.equal(calls.length, 3);
  }

  // Unknown rootfs states and installed-login failures are preserved, not reported as success.
  for (const evidence of [`AIB_${alias.toUpperCase()}_ROOTFS_STATE_UNVERIFIED`, `AIB_${alias.toUpperCase()}_ROOTFS_INSTALLED_LOGIN_FAILED`]) {
    const mock = makeRunner(alias, { initiallyAvailable: true, onRootfs: undefined });
    const run = async (command, options) => {
      mock.calls.push({ command, options });
      if (options.kind === "check" && options.packageId === "proot-distro") return toolResult("available");
      if (command.includes(`proot-distro install ${alias}`)) return { exitCode: 78, stdout: evidence, stderr: "preserved" };
      throw new Error("Unexpected command in fail-closed rootfs test");
    };
    const logs = [];
    const result = await installProotDistroRootfsWithPrerequisite(alias, run, () => undefined, undefined, (_l, m) => logs.push(m));
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(evidence));
    assert.ok(!logs.some((line) => line.includes("healthy-login-confirmed")));
  }
}

// RUN_COMMAND denial, indeterminate probe output, and timeout never progress to pkg or rootfs.
for (const failure of [
  { name: "denied", run: async () => { throw new Error("RUN_COMMAND_PERMISSION_MISSING"); }, expected: /RUN_COMMAND_PERMISSION_MISSING/ },
  { name: "timeout", run: async () => ({ ...toolResult("missing"), timedOut: true }), expected: /PROOT_TOOL_STATE_UNVERIFIED/ },
  { name: "truncated", run: async () => ({ ...toolResult("missing"), outputTruncated: true }), expected: /PROOT_TOOL_STATE_UNVERIFIED/ },
]) {
  const calls = [];
  const run = async (...args) => { calls.push(args); return failure.run(...args); };
  const result = await installProotDistroRootfsWithPrerequisite("debian", run, () => undefined);
  assert.equal(result.ok, false, failure.name);
  assert.match(result.error, failure.expected, failure.name);
  assert.equal(calls.length, 1, `${failure.name} must stop after preflight`);
}

// A package transaction timeout or denial prevents the rootfs phase.
{
  const calls = [];
  const run = async (command, options) => {
    calls.push(command);
    if (options.kind === "check" && options.packageId === "proot-distro") return toolResult(calls.length === 1 ? "missing" : "available");
    if (command.includes("apt-get install -y proot-distro")) return { exitCode: -1, timedOut: true, stdout: "", stderr: "TERMUX_RESULT_CALLBACK_TIMEOUT" };
    throw new Error("rootfs must not follow a timed-out host package transaction");
  };
  const result = await installProotDistroRootfsWithPrerequisite("debian", run, () => undefined);
  assert.equal(result.ok, false);
  assert.match(result.error, /PROOT_TOOL_INSTALL_TIMEOUT/);
  assert.equal(calls.length, 2);
}
{
  const calls = [];
  const run = async (command, options) => {
    calls.push(command);
    if (options.kind === "check" && options.packageId === "proot-distro") return toolResult("available");
    if (command.includes("proot-distro install ubuntu")) throw new Error("RUN_COMMAND denied while starting rootfs");
    throw new Error("Unexpected command");
  };
  const result = await installProotDistroRootfsWithPrerequisite("ubuntu", run, () => undefined);
  assert.equal(result.ok, false);
  assert.match(result.error, /RUN_COMMAND denied/);
  assert.ok(!result.error.includes("healthy-login-confirmed"));
  assert.equal(calls.length, 2);
}
{
  const calls = [];
  const run = async (command, options) => {
    calls.push(command);
    if (options.kind === "check" && options.packageId === "proot-distro") return toolResult("available");
    if (command.includes("proot-distro install debian")) return { ...okRootfs("debian"), timedOut: true };
    throw new Error("Unexpected command");
  };
  const logs = [];
  const result = await installProotDistroRootfsWithPrerequisite("debian", run, () => undefined, undefined, (_l, m) => logs.push(m));
  assert.equal(result.ok, false);
  assert.match(result.error, /ROOTFS_INSTALL_TIMEOUT/);
  assert.ok(!logs.some((line) => line.includes("healthy-login-confirmed")));
}

// Cancellation at each transition prevents the next phase; in-flight RUN_COMMAND is not falsely declared cancelled mid-shell.
{
  let aborted = false;
  const calls = [];
  const run = async (command, options) => {
    calls.push(command);
    if (options.kind === "check" && options.packageId === "proot-distro") return toolResult("missing");
    if (command.includes("apt-get install -y proot-distro")) { aborted = true; return { exitCode: 0, stdout: "AIB_APT_EXIT:0", stderr: "" }; }
    throw new Error("rootfs must not start after cancellation during host package install");
  };
  const result = await installProotDistroRootfsWithPrerequisite("debian", run, () => undefined, () => aborted);
  assert.deepEqual(result, { ok: false, error: "aborted" });
  assert.equal(calls.length, 2);
}
{
  let aborted = false;
  const calls = [];
  const run = async (command, options) => {
    calls.push(command);
    if (options.kind === "check" && options.packageId === "proot-distro") return toolResult("available");
    if (command.includes("proot-distro install ubuntu")) { aborted = true; return okRootfs("ubuntu"); }
    throw new Error("Unexpected command");
  };
  const logs = [];
  const result = await installProotDistroRootfsWithPrerequisite("ubuntu", run, () => undefined, () => aborted, (_l, m) => logs.push(m));
  assert.deepEqual(result, { ok: false, error: "aborted" });
  assert.equal(calls.length, 2, "cancellation after command completion does not rerun install");
  assert.ok(!logs.some((line) => line.includes("healthy-login-confirmed")), "cancelled operation must not emit success");
}
{
  let aborted = false;
  const calls = [];
  const run = async (command, options) => {
    calls.push(command);
    if (options.kind === "check" && options.packageId === "proot-distro") return toolResult("available");
    if (command.includes("proot-distro install debian")) throw new Error("Unexpected: cancelled before rootfs stage");
    throw new Error("Unexpected command");
  };
  const result = await installProotDistroRootfsWithPrerequisite("debian", run, () => undefined, () => aborted, (_l, m) => { if (m.includes("phase=host-tool-check result=available")) aborted = true; });
  assert.deepEqual(result, { ok: false, error: "aborted" });
  assert.equal(calls.length, 1);
}

// Duplicate taps/entry points join the alias lock and produce only one rootfs invocation.
{
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const calls = [];
  const run = async (command, options) => {
    calls.push(command);
    if (calls.length === 1) { await probeGate; return toolResult("available"); }
    if (options.kind === "check" && options.packageId === "proot-distro") return toolResult("available");
    if (command.includes("proot-distro install ubuntu")) return okRootfs("ubuntu");
    throw new Error("Unexpected command");
  };
  const first = installProotDistroRootfsWithPrerequisite("ubuntu", run, () => undefined);
  await Promise.resolve();
  const second = installProotDistroRootfsWithPrerequisite("ubuntu", run, () => undefined);
  releaseProbe();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: true });
  assert.equal(calls.length, 2, "duplicate operation must reuse the active sequence");
  assert.equal(calls.filter((command) => command.includes("proot-distro install ubuntu")).length, 1);
}

console.log("AIB_PROOT_DISTRO_BOOTSTRAP_SELFTEST_OK aliases=debian,ubuntu cases=missing-tool-install-verify,already-installed-tool-and-rootfs,network-failure,unverified-tool,unknown-rootfs,login-failed,run-command-denied,timeout,truncation,cancel,duplicate-lock");
