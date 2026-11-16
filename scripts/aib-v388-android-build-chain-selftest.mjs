#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildProjectSourcePreflightCommand } from "../lib/project-source-import.ts";
import { executeProjectBuildRunner } from "../lib/project-build-runner.ts";
const __AIB_VER = (await import("node:fs")).readFileSync(new URL("../core/runtime/RuntimeIdentity.ts", import.meta.url), "utf8").match(/appVersion: "([^"]+)"/)[1]; // v407: single source of truth (RuntimeIdentity == package.json)

// v389+: self-contained. No machine-specific archive path: pack this very source tree unless one is supplied.
const sourceRoot = path.resolve(new URL("..", import.meta.url).pathname);
let archive = process.env.AIB_TEST_SOURCE_ARCHIVE || "";
if (!archive) {
  archive = path.join(os.tmpdir(), `aib-v388-selfpack-${process.pid}.zip`);
  const sourceName = path.basename(sourceRoot);
  const exclude = ["node_modules", ".tmphome", "android", ".git", ".expo", ".gradle", "build", "dist", "coverage", "tmp", "verification-v493", "verification-v494"]
    .flatMap((name) => [`${sourceName}/${name}`, `${sourceName}/${name}/*`]);
  const pack = spawnSync("zip", ["-qr", "-y", archive, sourceName, "-x", ...exclude], { cwd: path.dirname(sourceRoot), encoding: "utf8" });
  assert.equal(pack.status, 0, `SELF_PACK_FAILED:${pack.stderr}`);
  process.on("exit", () => fs.rmSync(archive, { force: true }));
}
assert.ok(fs.existsSync(archive), `SOURCE_ARCHIVE_MISSING:${archive}`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v388-build-chain-"));
const sharedRoot = path.join(temp, "AIBuilderTermux");
const privateRoot = path.join(temp, "private");
fs.mkdirSync(sharedRoot, { recursive: true });
fs.mkdirSync(privateRoot, { recursive: true });
const env = { ...process.env, AIB_SHARED_ROOT: sharedRoot, AIB_INTERNAL_ROOT: privateRoot, AIB_PRIVATE_ROOT: privateRoot };

function preflight(source, proofId) {
  const result = spawnSync("/bin/bash", ["-c", buildProjectSourcePreflightCommand(source, { sharedRoot, proofId })], {
    cwd: temp,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.equal(result.status, 0, `PREFLIGHT_FAILED:${source}\n${output}`);
  assert.match(output, new RegExp(`^PROJECT_SOURCE_PROOF_V1=${proofId}\\.`, "m"));
  assert.match(output, /^PROJECT_KIND_PROVEN=expo$/m);
  const projectRoot = fs.readFileSync(path.join(privateRoot, "work/project_root"), "utf8").trim();
  const projectKind = fs.readFileSync(path.join(privateRoot, "work/project_kind"), "utf8").trim();
  assert.equal(projectKind, "expo");
  assert.ok(projectRoot.startsWith(`${sharedRoot}/projects/`), `PROJECT_OUTSIDE_PROJECTS:${projectRoot}`);
  return projectRoot;
}

function digest(file) {
  return spawnSync("sha256sum", [file], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0];
}

async function simulateRunner(projectRoot, backend, projectKind = "expo", variant = "assembleDebug") {
  const snapshots = new Map();
  for (const name of ["package.json", "pnpm-lock.yaml", "app.config.ts", "app.json", "settings.gradle", "settings.gradle.kts", "gradle.properties"]) {
    const file = path.join(projectRoot, name);
    if (fs.existsSync(file)) snapshots.set(name, digest(file));
  }
  const result = await executeProjectBuildRunner({
    projectRoot,
    projectName: path.basename(projectRoot),
    projectKind,
    backend,
    variant,
    sharedRoot,
    command: 'echo SIMULATED_BUILD_COMMAND=executed; test -d "$AIB_PROJECT_BUILD_ROOT"',
    timeoutMs: 15_000,
  }, async (command, options) => {
    assert.equal(options.backend, backend, "SELECTED_BACKEND_NOT_FORWARDED");
    const execution = spawnSync("/bin/bash", ["-c", command], {
      cwd: options.workdir,
      env,
      encoding: "utf8",
      timeout: options.timeoutMs,
    });
    return { exitCode: execution.status ?? 124, stdout: `SIMULATED_EXECUTOR_BACKEND=${options.backend}\n${execution.stdout || ""}`, stderr: execution.stderr };
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.equal(result.exitCode, 0, `RUNNER_FAILED:${backend}\n${output}`);
  assert.ok(result.projectBuildScriptPath?.startsWith(path.join(privateRoot, "work", "build-runners", "build-apk-")), "PRIVATE_RUNNER_PATH_MISSING");
  assert.match(output, new RegExp(`SIMULATED_EXECUTOR_BACKEND=${backend}`));
  assert.match(output, new RegExp(`AIB_BUILD_BACKEND=${backend}`));
  assert.match(output, new RegExp(`AIB_PROJECT_KIND=${projectKind}`));
  assert.match(output, new RegExp(`AIB_BUILD_VARIANT=${variant}`));
  assert.match(output, /SIMULATED_BUILD_COMMAND=executed/);
  for (const [name, before] of snapshots) assert.equal(digest(path.join(projectRoot, name)), before, `BUILD_CONFIG_CHANGED:${name}`);
  assert.doesNotMatch(output, /AIB_DETERMINISTIC_APK=|AIB_APK_SIZE=/, "simulation must not claim to have produced an APK");
}

try {
  const archivedProject = preflight(archive, "baseline-zip-v388");
  const packageData = JSON.parse(fs.readFileSync(path.join(archivedProject, "package.json"), "utf8"));
  assert.equal(packageData.version, __AIB_VER, "APP_VERSION_DRIFT");
  const identity = JSON.parse(fs.readFileSync(path.join(archivedProject, "AI_BUILDER_ANDROID_IDENTITY.json"), "utf8"));
  assert.equal(identity.applicationId, "com.karat.aibuilder", "APP_ID_DRIFT");
  assert.ok(fs.existsSync(path.join(archivedProject, "pnpm-lock.yaml")), "LOCKFILE_MISSING");

  const existingParent = path.join(temp, "existing-source");
  fs.mkdirSync(existingParent);
  const unzip = spawnSync("unzip", ["-q", archive, "-d", existingParent], { encoding: "utf8", timeout: 120_000 });
  assert.equal(unzip.status, 0, `BASELINE_EXTRACTION_FAILED:${unzip.stderr || ""}`);
  const existingTop = fs.readdirSync(existingParent).map((item) => path.join(existingParent, item)).find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
  assert.ok(existingTop, "EXISTING_PROJECT_ROOT_NOT_FOUND");
  const existingProject = preflight(existingTop, "existing-folder-v388");
  assert.equal(JSON.parse(fs.readFileSync(path.join(existingProject, "package.json"), "utf8")).version, __AIB_VER);

  const newProject = path.join(sharedRoot, "projects", "new-gradle-project");
  fs.mkdirSync(path.join(newProject, "app", "src", "main"), { recursive: true });
  fs.writeFileSync(path.join(newProject, "settings.gradle"), "rootProject.name = 'NewProject'\n");
  fs.writeFileSync(path.join(newProject, "gradle.properties"), "org.gradle.jvmargs=-Xmx1g\n");
  fs.writeFileSync(path.join(newProject, "app", "build.gradle"), "plugins { id 'com.android.application' }\n");
  fs.writeFileSync(path.join(newProject, "app", "src", "main", "AndroidManifest.xml"), '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="example.newproject"/>\n');

  for (const projectRoot of [archivedProject, existingProject, newProject]) {
    const kind = projectRoot === newProject ? "gradle" : "expo";
    await simulateRunner(projectRoot, "termux", kind);
    await simulateRunner(projectRoot, "ubuntu-proot", kind);
  }
  console.log("AIB_V388_ANDROID_BUILD_CHAIN_SELFTEST_OK source=v387.zip/existing-folder/new-project identity=preserved config-lockfiles=preserved private-runner=verified selected-backends=termux+ubuntu-proot simulated=6 real-gradle=not-run");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
