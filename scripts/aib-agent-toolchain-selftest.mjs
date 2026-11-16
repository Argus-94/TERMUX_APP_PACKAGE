#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const engine = fs.readFileSync(path.join(root, "lib/agent-engine.ts"), "utf8");
const scriptSource = fs.readFileSync(path.join(root, "lib/android-toolchain-script.ts"), "utf8");
const { buildAndroidToolchainCommand } = loadRuntimeTs(path.join(root, "lib/android-toolchain-script.ts"));
assert.match(engine, /buildAndroidToolchainCommand\(backend\)/, "ensureAndroidToolchain must pass the selected backend to the tested production builder");
assert.doesNotMatch(`${engine}\n${scriptSource}`, /gradle\s+wrapper\s+--gradle-version/, "no unpinned wrapper download");
assert.doesNotMatch(`${engine}\n${scriptSource}`, /pkg install -y android-sdk/, "no mutable android-sdk package install");
assert.doesNotMatch(`${engine}\n${scriptSource}`, /pkg install -y gradle/, "project wrapper remains primary; no system Gradle package install");
assert.match(scriptSource, /sdk_dir=MISSING/, "SDK missing marker remains explicit");
assert.match(scriptSource, /sdk_platforms=MISSING/, "SDK platform missing marker remains explicit");
assert(engine.includes("!/^sdk_dir=(?:MISSING|UNTRUSTED)$/m.test(log)"), "toolchain ok-state rejects missing or untrusted SDK");
assert(engine.includes("const sdkOk = /^sdk_platforms=OK:\\S+$/m.test(log) && /^aapt2=OK:\\S+$/m.test(log);"),
  "toolchain ok-state requires both a platform jar and aapt2");

const generatedShell = buildAndroidToolchainCommand();
const bashSyntax = spawnSync("bash", ["-n"], { input: generatedShell, encoding: "utf8" });
assert.equal(bashSyntax.status, 0, `generated ensureAndroidToolchain shell must pass bash -n: ${bashSyntax.stderr}`);
assert.doesNotMatch(generatedShell, /then;\s*(?:if|[A-Za-z_])/, "control-flow blocks must not be joined with then;");
const ubuntuShell = buildAndroidToolchainCommand("ubuntu-proot");
const ubuntuSyntax = spawnSync("bash", ["-n"], { input: ubuntuShell, encoding: "utf8" });
assert.equal(ubuntuSyntax.status, 0, `generated Ubuntu toolchain shell must pass bash -n: ${ubuntuSyntax.stderr}`);
assert.match(ubuntuShell, /unset PREFIX/);
assert.match(ubuntuShell, /\/usr\/lib\/android-sdk/);
assert.doesNotMatch(ubuntuShell, /\/data\/data\/com\.termux|\$PREFIX\/opt\/aibuilder-toolpack|\$PREFIX\/opt\/android-sdk/, "Ubuntu probes only Ubuntu guest tool paths");
console.log("AIB_AGENT_TOOLCHAIN_SELFTEST_OK generated_shell_bash_n=PASS fail_closed_sdk=1 backend_scoped=1");
