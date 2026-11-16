#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { redactBuildDiagnostics } from "../lib/log-redaction.ts";
import { getBuiltinBuildScript } from "../lib/builtin-build-script.ts";

const token = "ghp_" + "A".repeat(24);
const projectRoot = "/storage/emulated/0/AIBuilderTermux/projects/private-repository";
const pemBegin = "-----BEGIN " + "PRIVATE KEY-----";
const pemEnd = "-----END " + "PRIVATE KEY-----";
const raw = [
  `authorization: Bearer ${token}`,
  `OPENROUTER_API_KEY=${token}`,
  `${projectRoot}/android/app/build.gradle:42: error: synthetic failure`,
  "/home/alice/secret-project/app/src/Main.kt:19: error: synthetic failure",
  "/data/data/com.termux/files/home/private-project/.gradle/logs/gradle.log",
  pemBegin,
  "TEST ONLY PRIVATE MATERIAL",
  pemEnd,
].join("\n");

const safe = redactBuildDiagnostics(raw, projectRoot);
for (const secret of [token, "private-repository", "alice", "secret-project", "com.termux", "private-project", "TEST ONLY PRIVATE MATERIAL"]) {
  assert.equal(safe.includes(secret), false, `diagnostics retained protected content: ${secret}`);
}
assert.match(safe, /\[PROJECT_ROOT\]\/android\/app\/build\.gradle:42/);
assert.match(safe, /\[REDACTED_PRIVATE_KEY\]/);
assert.match(safe, /synthetic failure/);

const buildLoop = fs.readFileSync(new URL("../lib/build-loop.ts", import.meta.url), "utf8");
assert.match(buildLoop, /import \{ redactBuildDiagnostics \} from "\.\/log-redaction"/);
assert.match(buildLoop, /const rawLog =/);
assert.match(buildLoop, /let log = redactBuildDiagnostics\(rawLog, projectPath\)/);
assert.match(buildLoop, /Credential- and path-redacted build log tail/);

const generated = getBuiltinBuildScript();
assert.ok(generated.includes("redact_build_output() {"), "built-in script must define its streaming redactor");
assert.ok(generated.includes('2>&1 | redact_build_output | tee "$GRADLE_LOG"'), "Gradle output must be sanitized before persistence and display");
assert.ok(!generated.includes('2>&1 | tee "$GRADLE_LOG"'), "raw Gradle output must never be written directly to the persistent log");
const start = generated.indexOf("redact_build_output() {");
const end = generated.indexOf("\nlog() {", start);
assert.ok(start >= 0 && end > start, "generated redactor function must be extractable for a shell behavior test");
const redactor = generated.slice(start, end) + "\nredact_build_output";
const shell = spawnSync("/bin/sh", ["-c", redactor], { input: raw, encoding: "utf8", timeout: 5000 });
assert.equal(shell.status, 0, shell.stderr);
for (const secret of [token, "private-repository", "alice", "secret-project", "com.termux", "private-project", "TEST ONLY PRIVATE MATERIAL"]) {
  assert.equal(shell.stdout.includes(secret), false, `built-in script log retained protected content: ${secret}`);
}
assert.match(shell.stdout, /REDACTED/);
console.log("AIB_BUILD_LOG_PRIVACY_SELFTEST_OK tokens=redacted private_keys=redacted private_paths=redacted recovery=redacted");
