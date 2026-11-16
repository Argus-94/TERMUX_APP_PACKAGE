#!/usr/bin/env node
// Historical v409 filename: current generated wrapped build script is fail-closed;
// no simulated installer, repair, successful build, or APK claim is made.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { wrapWithAutobuild, parseAutobuildResult } from "../lib/autobuild.ts";
import { buildProjectBuildRunnerContent } from "../lib/project-build-runner.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v409-runner-boundary-"));
try {
  assert.deepEqual(parseAutobuildResult("AIB_AUTOBUILD_RESULT=failed\nAIB_AUTOBUILD_ATTEMPTS=0\nAIB_AUTOBUILD_NEEDS_LLM=0\n"), {
    ok: false, attempts: 0, fixes: [], needsLlm: false, firstError: "", historyLog: "",
  });
  assert.equal(parseAutobuildResult("no result markers"), null);
  assert.throws(() => buildProjectBuildRunnerContent({ projectRoot: temp, projectName: "demo", projectKind: "gradle", backend: "termux", variant: "debug", command: "" }), /PROJECT_BUILD_RUNNER_COMMAND_INVALID/);

  const calls = path.join(temp, "calls"), privateRoot = path.join(temp, "private-work"), primary = path.join(temp, "primary-called");
  const generatedScript = wrapWithAutobuild({ backend: "termux", projectKind: "gradle", primaryCommand: `printf ran >> "${primary}"` });
  const scriptPath = path.join(temp, "generated-build-runner.sh"); fs.writeFileSync(scriptPath, generatedScript);
  assert.equal(spawnSync("bash", ["-n", scriptPath]).status, 0);
  const bin = path.join(temp, "bin"); fs.mkdirSync(bin);
  for (const tool of ["mkdir", "pkg", "apt-get", "curl", "wget", "git", "java", "gradle", "sdkmanager"]) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nprintf '%s\\n' '${tool}' >> "$AIB_TEST_CALLS"\nexit 99\n`, { mode: 0o755 });
  }
  const cases = [
    { tag: "foreign", env: { PREFIX: "/foreign/private/usr", HOME: "/foreign/private/home" }, marker: "AIB_PRIVATE_RUNTIME_REQUIRED" },
    { tag: "app", env: { PREFIX: "/data/user/0/com.karat.aibuilder/files/usr", HOME: "/data/user/0/com.karat.aibuilder/files/home" }, marker: "AIB_PRIVATE_TOOLCHAIN_NOT_QUALIFIED" },
    { tag: "no-env-bypass", env: { PREFIX: "", HOME: temp, AIB_AB_BACKEND: "ubuntu-proot", AIB_PRIVATE_FEED_QUALIFIED: "1" }, marker: "AIB_PRIVATE_RUNTIME_REQUIRED" },
  ];
  for (const c of cases) {
    fs.rmSync(calls, { force: true }); fs.rmSync(privateRoot, { recursive: true, force: true });
    const r = spawnSync("bash", [scriptPath], { encoding: "utf8", timeout: 5000, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: c.env.HOME, PREFIX: c.env.PREFIX, AIB_PRIVATE_ROOT: privateRoot, AIB_TEST_CALLS: calls, AIB_AB_BACKEND: "ubuntu-proot", AIB_PRIVATE_FEED_QUALIFIED: "1" } });
    const output = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 78, `${c.tag}: ${output}`);
    assert.match(output, new RegExp(c.marker));
    assert.equal(fs.existsSync(calls), false, `${c.tag}: no package/download/primary external tool invocation`);
    assert.equal(fs.existsSync(privateRoot), false, `${c.tag}: no private workspace/cache writes`);
    assert.equal(fs.existsSync(primary), false, `${c.tag}: primary command not invoked`);
    assert.equal(parseAutobuildResult(output), null, `${c.tag}: boundary marker is not autobuild success`);
  }
  console.log("AIB_V409_RUNNER_E2E_SELFTEST_OK current_contract=fail_closed generated_wrapped_script_cases=3 no_write_or_package_download_primary=true no_env_bypass=true markers_not_success=true builds=NOT_RUN");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
