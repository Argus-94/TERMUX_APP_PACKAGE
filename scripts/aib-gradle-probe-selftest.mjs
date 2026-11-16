// v406: gradle --version prints a blank first line; the toolchain probe must skip it
// (previously "head -1" produced an empty string -> gradle=BROKEN:no-version-output).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildAndroidToolchainCommand } = await import(path.join(root, "lib/android-toolchain-script.ts"));
const agentSrc = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
assert.ok(!/gradle --version 2>&1 \| head -1\); if \[ -n/.test(agentSrc), "termux-agent ENV probe must not use head -1 for gradle");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-gradle-"));
fs.writeFileSync(path.join(dir, "gradle"), '#!/bin/sh\necho\necho "------"\necho "Gradle 8.10.2"\necho "------"\n', { mode: 0o755 });
const script = buildAndroidToolchainCommand("termux");
assert.equal(spawnSync("bash", ["-n"], { input: script }).status, 0, "generated probe must pass bash -n");
const run = spawnSync("bash", ["-c", script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
assert.match(run.stdout, /gradle=OK:path=/, `gradle must be OK with blank first line, got: ${run.stdout}`);
assert.doesNotMatch(run.stdout, /gradle=BROKEN/);
fs.rmSync(dir, { recursive: true, force: true });
console.log("AIB_GRADLE_PROBE_SELFTEST_OK blank_first_line=skipped");
