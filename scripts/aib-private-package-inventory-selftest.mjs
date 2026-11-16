#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createPrivatePackageInventoryTool,
  PRIVATE_PACKAGE_QUERY_MAX_LIMIT,
  PRIVATE_PACKAGE_QUERY_MAX_OUTPUT_BYTES,
  PRIVATE_PACKAGE_QUERY_TIMEOUT_MS,
  validatePrivatePackageInventoryArgs,
} from "../lib/private-package-inventory.ts";
import { privateAgentToolUnsupportedReason } from "../lib/agent-private-tool-policy.ts";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const bridge = read("plugins/withTermuxBridge.js");
const bridgeTs = read("lib/termux-bridge.ts");
const tool = read("lib/agent-tools/runtime/packages.ts");
const dispatcher = read("lib/agent-tools/index.ts");
const types = read("lib/agent-tools/types.ts");
const packagePolicy = read("lib/agent-private-tool-policy.ts");
const agentPrompt = read("lib/agent-engine.ts");
const nativeStart = bridge.indexOf("fun queryEmbeddedTermuxPackages(");
const nativeEnd = bridge.indexOf("fun cancelEmbeddedTermuxCommand(", nativeStart);
assert.ok(nativeStart >= 0 && nativeEnd > nativeStart, "dedicated native package query method must exist");
const native = bridge.slice(nativeStart, nativeEnd);

assert.equal(PRIVATE_PACKAGE_QUERY_MAX_LIMIT, 100);
assert.equal(PRIVATE_PACKAGE_QUERY_MAX_OUTPUT_BYTES, 32 * 1024);
assert.equal(PRIVATE_PACKAGE_QUERY_TIMEOUT_MS, 5_000);
assert.equal(validatePrivatePackageInventoryArgs({}), null);
assert.equal(validatePrivatePackageInventoryArgs({ name: "python", limit: 100 }), null);
for (const name of ["", "Python", "../bash", "bash;id", "a b", "-n", "x".repeat(129), "foo?*"]) {
  assert.equal(validatePrivatePackageInventoryArgs({ name }), "AIB_PRIVATE_PACKAGE_NAME_INVALID", `reject unsafe name: ${name}`);
}
for (const limit of [0, 101, 1.5, "50", -1, Number.MAX_SAFE_INTEGER]) {
  assert.equal(validatePrivatePackageInventoryArgs({ limit }), "AIB_PRIVATE_PACKAGE_LIMIT_INVALID");
}
assert.equal(validatePrivatePackageInventoryArgs({ name: "bash", timeoutMs: 999_999 }), "AIB_PRIVATE_PACKAGE_QUERY_ARGS_UNSUPPORTED");

let calls = 0;
const makeTool = (resultOrFn) => createPrivatePackageInventoryTool(async (name, limit) => {
  calls += 1;
  assert.equal(limit >= 1 && limit <= 100, true);
  return typeof resultOrFn === "function" ? resultOrFn(name, limit) : resultOrFn;
});
const privateContext = { executionTarget: "embedded-private" };
const installedTool = makeTool({ stdout: "bash\t5.2.37\tinstalled\n", stderr: "", exitCode: 0, timedOut: false, outputTruncated: false });
assert.equal((await installedTool.execute({ name: "bash" }, privateContext)).packages[0].status, "installed");
assert.equal((await installedTool.execute({ name: "bash" }, privateContext)).complete, true);
const afterInstalledCalls = calls;
await assert.rejects(() => installedTool.execute({}, { executionTarget: "selected-backend" }), /AIB_PRIVATE_PACKAGE_QUERY_PRIVATE_TARGET_REQUIRED/);
assert.equal(calls, afterInstalledCalls, "non-private target must be rejected before any native query");
assert.equal(privateAgentToolUnsupportedReason("runtime.packages", "embedded-private"), null);
assert.match(packagePolicy, /"runtime\.packages"/);
assert.match(tool, /queryEmbeddedTermuxPackages/);
assert.match(types, /"runtime\.packages"/);
assert.match(dispatcher, /"runtime\.packages": \{ validate: runtimePackages\.validate, execute: runtimePackages\.execute \}/);
assert.match(agentPrompt, /\{"tool":"runtime\.packages","args":\{"limit":50\}\}/, "the Agent prompt exposes a bounded read-only invocation example");

const missingTool = makeTool({ stdout: "", stderr: "dpkg-query: no packages found matching imaginary-package", exitCode: 1, timedOut: false, outputTruncated: false });
const missing = await missingTool.execute({ name: "imaginary-package" }, privateContext);
assert.equal(missing.ok, true);
assert.equal(missing.packages[0].status, "not-installed");

const unknownTool = makeTool({ stdout: "futurepkg\t1.2.3\tfuture-state\n", stderr: "", exitCode: 0, timedOut: false, outputTruncated: false });
const unknown = await unknownTool.execute({ name: "futurepkg" }, privateContext);
assert.equal(unknown.packages[0].status, "unknown", "unrecognized dpkg status is not promoted to installed");

const truncatedTool = makeTool({ stdout: "bash\t5.2.37\tinstalled\npartial-row", stderr: "", exitCode: 0, timedOut: false, outputTruncated: true });
const truncated = await truncatedTool.execute({}, privateContext);
assert.equal(truncated.ok, true);
assert.equal(truncated.complete, false);
assert.equal(truncated.truncated, true);
assert.deepEqual(truncated.packages.map((entry) => entry.name), ["bash"], "partial trailing row is discarded");

const errorTool = makeTool({ stdout: "", stderr: "dpkg database corrupted", exitCode: 2, timedOut: false, outputTruncated: false });
assert.deepEqual(await errorTool.execute({}, privateContext), { ok: false, error: "AIB_PRIVATE_PACKAGE_QUERY_FAILED", source: "embedded-private" });
const timeoutTool = makeTool({ stdout: "", stderr: "", exitCode: 124, timedOut: true, outputTruncated: false });
assert.equal((await timeoutTool.execute({}, privateContext)).error, "AIB_PRIVATE_PACKAGE_QUERY_TIMEOUT");
const unavailableTool = createPrivatePackageInventoryTool(async () => { throw new Error("AIB_PRIVATE_PACKAGE_QUERY_REGISTRY_UNAVAILABLE"); });
assert.equal((await unavailableTool.execute({}, privateContext)).error, "AIB_PRIVATE_PACKAGE_QUERY_REGISTRY_UNAVAILABLE");
const invalidResultTool = makeTool({ stdout: "bad row", stderr: "", exitCode: 0, timedOut: false, outputTruncated: false });
assert.equal((await invalidResultTool.execute({}, privateContext)).error, "AIB_PRIVATE_PACKAGE_QUERY_OUTPUT_INVALID");

assert.match(bridgeTs, /queryEmbeddedTermuxPackages\(name: string \| null, limit: number\)/);
assert.match(bridgeTs, /AIB_PRIVATE_PACKAGE_QUERY_UNAVAILABLE/);
assert.match(native, /val \(prefix, home, _\) = validatedEmbeddedRuntimeLayout\(\)/, "prefix must come from the validated app-private layout");
assert.match(bridge, /val prefixExpected = File\(files, "usr"\)\s+val homeExpected = File\(files, "home"\)/, "the existing runtime stores HOME beside PREFIX/usr");
assert.match(native, /val expectedPrivateHome = File\(prefix\.parentFile, "home"\)/);
assert.match(native, /home\.canonicalPath != expectedPrivateHome\.absolutePath/);
assert.doesNotMatch(native, /File\(prefix, "home"\)/, "HOME must not be derived as a child of PREFIX");
assert.match(native, /File\(prefix, "bin\/dpkg-query"\)/, "the executable is resolved from the actual private prefix");
assert.match(native, /File\(prefix, "var\/lib\/dpkg"\)/);
assert.match(native, /File\(dpkgDatabase, "status"\)/);
assert.match(native, /dpkgQuery\.absolutePath[\s\S]*?"--show"[\s\S]*?"--showformat="/);
assert.match(native, /AibEmbeddedTermuxBootstrapInstaller\.shellCommand\([\s\S]*?rootPidFile\.absolutePath, \*argv\.toTypedArray\(\)/);
assert.match(native, /env\.clear\(\)/);
assert.match(native, /env\.putAll\(AibEmbeddedTermuxBootstrapInstaller\.executionEnvironment\(reactApplicationContext, prefix, home, tempDir\)\)/);
const launchEnvironment = read("plugins/termuxBootstrapInstallerKotlin.js");
for (const token of ['"HOME" to home.absolutePath', '"PREFIX" to prefix.absolutePath', '"TERMUX_PREFIX" to prefix.absolutePath', '"PATH" to', '"LD_LIBRARY_PATH" to File(prefix, "lib").absolutePath']) assert.ok(launchEnvironment.includes(token), token);
assert.match(native, /awaitAibEmbeddedRootPid\(process!!, rootPidFile, 1_000L\)/);
assert.match(native, /waitForAibEmbeddedProcess\(process!!, 5_000L, processRoot!!, trackedDescendants\)/);
assert.match(native, /captureAibEmbeddedPackageOutput\(process!!\.inputStream, 32 \* 1024, limit\.toInt\(\)\)/);
assert.match(native, /captureAibEmbeddedPackageOutput\(process!!\.errorStream, 4 \* 1024, 8\)/);
assert.doesNotMatch(native, /\/data\/data\/com\.|com\.termux|runEmbeddedTermuxCommand|runCommand\(|proot|RUN_COMMAND|apt-get|pkg install/i);
assert.doesNotMatch(native, /FileOutputStream|writeText\(|mkdirs?\(|renameTo\(|installPackage/i, "native inventory query must not write to the dpkg registry or install");
assert.match(native, /File\.createTempFile\("aib-package-query-pid-/);
assert.match(native, /pidFile\?\.delete\(\)/, "only its private PID handshake file is deleted during cleanup");
assert.match(native, /promise\.reject\(code, code\)/, "native failures preserve stable typed error codes");
assert.match(bridge, /queryEmbeddedTermuxPackages\(name: String\?, limit: Double, promise: Promise\)/);

const bootstrap = path.join(root, "assets/termux-bootstrap/termux-bootstrap-aarch64.zip");
const listing = spawnSync("unzip", ["-Z1", bootstrap], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
assert.equal(listing.status, 0, "bundled private bootstrap asset can be inspected without installation");
const members = new Set(listing.stdout.split(/\r?\n/).filter(Boolean));
assert.ok(members.has("bin/dpkg-query"), "bundled bootstrap has the fixed package query executable");
assert.ok(members.has("var/lib/dpkg/status"), "bundled bootstrap has a private dpkg status database");

console.log("AIB_PRIVATE_PACKAGE_INVENTORY_SELFTEST_OK private-only=1 fixed-argv=1 package-regex=1 bounds=1 fixtures=installed+missing+unknown+error+timeout+truncated no-fallback=1 no-mutation=1 bootstrap-query+status=1");
