#!/usr/bin/env node
// Historical v389 filename: current autobuild contract is embedded-only and fail-closed;
// this test does not claim installers, repair recipes, or builds are available.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { wrapWithAutobuild, parseAutobuildResult, AUTOBUILD_DEFAULT_MAX_ATTEMPTS } from "../lib/autobuild.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(repo, "scripts/autobuild/aib-autobuild.sh");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v389-current-contract-"));
try {
  assert.equal(AUTOBUILD_DEFAULT_MAX_ATTEMPTS, 10);
  const markerOnly = parseAutobuildResult("AIB_AUTOBUILD_RESULT=ok\nAIB_AUTOBUILD_ATTEMPTS=1\n");
  assert.equal(markerOnly?.ok, true, "parser extracts the marker; runtime guard is tested independently");
  assert.equal(parseAutobuildResult("ordinary output"), null);
  assert.throws(() => wrapWithAutobuild({ backend: "termux", projectKind: "gradle", primaryCommand: "" }), /AUTOBUILD_PRIMARY_COMMAND_INVALID/);
  assert.throws(() => wrapWithAutobuild({ backend: "bad", projectKind: "gradle", primaryCommand: "true" }), /AUTOBUILD_BACKEND_INVALID/);
  const wrapped = wrapWithAutobuild({ backend: "termux", projectKind: "gradle", primaryCommand: `printf ran >> "${path.join(temp, "primary")}"; echo APK_PATH=/not-real.apk` });
  assert.match(wrapped, /AI_BUILDER_AUTOBUILD_ENGINE:v1/);
  const script = path.join(temp, "wrapped.sh");
  fs.writeFileSync(script, wrapped);
  assert.equal(spawnSync("bash", ["-n", script]).status, 0);

  const bin = path.join(temp, "bin"), calls = path.join(temp, "calls"), privateRoot = path.join(temp, "private-work");
  fs.mkdirSync(bin);
  for (const tool of ["mkdir", "pkg", "apt-get", "curl", "wget", "git", "java", "gradle", "sdkmanager"]) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nprintf '%s\\n' '${tool}' >> "$AIB_TEST_CALLS"\nexit 99\n`, { mode: 0o755 });
  }
  const tests = [
    { name: "foreign", env: { PREFIX: "/foreign/usr", HOME: "/foreign/home" }, reason: "AIB_PRIVATE_RUNTIME_REQUIRED" },
    { name: "app", env: { PREFIX: "/data/data/com.karat.aibuilder/files/usr", HOME: "/data/data/com.karat.aibuilder/files/home" }, reason: "AIB_PRIVATE_TOOLCHAIN_NOT_QUALIFIED" },
    { name: "no-env-bypass", env: { PREFIX: "", HOME: temp, AIB_AB_BACKEND: "ubuntu-proot", AIB_PRIVATE_FEED_QUALIFIED: "1" }, reason: "AIB_PRIVATE_RUNTIME_REQUIRED" },
  ];
  for (const test of tests) {
    fs.rmSync(calls, { force: true }); fs.rmSync(privateRoot, { recursive: true, force: true });
    const r = spawnSync("bash", [script], { encoding: "utf8", timeout: 5000, env: { PATH: `${bin}:/usr/bin:/bin`, ...test.env, AIB_TEST_CALLS: calls, AIB_PRIVATE_ROOT: privateRoot } });
    assert.equal(r.status, 78, `${test.name}: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, new RegExp(test.reason));
    assert.equal(fs.existsSync(calls), false, `${test.name}: no package/download/primary tool invocation`);
    assert.equal(fs.existsSync(privateRoot), false, `${test.name}: no private workspace/cache writes`);
    assert.equal(fs.existsSync(path.join(temp, "primary")), false, `${test.name}: primary command not executed`);
    assert.equal(parseAutobuildResult(`${r.stdout}\n${r.stderr}`), null, "guard rejection must not be interpreted as successful marker output");
  }
  const generated = spawnSync(process.execPath, ["scripts/aib-gen-autobuild.mjs", "--check"], { cwd: repo, encoding: "utf8", env: { ...process.env, TMPDIR: "/dev/shm" } });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  console.log("AIB_V389_AUTOBUILD_SELFTEST_OK current_contract=fail_closed wrapped_runtime_cases=3 invalid_args=true parser=true generated_in_sync=true installers=NOT_CLAIMED builds=NOT_RUN");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
