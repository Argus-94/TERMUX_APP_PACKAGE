#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { buildAndroidToolchainCommand } = await import("../lib/android-toolchain-script.ts");
const { buildProjectPathPinReadbackCommand } = await import("../lib/termux-project-path.ts");
const { normalizeTermuxCommandPaths } = await import("../lib/termux-executor-paths.ts");
const { classifyTermuxBuildFailure, termuxBuildFailureMessage } = await import("../lib/termux-build-failure.ts");

const generatedToolchainShell = buildAndroidToolchainCommand();
const shellSyntax = spawnSync("bash", ["-n"], { input: generatedToolchainShell, encoding: "utf8" });
assert.equal(shellSyntax.status, 0, `production-generated ensureAndroidToolchain shell must parse with bash -n: ${shellSyntax.stderr}`);
assert.ok(!/then;\s*(?:if|[A-Za-z_])/.test(generatedToolchainShell), "control-flow blocks are separated by newlines, never then;");
assert.doesNotMatch(generatedToolchainShell, /sdkmanager|pkg install|curl |wget /i, "toolchain readiness is read-only");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aib-termux-home-"));
try {
  const sharedRoot = path.join(home, "AIBuilderTermux");
  const projectsRoot = path.join(sharedRoot, "projects");
  const projectName = "project with spaces ' ; echo INJECTED #";
  const project = path.join(projectsRoot, projectName);
  const build = path.join(project, "android");
  fs.mkdirSync(build, { recursive: true });
  const work = path.join(sharedRoot, ".aibuilder", "work");
  fs.mkdirSync(work, { recursive: true });
  const projectRootFile = path.join(work, "project_root");
  const buildPathFile = path.join(work, "build_path");
  const projectPathFile = path.join(work, "proj_path");
  fs.writeFileSync(projectRootFile, `${project}\n`, "utf8");
  fs.writeFileSync(buildPathFile, `${build}\n`, "utf8");

  const opts = { projectRootFile, buildPathFile, projectPathFile, sharedProjectsRoot: projectsRoot };
  const pinCommand = buildProjectPathPinReadbackCommand(opts);
  const pinSyntax = spawnSync("bash", ["-n"], { input: pinCommand, encoding: "utf8" });
  assert.equal(pinSyntax.status, 0, `generated dual-root pin shell must parse: ${pinSyntax.stderr}`);
  const pinRun = spawnSync("bash", ["-c", pinCommand], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(pinRun.status, 0, `pin/readback must accept a nested Android build root: ${pinRun.stderr}`);
  assert.match(pinRun.stdout, /PINNED_DIR_OK/);
  assert.match(pinRun.stdout, /PINNED_BUILD_DIR_OK/);
  assert.doesNotMatch(pinRun.stdout, /INJECTED/, "path contents remain data; no command injection occurs");
  assert.equal(fs.readFileSync(projectPathFile, "utf8").trimEnd(), fs.realpathSync(project), "proj_path is the canonical visible source root");
  assert.equal(fs.readFileSync(buildPathFile, "utf8").trimEnd(), fs.realpathSync(build), "build_path is the verified in-project executor cwd");

  fs.writeFileSync(projectRootFile, `${projectsRoot}/../outside-project\n`, "utf8");
  const traversalRun = spawnSync("bash", ["-c", buildProjectPathPinReadbackCommand(opts)], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.notEqual(traversalRun.status, 0);
  assert.match(`${traversalRun.stdout}\n${traversalRun.stderr}`, /AIB_PROJECT_PATH_TRAVERSAL_DENIED/);

  fs.writeFileSync(projectRootFile, `${project}\nsecond-line\n`, "utf8");
  const newlineRun = spawnSync("bash", ["-c", buildProjectPathPinReadbackCommand(opts)], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.notEqual(newlineRun.status, 0);
  assert.match(`${newlineRun.stdout}\n${newlineRun.stderr}`, /AIB_PROJECT_PATH_NEWLINE_DENIED/);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

assert.equal(normalizeTermuxCommandPaths("/data/data/com.termux/files/home/project"), "$HOME/project", "known Termux HOME normalization remains deterministic");
assert.equal(classifyTermuxBuildFailure("NO_SAVED_PROJ"), "project-path");
assert.match(termuxBuildFailureMessage(classifyTermuxBuildFailure("NO_SAVED_PROJ")), /Gradle не запускалась/);
assert.equal(classifyTermuxBuildFailure("SDK_MISSING JAVA_MISSING"), "toolchain");
assert.match(termuxBuildFailureMessage("toolchain"), /Gradle не запускался/);
assert.equal(classifyTermuxBuildFailure("gradle=OK:"), "toolchain", "empty Gradle version output is not healthy evidence");
assert.equal(classifyTermuxBuildFailure("gradle=BROKEN sdk_platforms=MISSING"), "toolchain");
assert.equal(classifyTermuxBuildFailure("BLOCKED_BY_APP: sensitive file access is not allowed\nMISSING_GRADLE_WRAPPER"), "project-input", "source-access failure takes precedence over wrapper text");
assert.equal(classifyTermuxBuildFailure("PROJECT_SOURCE_READ_NOT_PROVEN PROJECT_PREBUILD_REQUIRED kind=expo"), "project-input");
assert.equal(classifyTermuxBuildFailure("FAILURE: Build failed with an exception\nWhat went wrong:"), "gradle");
assert.match(termuxBuildFailureMessage("gradle"), /Gradle запустился/);
assert.equal(classifyTermuxBuildFailure("exit=1 no assemble.log"), "build-command");
assert.match(termuxBuildFailureMessage("build-command"), /не подтверждает/);

console.log("AIB_TERMUX_DEVICE_BLOCKER_SELFTEST_OK toolchain_read_only=PASS dual_root_pin=PASS traversal=DENIED newline=DENIED source_precedence=PASS");
