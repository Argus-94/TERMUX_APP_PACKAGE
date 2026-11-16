#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const {
  buildProjectBuildRunnerContent,
  buildProjectBuildRunnerInvocation,
  buildProjectBuildRunnerMaterializeAndInvokeCommand,
  extractProjectBuildRunnerPath,
  projectBuildRunnerSlug,
} = await import("../lib/project-build-runner.ts");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-project-build-runner-"));
const sharedRoot = path.join(temp, "AIBuilderTermux");
const privateRoot = path.join(temp, "private-workspace");
fs.mkdirSync(path.join(sharedRoot, "projects"), { recursive: true });
fs.mkdirSync(privateRoot, { recursive: true });
const env = { ...process.env, AIB_PRIVATE_ROOT: privateRoot };
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
const runShell = (command) => spawnSync("bash", ["-c", command], { encoding: "utf8", env });
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

try {
  assert.equal(projectBuildRunnerSlug("Imported demo App"), "imported-demo-app");
  assert.throws(
    () => buildProjectBuildRunnerContent({
      projectRoot: path.join(sharedRoot, "projects", "bad"),
      projectName: "bad",
      projectKind: "gradle",
      backend: "termux",
      variant: "assembleDebug",
      buildSubdirectory: "../outside",
      command: "true",
      sharedRoot,
    }),
    /PROJECT_BUILD_RUNNER_BUILD_ROOT_INVALID/,
  );

  // New nested Android project: a scripted first failure is inspected, then the
  // same backend-private runner succeeds after a scoped repair.
  const newProject = path.join(sharedRoot, "projects", "new-demo");
  const androidRoot = path.join(newProject, "android");
  fs.mkdirSync(androidRoot, { recursive: true });
  fs.writeFileSync(path.join(androidRoot, "settings.gradle"), "rootProject.name='NewDemo'\n");
  fs.writeFileSync(path.join(androidRoot, "build.gradle"), "plugins { id 'com.android.application' }\n");
  fs.writeFileSync(path.join(newProject, "package.json"), '{"name":"new-demo","packageManager":"pnpm@9.15.0"}\n');
  fs.writeFileSync(path.join(newProject, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const configBefore = hash(path.join(androidRoot, "settings.gradle"));
  const lockBefore = hash(path.join(newProject, "pnpm-lock.yaml"));
  const repairMarker = path.join(privateRoot, "work", "fixture-repair-applied");
  const fakeBuild = 'if [ ! -f "$AIB_PRIVATE_ROOT/work/fixture-repair-applied" ]; then echo SIMULATED_GRADLE_FAILURE=missing-tool-from-log >&2; exit 17; fi; cd -- "$AIB_PROJECT_BUILD_ROOT" || exit 18; test -f settings.gradle || { echo SIMULATED_BUILD_ROOT_WRONG; exit 19; }; echo SIMULATED_BUILD_RETRY_OK';
  const first = runShell(buildProjectBuildRunnerMaterializeAndInvokeCommand({
    projectRoot: newProject,
    projectName: "New Demo",
    runnerSessionId: "selftest-session",
    projectKind: "expo-gradle",
    backend: "ubuntu-proot",
    variant: "assembleDebug",
    buildSubdirectory: "android",
    command: fakeBuild,
    sharedRoot,
  }));
  assert.equal(first.status, 17, `first simulated build must preserve failure exit status: ${first.stderr}\n${first.stdout}`);
  assert.match(`${first.stdout}\n${first.stderr}`, /SIMULATED_GRADLE_FAILURE=missing-tool-from-log/);
  const runnerPath = extractProjectBuildRunnerPath(`${first.stdout}\n${first.stderr}`);
  assert.ok(runnerPath?.startsWith(path.join(privateRoot, "work", "build-runners", "build-apk-new-demo")), "generated script is in the backend-private temporary runner directory");
  assert.equal(fs.statSync(runnerPath).mode & 0o777, 0o700, "generated runner is private to the project owner");
  assert.match(fs.readFileSync(runnerPath, "utf8"), /AIB_ALLOWED_PROJECT_ROOT/);
  assert.match(fs.readFileSync(runnerPath, "utf8"), /AIB_PROJECT_ROOT_OUTSIDE_ALLOWED_ROOT/);
  assert.equal(fs.readFileSync(path.join(privateRoot, "work", "project_root"), "utf8").trim(), newProject);
  assert.equal(fs.readFileSync(path.join(privateRoot, "work", "build_path"), "utf8").trim(), androidRoot);
  assert.equal(fs.readFileSync(path.join(privateRoot, "work", "proj_path"), "utf8").trim(), androidRoot);
  assert.equal(fs.readFileSync(path.join(privateRoot, "work", "src_path"), "utf8").trim(), newProject);

  fs.writeFileSync(repairMarker, "simulated allowlisted repair\n");
  // Simulate the LLM agent fixing the runner itself. Re-materialization in the
  // same recovery session must preserve that edit rather than overwrite it.
  fs.writeFileSync(runnerPath, fs.readFileSync(runnerPath, "utf8").replace("SIMULATED_BUILD_RETRY_OK", "SIMULATED_BUILD_RETRY_OK_AGENT_PATCHED"));
  const retried = runShell(buildProjectBuildRunnerMaterializeAndInvokeCommand({
    projectRoot: newProject,
    projectName: "New Demo",
    runnerSessionId: "selftest-session",
    projectKind: "expo-gradle",
    backend: "ubuntu-proot",
    variant: "assembleDebug",
    buildSubdirectory: "android",
    command: fakeBuild,
    sharedRoot,
  }));
  assert.equal(retried.status, 0, `same runner succeeds after the scoped repair: ${retried.stderr}\n${retried.stdout}`);
  assert.match(retried.stdout, /SIMULATED_BUILD_RETRY_OK_AGENT_PATCHED/);
  assert.match(retried.stdout, /AIB_BUILD_COMMAND_EXIT=0/);
  assert.equal(hash(path.join(androidRoot, "settings.gradle")), configBefore, "compiler settings survive the retry byte-for-byte");
  assert.equal(hash(path.join(newProject, "pnpm-lock.yaml")), lockBefore, "dependency lockfile survives the retry byte-for-byte");

  // Existing project directly under AIBuilderTermux (not only projects/); do not
  // overwrite a user-authored build script when the generated name collides.
  const existingProject = path.join(sharedRoot, "existing-project");
  fs.mkdirSync(existingProject, { recursive: true });
  fs.writeFileSync(path.join(existingProject, "settings.gradle.kts"), "rootProject.name = \"Existing\"\n");
  fs.writeFileSync(path.join(existingProject, "build.gradle.kts"), "plugins { id(\"com.android.application\") }\n");
  fs.writeFileSync(path.join(existingProject, "package-lock.json"), '{"lockfileVersion":3}\n');
  const userScript = path.join(existingProject, "build-apk-existing-project.sh");
  fs.writeFileSync(userScript, "#!/usr/bin/env bash\necho user-authored\n");
  const existingRun = runShell(buildProjectBuildRunnerMaterializeAndInvokeCommand({
    projectRoot: existingProject,
    projectName: "Existing Project",
    projectKind: "gradle",
    backend: "termux",
    variant: "assembleRelease",
    command: 'echo SIMULATED_EXISTING_PROJECT_OK',
    sharedRoot,
  }));
  assert.equal(existingRun.status, 0, `existing project under root should build: ${existingRun.stderr}\n${existingRun.stdout}`);
  assert.match(existingRun.stdout, /SIMULATED_EXISTING_PROJECT_OK/);
  assert.match(existingRun.stdout, /BUILD_CONFIG_PRESERVED=package-lock\.json/);
  assert.equal(fs.readFileSync(userScript, "utf8"), "#!/usr/bin/env bash\necho user-authored\n", "existing user script is not overwritten");
  const existingRunner = extractProjectBuildRunnerPath(`${existingRun.stdout}\n${existingRun.stderr}`);
  assert.match(path.basename(existingRunner), /^build-apk-existing-project\.sh$/);

  // The selected backend is carried into the saved script, but build/cache markers
  // remain in that backend's private workspace.
  assert.match(fs.readFileSync(existingRunner, "utf8"), /Backend: termux/);
  assert.match(fs.readFileSync(runnerPath, "utf8"), /Backend: ubuntu-proot/);

  // Reject direct and symlink-based escapes, including a runner later copied out.
  const outside = path.join(temp, "outside");
  fs.mkdirSync(outside, { recursive: true });
  const directEscape = runShell(buildProjectBuildRunnerMaterializeAndInvokeCommand({
    projectRoot: outside,
    projectName: "outside",
    projectKind: "gradle",
    backend: "termux",
    variant: "assembleDebug",
    command: "true",
    sharedRoot,
  }));
  assert.notEqual(directEscape.status, 0);
  assert.match(`${directEscape.stdout}\n${directEscape.stderr}`, /PROJECT_BUILD_RUNNER_OUTSIDE_PROJECT_ROOT/);

  const symlink = path.join(sharedRoot, "outside-link");
  fs.symlinkSync(outside, symlink, "dir");
  const linkedProject = path.join(symlink, "linked-project");
  fs.mkdirSync(linkedProject, { recursive: true });
  const symlinkEscape = runShell(buildProjectBuildRunnerMaterializeAndInvokeCommand({
    projectRoot: linkedProject,
    projectName: "linked",
    projectKind: "gradle",
    backend: "termux",
    variant: "assembleDebug",
    command: "true",
    sharedRoot,
  }));
  assert.notEqual(symlinkEscape.status, 0);
  assert.match(`${symlinkEscape.stdout}\n${symlinkEscape.stderr}`, /PROJECT_BUILD_RUNNER_OUTSIDE_PROJECT_ROOT/);

  const movedRunner = path.join(outside, "build-apk-moved.sh");
  fs.copyFileSync(runnerPath, movedRunner);
  const moved = spawnSync("bash", [movedRunner], { encoding: "utf8", env });
  assert.notEqual(moved.status, 0);
  assert.match(`${moved.stdout}\n${moved.stderr}`, /AIB_BUILD_RUNNER_OUTSIDE_PRIVATE_TEMP/);
  assert.equal(fs.existsSync(path.join(outside, "SIMULATED_BUILD_OK")), false);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("AIB_PROJECT_BUILD_RUNNER_SELFTEST_OK imported/new/existing=SIMULATED retry=SCOPED private-temp-runner=VERIFIED backend=PINNED config-lockfiles=PRESERVED path-escape=DENIED user-script=UNTOUCHED");
