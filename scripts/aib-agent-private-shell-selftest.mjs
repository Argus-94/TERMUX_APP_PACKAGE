#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-agent-private-shell-"));
try {
  const lib = path.join(out, "lib");
  const asyncStorageDir = path.join(lib, "node_modules", "@react-native-async-storage", "async-storage");
  fs.mkdirSync(asyncStorageDir, { recursive: true });
  const storageStub = path.join(asyncStorageDir, "index.js");
  fs.writeFileSync(storageStub, [
    "const state = { value: 'embedded-private', failRead: false, writes: [] };",
    "exports.__esModule = true;",
    "exports.default = {",
    "  __state: state,",
    "  getItem: async (key) => { if (state.failRead) throw new Error('storage read failed'); if (key !== 'aibuilder.agentShellExecutionTarget.v1') throw new Error('unexpected storage key'); return state.value; },",
    "  setItem: async (key, value) => { if (key !== 'aibuilder.agentShellExecutionTarget.v1') throw new Error('unexpected storage key'); state.value = value; state.writes.push([key, value]); },",
    "};",
  ].join("\n"));
  const require = createRequire(import.meta.url);

  const targetSource = fs.readFileSync(path.join(root, "lib/agent-shell-target.ts"), "utf8");
  const targetCompiled = typescript.transpile(targetSource, {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2022,
  });
  const targetPath = path.join(lib, "agent-shell-target.js");
  fs.writeFileSync(targetPath, targetCompiled);
  const targetModule = require(targetPath);
  const storage = require(storageStub).default;
  assert.equal(await targetModule.loadAgentShellExecutionTarget(), "embedded-private");
  assert.equal(targetModule.getAgentShellExecutionTarget(), "embedded-private");
  assert.equal(targetModule.parseAgentShellExecutionTarget("selected-backend"), "embedded-private", "legacy persisted backend selections cannot re-enable an external runtime");
  await assert.rejects(() => targetModule.setAgentShellExecutionTarget("selected-backend"), /AGENT_SHELL_EXTERNAL_TARGET_DISABLED/);
  assert.equal(targetModule.getAgentShellExecutionTarget(), "embedded-private");
  assert.deepEqual(storage.__state.writes, []);

  const failingTargetPath = path.join(lib, "agent-shell-target-failure.js");
  fs.writeFileSync(failingTargetPath, targetCompiled);
  storage.__state.failRead = true;
  const failingTarget = require(failingTargetPath);
  await assert.rejects(() => failingTarget.loadAgentShellExecutionTarget(), /AGENT_SHELL_TARGET_LOAD_FAILED/,
    "a storage read failure is not silently interpreted as the legacy target");
  storage.__state.failRead = false;

  fs.writeFileSync(path.join(lib, "termux-executor.js"), [
    "exports.executeGuardedTermuxCommand = async () => { throw new Error('unexpected default legacy call'); };",
  ].join("\n"));
  const providerSource = fs.readFileSync(path.join(root, "lib/private-runtime-provider.ts"), "utf8");
  const providerPath = path.join(lib, "private-runtime-provider.js");
  fs.writeFileSync(providerPath, typescript.transpile(providerSource, {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2022,
  }));
  const { createAgentShellCommandExecutor } = require(providerPath);
  const privateCalls = [];
  const legacyCalls = [];
  const privateResult = { commandId: "private-shell-test", stdout: "private-ok", stderr: "", exitCode: 0, timedOut: false, outputTruncated: false };
  const privateProvider = {
    execute: async (command, options) => {
      privateCalls.push({ command, options });
      return privateResult;
    },
  };
  const legacyExecutor = async (command, options) => {
    legacyCalls.push({ command, options });
    return { ...privateResult, commandId: "legacy-shell-test", stdout: "legacy-ok" };
  };
  const execute = createAgentShellCommandExecutor(legacyExecutor, privateProvider);
  const controller = new AbortController();
  const legacyOnlyConfirm = () => true;
  const options = {
    timeoutMs: 3000,
    workdir: "/storage/emulated/0/AIBuilderTermux/project",
    signal: controller.signal,
    trustedInternal: true,
    preserveOutput: true,
    traceId: "agent-private-route-test",
    backend: "ubuntu-proot",
    hostTermux: true,
    executionTarget: "host-termux",
    allowDangerous: true,
    confirmDangerous: legacyOnlyConfirm,
    isBuild: true,
  };
  const routed = await execute("pwd", options, "embedded-private");
  assert.equal(routed, privateResult);
  assert.equal(legacyCalls.length, 0, "private success never touches the legacy backend");
  assert.deepEqual(privateCalls[0], {
    command: "pwd",
    options: {
      workdir: "/storage/emulated/0/AIBuilderTermux/project",
      timeoutMs: 3000,
      signal: controller.signal,
      trustedInternal: true,
      preserveOutput: true,
      traceId: "agent-private-route-test",
    },
  }, "cwd and supported execution controls are passed unchanged; legacy selectors/permissions are stripped");

  const privateFailure = new Error("PRIVATE_CWD_OUTSIDE_HOME");
  const failClosed = createAgentShellCommandExecutor(legacyExecutor, {
    execute: async () => { throw privateFailure; },
  });
  await assert.rejects(() => failClosed("pwd", options, "embedded-private"), (error) => error === privateFailure,
    "native/private errors propagate without external retry");
  assert.equal(legacyCalls.length, 0, "private rejection still never touches the legacy backend");

  assert.throws(() => execute("pwd", options, "selected-backend"), /AGENT_SHELL_EXTERNAL_TARGET_DISABLED/);
  assert.equal(legacyCalls.length, 0, "disabled external target must not call its legacy executor");
  assert.equal(privateCalls.length, 1);
  assert.throws(() => execute("pwd", options, "bad-target"), /AGENT_SHELL_TARGET_INVALID/);

  const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
  assert.match(agent, /executeAgentShellCommand\(effectiveCmd,[\s\S]{0,700}commandExecutionTarget\)/,
    "the production TERMUX_RUN call site must use the dispatcher and persisted target");
  assert.match(agent, /commandExecutionTarget === "selected-backend"\s*&&\s*!options\.isBuild\s*&&\s*!result\.timedOut\s*&&\s*shouldFallbackSharedStorageToHost/,
    "the shared-storage external retry is legacy-only");
  assert.match(agent, /commandExecutionTarget === "selected-backend"\s*&& isPkgMirrorFailure/,
    "automatic external mirror repair is legacy-only");
  assert.match(agent, /commandExecutionTarget === "selected-backend"\s*&&\s*result\.exitCode !== 0/,
    "build repair does not escape private mode");
  assert.match(agent, /backend: commandExecutionTarget === "embedded-private" \? "embedded-private"/,
    "trajectory records the actual private runtime identity");
  const runtimeUi = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
  assert.match(runtimeUi, /AIB_TOOL runtime\.status runs only the fixed read-only printf Bash probe/i,
    "the UI must disclose the deliberately narrow AIB_TOOL private probe");
  assert.match(runtimeUi, /workspace\.list separately exposes direct-child metadata for the exact AIBuilderTermux folder only after an explicit read-only SAF grant/i,
    "the UI must disclose the exact-root metadata-only shared-storage exception");
  assert.match(runtimeUi, /only registered typed GitHub API calls.*every create\/change\/merge\/comment requires a separate confirmation/i,
    "the UI must disclose typed GitHub API access and per-mutation confirmation");
  assert.match(runtimeUi, /rejected without another-backend dispatch/i,
    "the UI must disclose fail-closed behavior");
  assert.match(runtimeUi, /package auto-install/i,
    "the UI must disclose that dependency auto-install remains on the selected backend");
  assert.match(agent, /No verified private package-install route is available in this stage/,
    "missing-tool guidance must not claim private package installation support");

  const executor = fs.readFileSync(path.join(root, "lib/termux-executor.ts"), "utf8");
  assert.match(executor, /runEmbeddedTermuxCommand/);
  assert.doesNotMatch(executor, /runShellCommand\(commandNorm|resolveAgentExecutionBackend\(options/,
    "private command execution must not dispatch to an external selected backend");
  const bridge = fs.readFileSync(path.join(root, "lib/termux-bridge.ts"), "utf8");
  assert.match(bridge, /if \(!native\?\.runEmbeddedTermuxCommand\) throw new Error\("EMBEDDED_EXEC_UNAVAILABLE"\)/,
    "missing native private capability rejects instead of selecting another executor");
  const native = fs.readFileSync(path.join(root, "plugins/withTermuxBridge.js"), "utf8");
  assert.match(native, /val builder = ProcessBuilder\(AibEmbeddedTermuxBootstrapInstaller\.shellCommand\(prefix, "--noprofile", "--norc", "-c", wrapper, "aib-embedded", command, rootPidFile\.absolutePath\)\)\.directory\(requestedCwd\)/, "private route starts app-owned Bash through the API-compatible tracked launcher");
  assert.match(native, /!inPrivateHome && !inSharedWorkspace/,
    "native executor enforces private HOME or granted exact-workspace containment");
  assert.match(native, /awaitAibEmbeddedRootPid\(process!!, rootPidFile, 1_000L\)/,
    "private route validates an app-owned root PID before opening command execution");
  assert.match(native, /val code = embeddedExecFailureCode\(error, phase\)\s+promise\.reject\(code, embeddedExecFailureDetail\(error, phase\)\)/,
    "native private execution errors reject without a fallback call");

  console.log("AIB_AGENT_PRIVATE_SHELL_SELFTEST_OK target-persisted=1 production-callsite=1 private-native-branch=1 private-home-containment=1 no-termux-host-proot-fallback=1 supported-options-forwarded=1 legacy-options-stripped=1 private-error-fail-closed=1 external-disabled=1 package-install-unclaimed=1");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
