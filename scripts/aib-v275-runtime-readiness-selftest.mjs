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

const { inspectProotRuntimeReadiness } = loadTs(path.join(root, "lib/runtime-environment-check.ts"));
const host = (state, extra = {}) => ({ exitCode: 0, stdout: `AIB_PROOT_TOOL:${state.toUpperCase()}`, stderr: "", ...extra });
function rootfs(alias, state = "healthy") {
  const list = state === "missing"
    ? "No containers are installed."
    : `Installed distributions:\n  ${alias}`;
  const loginExit = state === "healthy" ? 0 : 1;
  const identity = state === "healthy"
    ? `AIB_PROBE_ID:${alias}\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:aarch64`
    : state === "missing"
      ? `Error: container '${alias}' is not installed.`
      : "login failed";
  return {
    exitCode: 0,
    stdout: `AIB_PROBE_BEGIN\nAIB_PROOT_TOOL:AVAILABLE\nAIB_HOST_UNAME:aarch64\nAIB_LIST_EXIT:0\nAIB_LIST_BEGIN\n${list}\nAIB_LIST_END\nAIB_LOGIN_EXIT:${loginExit}\nAIB_LOGIN_BEGIN\n${identity}\nAIB_LOGIN_END\nAIB_PROBE_END`,
    stderr: "",
  };
}
function runner({ hostState = "available", rootfsState = "healthy", packageStates = {}, hostExtra = {}, rootfsExtra = {} } = {}) {
  const calls = [];
  return {
    calls,
    run: async (command, options) => {
      calls.push({ command, options });
      if (options.packageId === "proot-distro") return host(hostState, hostExtra);
      if (options.packageId === "debian-rootfs" || options.packageId === "ubuntu-rootfs") return { ...rootfs(options.packageId.split("-")[0], rootfsState), ...rootfsExtra };
      const state = packageStates[options.packageId] ?? "installed";
      return state === "installed"
        ? { exitCode: 0, stdout: "", stderr: "" }
        : state === "missing"
          ? { exitCode: 1, stdout: "", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "", timedOut: true };
    },
  };
}

for (const target of ["ubuntu-proot", "ubuntu-proot"]) {
  const alias = target === "ubuntu-proot" ? "ubuntu" : "debian";
  const events = [];
  {
    const mock = runner();
    const result = await inspectProotRuntimeReadiness(target, {
      run: mock.run,
      onProgress: (phase, detail) => events.push({ phase, detail }),
    });
    assert.equal(result.status, "ready", `${target} complete baseline should be ready`);
    assert.equal(result.hostTool, "available");
    assert.equal(result.rootfs, "healthy");
    assert.equal(result.baseline, "ready");
    assert.equal(result.rootfsState.osReleaseId, alias);
    assert.equal(mock.calls.length, 7, "host, rootfs and five guest checks are read-only");
    assert.ok(mock.calls.every((call) => call.options.kind === "check"), "readiness path never performs installation/update");
    assert.equal(mock.calls[0].options.selectedBackend, "termux", "shared proot prerequisite is checked on Termux host");
    assert.equal(mock.calls[1].options.selectedBackend, "termux", "rootfs probe is routed to Termux host");
    assert.ok(mock.calls.slice(2).every((call) => call.options.selectedBackend === target), "baseline probes run inside only the selected guest");
    assert.ok(events.some((event) => event.phase === "guest-baseline" && /OpenJDK/.test(event.detail)));
    assert.ok(!mock.calls.some((call) => /(?:pkg|apt-get)\s+(?:install|update)|proot-distro\s+install/i.test(call.command)));
  }
  {
    const mock = runner({ hostState: "missing" });
    const result = await inspectProotRuntimeReadiness(target, { run: mock.run });
    assert.equal(result.status, "missing");
    assert.deepEqual(result.missingItems, ["proot-distro (Termux host)"]);
    assert.equal(mock.calls.length, 1, "confirmed absent host prerequisite stops further probes");
    assert.ok(mock.calls.every((call) => call.options.kind === "check"));
  }
  {
    const mock = runner({ rootfsState: "missing" });
    const result = await inspectProotRuntimeReadiness(target, { run: mock.run });
    assert.equal(result.status, "missing");
    assert.deepEqual(result.missingItems, [`${alias} rootfs`]);
    assert.equal(mock.calls.length, 2, "confirmed absent rootfs stops before guest probes");
    assert.ok(mock.calls.every((call) => call.options.kind === "check"));
  }
  {
    const mock = runner({ packageStates: { curl: "missing" } });
    const result = await inspectProotRuntimeReadiness(target, { run: mock.run });
    assert.equal(result.status, "missing");
    assert.deepEqual(result.missingItems, ["curl"]);
    assert.equal(mock.calls.length, 7);
    assert.ok(mock.calls.every((call) => call.options.kind === "check"));
  }
  {
    const mock = runner({ packageStates: { wget: "timeout" } });
    const result = await inspectProotRuntimeReadiness(target, { run: mock.run });
    assert.equal(result.status, "error");
    assert.equal(result.baseline, "unknown");
    assert.deepEqual(result.missingItems, []);
    assert.equal(mock.calls.length, 6, "an inconclusive baseline check stops the rest of the sequence");
  }
  {
    const mock = runner({ rootfsState: "login-failed" });
    const result = await inspectProotRuntimeReadiness(target, { run: mock.run });
    assert.equal(result.status, "error", "installed but unhealthy rootfs is not called absent");
    assert.deepEqual(result.missingItems, []);
    assert.equal(mock.calls.length, 2, "failed login stops before guest baseline probes");
  }
}

for (const failure of [
  { name: "timeout", extra: { timedOut: true } },
  { name: "truncated", extra: { outputTruncated: true } },
  { name: "incomplete", extra: { stdout: "no status marker" } },
]) {
  const mock = runner({ hostExtra: failure.extra });
  const result = await inspectProotRuntimeReadiness("ubuntu-proot", { run: mock.run });
  assert.equal(result.status, "error", `${failure.name} host check is not absence`);
  assert.deepEqual(result.missingItems, []);
  assert.equal(mock.calls.length, 1);
}
{
  const mock = runner({ rootfsExtra: { timedOut: true } });
  const result = await inspectProotRuntimeReadiness("ubuntu-proot", { run: mock.run });
  assert.equal(result.status, "error", "rootfs timeout is not absence");
  assert.deepEqual(result.missingItems, []);
  assert.equal(mock.calls.length, 2);
}
{
  const mock = runner();
  const result = await inspectProotRuntimeReadiness("ubuntu-proot", {
    run: async (...args) => {
      mock.calls.push(args);
      if (args[1].packageId === "proot-distro") throw new Error("RUN_COMMAND_PERMISSION_MISSING");
      return mock.run(...args);
    },
  });
  assert.equal(result.status, "error", "permission failure is not absence");
  assert.deepEqual(result.missingItems, []);
  assert.equal(mock.calls.length, 1);
}

const productionCheck = fs.readFileSync(path.join(root, "lib/runtime-environment-check.ts"), "utf8");
assert.doesNotMatch(productionCheck, /apt-get\s+(?:update|install)|pkg\s+install|proot-distro\s+install/i,
  "readiness checker source contains no installer command");
console.log("AIB_V275_RUNTIME_READINESS_SELFTEST_OK targets=ubuntu,debian read-only=host/rootfs/baseline unknown-fail-closed=1 strict-install-gating=confirmed-absence-only guarded-prepare=unknown-error-visible");
