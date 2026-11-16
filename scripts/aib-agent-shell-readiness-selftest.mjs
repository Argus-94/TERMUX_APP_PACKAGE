#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs, setTsModuleMocks } from "./test-helpers/load-ts-module.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const readinessSource = fs.readFileSync(path.join(root, "lib/agent-shell-readiness.ts"), "utf8");
const agentSource = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
const runtimeUi = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");

let legacyCalls = [];
let privateCalls = [];
let privateResponse = {
  commandId: "ready-probe",
  stdout: "AIB_EMBEDDED_PRIVATE_SHELL_READY\n",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  outputTruncated: false,
};
let privateError = null;
const legacyResponse = {
  ready: true,
  reasons: [],
  probed: true,
  probeDetail: "legacy-probe-ok",
};
const defaultLegacyCalls = [];
const defaultPrivateCalls = [];
setTsModuleMocks("lib/agent-shell-readiness.ts", {
  "./termux-bridge": {
    checkTermuxReadiness: async (options) => {
      defaultLegacyCalls.push(options);
      return legacyResponse;
    },
  },
  "./private-runtime-provider": {
    privateRuntimeProvider: {
      execute: async (command, options) => {
        defaultPrivateCalls.push({ command, options });
        if (privateError) throw privateError;
        return privateResponse;
      },
    },
  },
});
const { createAgentShellReadinessChecker, checkAgentShellReadiness, PRIVATE_SHELL_READINESS_COMMAND } = loadTs("lib/agent-shell-readiness.ts");
const check = createAgentShellReadinessChecker({
  checkLegacyReadiness: async (options) => {
    legacyCalls.push(options);
    return legacyResponse;
  },
  executePrivateProbe: async (command, options) => {
    privateCalls.push({ command, options });
    if (privateError) throw privateError;
    return privateResponse;
  },
});

const privateReady = await check("embedded-private");
assert.deepEqual(privateReady, { target: "embedded-private", ready: true });
assert.equal(PRIVATE_SHELL_READINESS_COMMAND, "printf '%s\\n' 'AIB_EMBEDDED_PRIVATE_SHELL_READY'");
assert.deepEqual(privateCalls, [{
  command: PRIVATE_SHELL_READINESS_COMMAND,
  options: { timeoutMs: 5000, trustedInternal: true, preserveOutput: true },
}], "private readiness is a bounded, marker-checked probe through the private provider contract");
assert.equal(legacyCalls.length, 0, "private readiness never calls selected Termux readiness");

for (const [name, response, error, expectedReason] of [
  ["native rejection", null, new Error("EMBEDDED_EXEC_UNAVAILABLE"), "private_probe_rejected"],
  ["timeout", { ...privateResponse, timedOut: true }, null, "private_probe_timeout"],
  ["truncated output", { ...privateResponse, outputTruncated: true }, null, "private_probe_truncated"],
  ["nonzero exit", { ...privateResponse, exitCode: 127 }, null, "private_probe_failed"],
  ["missing marker", { ...privateResponse, stdout: "" }, null, "private_probe_failed"],
  ["malformed native result", null, null, "private_probe_failed"],
]) {
  privateResponse = response;
  privateError = error;
  const result = await check("embedded-private");
  assert.deepEqual(result, { target: "embedded-private", ready: false, reason: expectedReason }, `${name} blocks private startup`);
  assert.equal(legacyCalls.length, 0, `${name} does not fall back to Termux readiness`);
}

privateResponse = {
  commandId: "ready-probe",
  stdout: "AIB_EMBEDDED_PRIVATE_SHELL_READY\n",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  outputTruncated: false,
};
privateError = null;
const legacyReady = await check("selected-backend");
assert.deepEqual(legacyReady, { target: "selected-backend", ready: true, legacy: legacyResponse });
assert.deepEqual(legacyCalls, [{ deep: true, refreshPermission: true }], "legacy readiness receives its prior deep/refresh options unchanged");
assert.equal(privateCalls.length, 7, "legacy readiness never invokes private Bash");
await assert.rejects(() => check("invalid-target"), /AGENT_SHELL_TARGET_INVALID/);
assert.equal(legacyCalls.length, 1);
assert.equal(privateCalls.length, 7);

const defaultPrivateReady = await checkAgentShellReadiness("embedded-private");
assert.deepEqual(defaultPrivateReady, { target: "embedded-private", ready: true });
assert.equal(defaultPrivateCalls.length, 1, "the production checker uses the private runtime provider");
assert.equal(defaultLegacyCalls.length, 0, "the production private branch does not invoke Termux readiness");
const defaultLegacyReady = await checkAgentShellReadiness("selected-backend");
assert.equal(defaultLegacyReady.ready, true);
assert.deepEqual(defaultLegacyCalls, [{ deep: true, refreshPermission: true }]);

assert.match(agentSource, /import \{ checkAgentShellReadiness \} from "\.\/agent-shell-readiness"/,
  "agent startup imports target-aware readiness");
assert.match(agentSource, /const shellReadiness = await checkAgentShellReadiness\(commandExecutionTarget\)/,
  "the production agent startup uses the persisted shell target for readiness");
assert.match(agentSource, /executeAgentShellCommand\(portableProbe,[\s\S]{0,500}commandExecutionTarget\)/,
  "the portable archive recovery probe keeps the same target as TERMUX_RUN");
assert.match(agentSource, /commandExecutionTarget === "selected-backend" && isLinuxProotBackend\(\)/,
  "Ubuntu rootfs preflight remains only on legacy selected-backend startup");
assert.match(agentSource, /if \(commandExecutionTarget === "embedded-private"\) \{[\s\S]{0,300}AIB_AUTO_PKG_PREFLIGHT[\s\S]{0,300}skipped/s,
  "private startup records package preflight as skipped without running it");
assert.match(agentSource, /else if \(commandExecutionTarget === "selected-backend" && autoPkg\.command/,
  "the existing package auto-preflight remains on the selected-backend route only");
assert.doesNotMatch(readinessSource, /runShellCommand|hostTermux|proot-distro|runCommand\(/,
  "the private readiness helper has no external Termux/host/proot dispatch path");
assert.match(runtimeUi, /fixed read-only printf Bash probe/i,
  "runtime UI explains what private readiness actually verifies");
assert.match(runtimeUi, /No external readiness checks or package auto-install run/i,
  "runtime UI discloses that private startup readiness is private-only");
assert.match(runtimeUi, /package auto-install/i,
  "runtime UI keeps package installation boundaries explicit");

console.log("AIB_AGENT_SHELL_READINESS_SELFTEST_OK target-routing=1 private-native-probe=1 fail-closed=1 no-external-fallback=1 legacy-readiness-preserved=1 rootfs-gated=1 package-preflight-skipped=1 production-wiring=1 UI-disclosure=1");
