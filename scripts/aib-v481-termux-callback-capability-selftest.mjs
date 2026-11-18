#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classifyTermuxRunCommandCallbackSupport, termuxRunCommandCallbackRequirementMessage } from "../lib/termux-run-command-callback.ts";
import { redactPersistentLogPayload } from "../lib/log-redaction.ts";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const pkg = JSON.parse(read("package.json"));
const appConfig = read("app.config.ts");
const bridge = read("lib/termux-bridge.ts");
const nativePlugin = read("plugins/withTermuxBridge.js");
const context = read("components/TermuxContext.tsx");

assert.equal(pkg.version, "1.10.113", "current source release is v513");
assert.match(appConfig, /versionCode:\s*513/);
// Capability and readiness are intrinsic to embedded runtime; no package-version gate or external probe.
assert.match(bridge, /runEmbeddedTermuxCommand/);
assert.match(bridge, /EMBEDDED_EXEC_UNAVAILABLE/);
assert.match(bridge, /getEmbeddedTermuxRuntimeStatus/);
assert.doesNotMatch(bridge, /classifyTermuxRunCommandCallbackSupport\(termuxVersion\)|getPackageVersion\("com\.termux"\)/);
assert.doesNotMatch(nativePlugin, /com\.termux\.permission\.RUN_COMMAND|RUN_COMMAND_PENDING_INTENT/);
assert.match(bridge, /externalTermuxPrivateData=not-accessed/);
assert.match(bridge, /workspaceRootAccess=not-performed/);
assert.match(nativePlugin, /getRuntimeDiagnosticPaths/);
const pathMethodStart = nativePlugin.indexOf("fun getRuntimeDiagnosticPaths(");
const pathMethodEnd = nativePlugin.indexOf("fun canInstallPackages(", pathMethodStart);
assert.ok(pathMethodStart >= 0 && pathMethodEnd > pathMethodStart, "native diagnostic method must be present");
const pathMethod = nativePlugin.slice(pathMethodStart, pathMethodEnd);
assert.doesNotMatch(pathMethod, /com\.termux|FileInputStream|readText\(|listFiles\(|canonicalFile|\.exists\(|\.isDirectory/);

const safeLog = redactPersistentLogPayload(
  "TermuxSmoke",
  "appDataDir=/data/user/0/com.karat.aibuilder filesDir=/data/user/0/com.karat.aibuilder/files embeddedPrefix=/data/user/0/com.karat.aibuilder/files/usr workspaceRoot=/storage/emulated/0/AIBuilderTermux externalPath=/data/data/com.termux/files/home apiKey=should-not-appear uri=https://example.invalid/private?q=1",
);
assert.ok(safeLog.includes("/data/user/0/com.karat.aibuilder"), "AI Builder-owned app data path should remain diagnosable");
assert.ok(safeLog.includes("/data/user/0/com.karat.aibuilder/files/usr"), "AI Builder embedded prefix should remain diagnosable");
assert.ok(safeLog.includes("/storage/emulated/0/AIBuilderTermux"), "the configured workspace root may be recorded without accessing it");
assert.ok(!safeLog.includes("/data/data/com.termux/files/home"), "external Termux private path must remain redacted");
assert.ok(!safeLog.includes("should-not-appear"), "credentials must remain redacted");
assert.ok(!safeLog.includes("https://example.invalid"), "full URIs must remain redacted");

console.log("AIB_V486_EMBEDDED_CAPABILITY_SELFTEST_OK no_version_gate=1 no_external_probe=1 missing_capability_fail_closed=1 app_owned_paths_logged=1 external_termux_private_data=untouched redaction=1");
