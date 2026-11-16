#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { getCurrentTermuxSetupIssues } = loadRuntimeTs(path.join(root, "lib/termux-setup-evidence.ts"));
const { classifyDiagnosticError, isExplicitTermuxExternalAppsFalse } = loadRuntimeTs(path.join(root, "lib/diagnostic-trace.ts"));
const { inspectProotRuntimeReadiness } = loadRuntimeTs(path.join(root, "lib/runtime-environment-check.ts"));
const SESSION = "app-current";

function trace(timestamp, fields, sessionId = SESSION) {
  return {
    id: `log-${timestamp}-${Math.random().toString(36).slice(2, 6)}`,
    level: fields.status === "failed" || fields.status === "blocked" ? "warn" : "info",
    tag: "Trace",
    message: JSON.stringify({
      eventId: `evt-${timestamp}-fixture`,
      correlationId: fields.correlationId ?? `corr-${timestamp}`,
      action: fields.action ?? "command.shell-command",
      step: fields.step ?? "android.run-command-permission-check",
      status: fields.status ?? "succeeded",
      backend: fields.backend ?? "termux",
      target: fields.target ?? "termux",
      screen: fields.screen ?? "termux",
      ...fields,
    }),
    timestamp,
    sessionId,
    source: fields.backend === "ubuntu-proot" ? "linux" : "termux",
  };
}

function issues(...entries) {
  return getCurrentTermuxSetupIssues(entries.sort((a, b) => b.timestamp - a.timestamp));
}

const missing = trace(10, { correlationId: "cmd-missing", commandId: "js-missing", androidRunCommand: "missing", termuxExternalApps: "not-observed" });
assert.deepEqual(issues(missing), ["android-run-command-missing"], "a fresh explicit Android missing observation is actionable");

const granted = trace(20, { correlationId: "cmd-granted", commandId: "js-granted", androidRunCommand: "granted", termuxExternalApps: "not-observed" });
assert.deepEqual(issues(granted), [], "explicit grant is not shown as missing");

const unknownAfterMissing = trace(11, { correlationId: "cmd-missing", commandId: "js-missing", androidRunCommand: "unknown", termuxExternalApps: "not-observed" });
assert.deepEqual(issues(missing, unknownAfterMissing), [], "a newer unknown permission check is neutral, not a stale actionable denial");

const explicitFalse = trace(30, { correlationId: "external-denied", commandId: "js-external-denied", action: "command.shell-command", step: "bridge.command-result", status: "failed", errorCategory: "external-apps-disabled", termuxExternalApps: "blocked" });
assert.deepEqual(issues(explicitFalse), ["allow-external-apps-disabled"], "explicitly observed external-apps false is actionable");

const unobserved = trace(31, { correlationId: "external-unknown", commandId: "js-external-unknown", action: "command.shell-command", step: "bridge.command-result", status: "succeeded", exitCode: 0, termuxExternalApps: "not-observed" });
assert.deepEqual(issues(unobserved), [], "successful command with not-observed does not claim the setting is false");
assert.deepEqual(issues(trace(32, { correlationId: "external-unknown", action: "command.shell-command", step: "bridge.command-result", status: "failed", termuxExternalApps: "unknown" })), [], "unknown external-app state is neutral");
assert.deepEqual(issues(trace(33, { correlationId: "external-allowed", action: "command.shell-command", step: "bridge.command-result", status: "succeeded", termuxExternalApps: "allowed" })), [], "explicit allowed state does not raise a setup banner");

const staleExternalSuccess = trace(40, { correlationId: "fresh-command", commandId: "js-fresh-command", action: "command.shell-command", step: "bridge.command-result", status: "succeeded", exitCode: 0, termuxExternalApps: "not-observed" });
assert.deepEqual(issues(explicitFalse, staleExternalSuccess), [], "a later Termux result generation supersedes stale external-app denial with neutral observed status");
assert.deepEqual(issues(staleExternalSuccess, trace(41, { correlationId: "later-denial", commandId: "js-later-denial", action: "command.shell-command", step: "bridge.command-result", status: "failed", termuxExternalApps: "blocked" })), ["allow-external-apps-disabled"], "a denial newer than a successful result remains visible");

const unrelatedSuccess = trace(50, { correlationId: "other-target", commandId: "js-other-target", action: "runtime.check", step: "readiness.result", status: "succeeded", backend: "ubuntu-proot", target: "ubuntu", resultCode: "ready" });
assert.deepEqual(issues(missing, unrelatedSuccess), ["android-run-command-missing"], "a success from another backend/correlation cannot erase a current Android permission denial");
const termuxSuccessWithoutPermissionRead = trace(51, { correlationId: "other-termux-command", commandId: "js-other-termux-command", action: "command.shell-command", step: "bridge.command-result", status: "succeeded", exitCode: 0, termuxExternalApps: "not-observed" });
assert.deepEqual(issues(missing, termuxSuccessWithoutPermissionRead), ["android-run-command-missing"], "command success alone does not impersonate an Android permission check");
assert.deepEqual(issues(missing, granted), [], "a fresh, explicit grant in a later command generation clears the old denial");

const oldSessionMissing = trace(60, { correlationId: "old-session", commandId: "js-old", androidRunCommand: "missing" }, "app-old");
const currentSessionPlainWarning = { timestamp: 70, sessionId: SESSION, tag: "TermuxPermission", message: "RUN_COMMAND_PERMISSION_MISSING" };
assert.deepEqual(issues(oldSessionMissing, currentSessionPlainWarning), [], "an old session or plain warning text is not fresh structured evidence");

const policyBlockedReadiness = await inspectProotRuntimeReadiness("ubuntu-proot", {
  run: async () => { throw new Error("BLOCKED_BY_APP: Blocked: output target is outside trusted roots: $LIST_FILE"); },
});
assert.equal(policyBlockedReadiness.reason, "command-failed", "a pre-dispatch application policy rejection is not a missing native callback");
assert.match(policyBlockedReadiness.detail, /application command policy blocked the probe/);
assert.doesNotMatch(policyBlockedReadiness.detail, /\$LIST_FILE/, "readiness classification does not echo a private implementation path");

assert.equal(isExplicitTermuxExternalAppsFalse("Termux rejected RUN_COMMAND; allow-external-apps=false"), true);
assert.equal(isExplicitTermuxExternalAppsFalse("Please check allow-external-apps=true"), false);
assert.equal(isExplicitTermuxExternalAppsFalse("allow-external-apps was mentioned but not observed"), false);
assert.equal(classifyDiagnosticError("allow-external-apps=false"), "external-apps-disabled");
assert.equal(classifyDiagnosticError("Please check allow-external-apps=true"), "unknown");

const logScreen = fs.readFileSync(path.join(root, "app/log-screen.tsx"), "utf8");
const bridge = fs.readFileSync(path.join(root, "lib/termux-bridge.ts"), "utf8");
const readiness = fs.readFileSync(path.join(root, "lib/runtime-environment-check.ts"), "utf8");
const i18n = fs.readFileSync(path.join(root, "lib/i18n.ts"), "utf8");
assert.match(logScreen, /const recent = logs\.slice\(0, 120\)/, "banner scans newest-first logs, not the oldest prefix");
assert.match(logScreen, /getCurrentTermuxSetupIssues\(logs\)/, "the production log banner uses structured fresh evidence");
assert.doesNotMatch(logScreen, /probeOnly|reverse\(\)\.slice\(0, 120\)/, "unknown text and old warnings cannot be promoted to setup banners");
assert.match(bridge, /isExplicitTermuxExternalAppsFalse\(msg\) \? "blocked" : "not-observed"/);
assert.match(bridge, /const deniedExternalApps = isExplicitTermuxExternalAppsFalse\(raw\)/, "deep readiness accepts only an explicit false setting");
assert.match(bridge, /const isSetup = isAndroidRunCommandPermissionDenied\(msg\) \|\| isExplicitTermuxExternalAppsFalse\(msg\)/, "unknown exceptions are not elevated into setup warnings");
assert.equal(bridge.includes("allow[-_ ]external[-_ ]apps/i"), false, "the production bridge has no broad external-app mention heuristic");
assert.match(bridge, /hintKey: "termuxReasonUnknown"/);
assert.match(readiness, /if \(\/BLOCKED_BY_APP:\/i\.test\(text\)\) return "command-failed"/);
assert.doesNotMatch(i18n, /termuxReasonProbeFailed: [^\n]*allow-external-apps=true/, "unknown probe errors do not instruct users to change Termux settings");
assert.equal((i18n.match(/termuxReasonExternalAppsDisabled:/g) || []).length, 3, "all locales contain the explicit-false-only guidance");
assert.equal((i18n.match(/termuxReasonUnknown:/g) || []).length, 3, "all locales keep unknown states neutral");

console.log("AIB_V281_TERMUX_EVIDENCE_SELFTEST_OK explicit-missing/granted/unknown=PASS explicit-false-only=PASS stale-session/generation=PASS mixed-correlations=PASS banner-freshness=PASS");
