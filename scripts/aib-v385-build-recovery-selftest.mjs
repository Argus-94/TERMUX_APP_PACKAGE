#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { buildMissingCommandRecoveryInstruction, buildPortableArchiveProbeCommand, detectMissingShellCommand } = await import("../lib/termux-command-recovery.ts");

assert.equal(
  detectMissingShellCommand(127, "bash: line 1: file: command not found"),
  "file",
  "the observed exit=127 missing-file diagnostic must be recognized",
);
assert.equal(detectMissingShellCommand(0, "bash: line 1: file: command not found"), null, "a successful command must not be misclassified");
assert.equal(detectMissingShellCommand(127, "PROJECT_ARCHIVE_TOOL_MISSING=unzip"), "unzip", "portable probe reports required tools explicitly");
const recovery = buildMissingCommandRecoveryInstruction("file", "termux");
assert.match(recovery, /optional/);
assert.match(recovery, /not evidence of bad source input/);
assert.match(recovery, /command -v unzip/);
assert.match(recovery, /selected backend/);
assert.match(recovery, /TERMUX_RUN:/);
assert.match(recovery, /NDK\/toolchain readiness is only an intermediate prerequisite/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v385-recovery-"));
try {
  const sourceDir = path.join(temp, "source");
  fs.mkdirSync(path.join(sourceDir, "app"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "settings.gradle"), "rootProject.name='portable'\n");
  fs.writeFileSync(path.join(sourceDir, "app", "build.gradle"), "plugins { id 'com.android.application' }\n");
  const zipPath = path.join(temp, "valid source.zip");
  const zip = spawnSync("zip", ["-qr", zipPath, "."], { cwd: sourceDir, encoding: "utf8" });
  assert.equal(zip.status, 0, `fixture ZIP creation failed: ${zip.stderr}`);

  // Provide only unzip in the selected shell PATH: `file`, ls, grep, and other
  // host-only tools are intentionally unavailable for this regression.
  const minimalBin = path.join(temp, "selected-backend-bin");
  fs.mkdirSync(minimalBin);
  const unzipPath = spawnSync("which", ["unzip"], { encoding: "utf8" }).stdout.trim();
  assert.ok(unzipPath && fs.existsSync(unzipPath), "test host has unzip for the hermetic fixture");
  fs.symlinkSync(unzipPath, path.join(minimalBin, "unzip"));
  assert.notEqual(spawnSync("/bin/bash", ["-c", "command -v file"], { encoding: "utf8", env: { PATH: minimalBin } }).status, 0, "file is absent in the selected backend fixture");

  const portable = buildPortableArchiveProbeCommand(zipPath);
  const syntax = spawnSync("/bin/bash", ["-n"], { input: portable, encoding: "utf8" });
  assert.equal(syntax.status, 0, `portable probe must preserve valid shell syntax: ${syntax.stderr}`);
  const checked = spawnSync("/bin/bash", ["-c", portable], { encoding: "utf8", env: { ...process.env, PATH: minimalBin } });
  assert.equal(checked.status, 0, `valid ZIP must inspect without file: ${checked.stderr}\n${checked.stdout}`);
  assert.match(checked.stdout, /PROJECT_ARCHIVE_INTEGRITY_OK=1/);
  assert.match(checked.stdout, /OPTIONAL_FILE_TOOL=missing/);

  const corruptPath = path.join(temp, "corrupt.zip");
  fs.writeFileSync(corruptPath, "not a ZIP archive\n");
  const corrupt = spawnSync("/bin/bash", ["-c", buildPortableArchiveProbeCommand(corruptPath)], { encoding: "utf8", env: { ...process.env, PATH: minimalBin } });
  assert.equal(corrupt.status, 48, "only the actual unzip integrity check may classify an archive as corrupt");
  assert.match(corrupt.stdout, /PROJECT_ARCHIVE_INVALID=1/);

  const projectDir = path.join(temp, "plain-project");
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, "gradlew"), "#!/bin/sh\n");
  const directory = spawnSync("/bin/bash", ["-c", buildPortableArchiveProbeCommand(projectDir)], { encoding: "utf8", env: { ...process.env, PATH: minimalBin } });
  assert.equal(directory.status, 0, `project folder inspection is portable: ${directory.stderr}`);
  assert.match(directory.stdout, /PROJECT_DIRECTORY_OK=1/);
  assert.match(directory.stdout, /PROJECT_MARKER=gradlew/);

  const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
  const ndkBlockStart = agent.indexOf("// Задача «установи NDK»");
  const ndkBlockEnd = agent.indexOf("const recoveryUiText", ndkBlockStart);
  assert.ok(ndkBlockStart >= 0 && ndkBlockEnd > ndkBlockStart, "NDK fast-path block exists");
  const ndkBlock = agent.slice(ndkBlockStart, ndkBlockEnd);
  assert.match(ndkBlock, /!options\.disableSpecialFastPaths/);
  assert.match(ndkBlock, /!isApkBuildTask\(userTask\)/, "APK builds cannot be intercepted by the NDK-only fast path");
  assert.match(agent, /buildPortableArchiveProbeCommand\(archivePath\)/);
  assert.match(agent, /buildMissingCommandRecoveryInstruction\(missingTool, executionBackend\)/);
  assert.match(agent, /pendingMissingToolRecovery/);

  const protocol = fs.readFileSync(path.join(root, "lib/ide-core-prompt.ts"), "utf8");
  assert.match(protocol, /Never assume the file utility is installed/);
  assert.match(protocol, /unzip -tq/);
  assert.match(protocol, /NDK\/toolchain readiness is only an intermediate prerequisite/);
  const escalation = fs.readFileSync(path.join(root, "lib/agent-escalation.ts"), "utf8");
  assert.match(escalation, /Never assume `file` is installed/);
  assert.match(escalation, /continue to assemble, locate, and verify the APK/);

  const generic = fs.readFileSync(path.join(root, "lib/scripted-task-engine.ts"), "utf8");
  assert.match(generic, /if command -v file >\/dev\/null 2>&1; then/);
  assert.match(generic, /unzip -tq/);
  assert.doesNotMatch(generic, /busybox unzip/, "missing BusyBox applets are not treated as bad ZIPs");
  assert.ok(generic.indexOf("if command -v file") < generic.indexOf('file "$PATH_HINT"'), "optional `file` invocation follows the availability guard");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("AIB_V385_BUILD_RECOVERY_SELFTEST_OK missing_file=portable selected_backend=verified protocol=preserved ndk_build=continues");
