#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildProjectSourceMarkerRecoveryCommand, buildProjectSourcePreflightCommand, parseProjectSourceProofOutput } from "../lib/project-source-import.ts";
import { executeProjectBuildRunner } from "../lib/project-build-runner.ts";

const agentSource = fs.readFileSync(new URL("../lib/termux-agent.ts", import.meta.url), "utf8");
assert.match(agentSource, /buildProjectSourceMarkerRecoveryCommand\(requestedSourcePath, \{ proofId: projectSourceProofId \}\)/);
assert.match(agentSource, /parseProjectSourceProofOutput\(preflightOut, projectSourceProofId\)/);
assert.match(agentSource, /if \(!projectProof && preflight\.exitCode === 0\)/);
assert.match(agentSource, /Never combine a success marker, root, or kind from separate partial callbacks/);
assert.match(agentSource, /executeProjectBuildRunner\(/);
assert.match(agentSource, /const initialPreflightSucceeded = preflight\.exitCode === 0;/);
assert.match(agentSource, /if \(initialPreflightSucceeded \|\| preflightExitCode === 0\)/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v386-build-handoff-"));
const sharedRoot = path.join(temp, "AIBuilderTermux");
const home = path.join(temp, "home");
const privateRoot = path.join(temp, "private", ".aibuilder");
const sourceFolder = path.join(temp, "hello-world-source");
const sourceZipDir = path.join(temp, "incoming files");
const sourceZip = path.join(sourceZipDir, "hello-world ' source.zip");
fs.mkdirSync(sourceZipDir, { recursive: true });
fs.mkdirSync(path.join(sourceFolder, "app"), { recursive: true });
fs.mkdirSync(path.join(sourceFolder, "gradle", "wrapper"), { recursive: true });
fs.mkdirSync(path.join(home, ".aibuilder", "work"), { recursive: true });
// Simulate an existing, empty private work directory shadowing the shared work directory.
fs.mkdirSync(path.join(privateRoot, "work"), { recursive: true });
fs.writeFileSync(path.join(sourceFolder, "settings.gradle"), "rootProject.name = 'HelloWorld'\ninclude ':app'\n");
fs.writeFileSync(path.join(sourceFolder, "build.gradle"), "// root compiler settings preserved\n");
fs.writeFileSync(path.join(sourceFolder, "gradle.properties"), "org.gradle.jvmargs=-Xmx1024m\nandroid.useAndroidX=true\n");
fs.writeFileSync(path.join(sourceFolder, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n");
fs.writeFileSync(path.join(sourceFolder, "app", "build.gradle"), "plugins { id 'com.android.application' }\nandroid { namespace 'com.karat.aibuilder'; compileSdk 35 }\n");
fs.writeFileSync(path.join(sourceFolder, "app", "gradle.lockfile"), "com.android.tools.build:gradle:8.8.2=classpath\n");
fs.writeFileSync(path.join(sourceFolder, "package-lock.json"), "{\"lockfileVersion\":3,\"packages\":{}}\n");
const originalConfigFiles = ["settings.gradle", "build.gradle", "gradle.properties", "gradle/wrapper/gradle-wrapper.properties", "app/build.gradle", "app/gradle.lockfile", "package-lock.json"];
const originalHashes = new Map(originalConfigFiles.map((rel) => [rel, fs.readFileSync(path.join(sourceFolder, rel))]));
  const zipResult = spawnSync("zip", ["-qr", sourceZip, "."], { cwd: sourceFolder, encoding: "utf8" });
assert.equal(zipResult.status, 0, `fixture zip creation failed: ${zipResult.stderr}`);
const env = { ...process.env, HOME: home, AIB_PRIVATE_ROOT: privateRoot };
delete env.AIB_INTERNAL_ROOT;
delete env.AIB_SHARED_ROOT;
const nativeCalls = [];
let llmCalls = 0;

function mockNative(command, options = {}) {
  nativeCalls.push({ command, options });
  const result = spawnSync("/bin/bash", ["-c", command], {
    cwd: options.cwd || temp,
    env: options.env || env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

async function handoffSource(sourcePath, label) {
  const proofId = `test-${label.toLowerCase()}-proof-01`;
  const preflight = mockNative(buildProjectSourcePreflightCommand(sourcePath, { sharedRoot, proofId }), { cwd: temp });
  assert.equal(preflight.exitCode, 0, `${label} preflight failed:\n${preflight.stdout}\n${preflight.stderr}`);
  assert.match(preflight.stdout, /PROJECT_SOURCE_READ_OK=1/);
  assert.match(preflight.stdout, new RegExp(`^PROJECT_SOURCE_PROOF_ID=${proofId}$`, "m"));
  assert.ok(parseProjectSourceProofOutput(preflight.stdout, proofId, `${sharedRoot}/projects`), `${label} complete preflight callback was not accepted`);

  const internalWork = path.join(sharedRoot, ".aibuilder", "work");
  const markerFiles = ["project_root", "project_kind", "project_source"];
  const savedMarkers = new Map(markerFiles.map((name) => [name, fs.readFileSync(path.join(internalWork, name))]));
  const staleRoot = path.join(sharedRoot, "projects", "stale-marker-project");
  fs.mkdirSync(staleRoot, { recursive: true });
  fs.writeFileSync(path.join(privateRoot, "work", "project_root"), `${staleRoot}\n`);
  fs.writeFileSync(path.join(privateRoot, "work", "project_kind"), "gradle\n");
  fs.writeFileSync(path.join(privateRoot, "work", "project_source"), `${sourcePath}.different\n`);
  for (const name of markerFiles) fs.rmSync(path.join(internalWork, name));
  const staleRecovery = mockNative(buildProjectSourceMarkerRecoveryCommand(sourcePath, { sharedRoot }), { cwd: temp });
  assert.notEqual(staleRecovery.exitCode, 0, `${label} accepted markers from another source path`);
  assert.match(staleRecovery.stdout, /PROJECT_SOURCE_MARKERS_MISSING/);
  for (const [name, contents] of savedMarkers) fs.writeFileSync(path.join(internalWork, name), contents);

  // Real device log: callback exit=0 can return only the first success marker.
  // Partial root/kind fields from separate callbacks must never form a proof.
  const capturedBridgeOutput = "PROJECT_SOURCE_READ_OK=1\n";
  assert.equal(parseProjectSourceProofOutput(capturedBridgeOutput, proofId, `${sharedRoot}/projects`), null, `${label} accepted a short success-only callback as root/kind proof`);
  assert.equal(parseProjectSourceProofOutput(`PROJECT_SOURCE_READ_OK=1\nPROJECT_SOURCE_PROOF_ID=${proofId}\nPROJECT_ROOT=${sharedRoot}/projects/unverified\n`, proofId, `${sharedRoot}/projects`), null, `${label} accepted partial root without kind/projects root`);
  assert.equal(parseProjectSourceProofOutput(`PROJECT_SOURCE_READ_OK=1\nPROJECT_SOURCE_PROOF_ID=${proofId}\nPROJECT_KIND_PROVEN=gradle\n`, proofId, `${sharedRoot}/projects`), null, `${label} accepted partial kind without root/projects root`);

  const differentPath = path.join(path.dirname(sourcePath), `elsewhere-${path.basename(sourcePath)}`);
  const wrongSource = mockNative(buildProjectSourceMarkerRecoveryCommand(differentPath, { sharedRoot, proofId }), { cwd: temp });
  assert.notEqual(wrongSource.exitCode, 0, `${label} accepted a proof for a different exact source path`);
  assert.match(wrongSource.stdout, /PROJECT_SOURCE_MARKERS_MISSING/);

  const recovered = mockNative(buildProjectSourceMarkerRecoveryCommand(sourcePath, { sharedRoot, proofId }), { cwd: temp });
  assert.equal(recovered.exitCode, 0, `${label} source-marker recovery failed:\n${recovered.stdout}\n${recovered.stderr}`);
  assert.match(recovered.stdout, /PROJECT_SOURCE_MARKERS_OK=1/);
  const firstLineCallback = `${recovered.stdout.split(/\r?\n/, 1)[0]}\n`;
  assert.match(firstLineCallback, /^PROJECT_SOURCE_PROOF_V1=/, `${label} recovery's first callback line must carry the complete proof`);
  const proof = parseProjectSourceProofOutput(firstLineCallback, proofId, `${sharedRoot}/projects`);
  assert.ok(proof, `${label} first-line-only recovery callback did not provide one complete source-bound proof`);
  assert.equal(parseProjectSourceProofOutput(`diagnostic\n${firstLineCallback}`, proofId, `${sharedRoot}/projects`), null, `${label} parser accepted a proof after leading callback noise`);
  assert.equal(parseProjectSourceProofOutput(`\n${firstLineCallback}`, proofId, `${sharedRoot}/projects`), null, `${label} parser accepted a proof after an empty first line`);
  const proofLine = firstLineCallback.trimEnd();
  for (let cut = 1; cut < proofLine.length; cut++) {
    assert.equal(parseProjectSourceProofOutput(`${proofLine.slice(0, cut)}\n`, proofId, `${sharedRoot}/projects`), null, `${label} parser accepted a proof truncated at byte ${cut}`);
  }
  assert.equal(parseProjectSourceProofOutput(`${firstLineCallback}${firstLineCallback}`, proofId, `${sharedRoot}/projects`), null, `${label} parser accepted duplicate proof records`);
  assert.equal(parseProjectSourceProofOutput(firstLineCallback, `${proofId}-other`, `${sharedRoot}/projects`), null, `${label} parser accepted another run's proof ID`);
  const proofParts = firstLineCallback.trim().match(/^PROJECT_SOURCE_PROOF_V1=([A-Za-z0-9_-]+)\.([A-Za-z0-9+/]+={0,2})\.([A-Za-z0-9+/]+={0,2})\.([A-Za-z0-9+/]+={0,2})$/);
  assert.ok(proofParts, `${label} compact proof line was malformed`);
  const outsideRootB64 = Buffer.from(path.join(temp, "outside-project-root"), "utf8").toString("base64");
  const escapedRootOutput = `PROJECT_SOURCE_PROOF_V1=${proofParts[1]}.${proofParts[2]}.${outsideRootB64}.${proofParts[4]}\n`;
  assert.equal(parseProjectSourceProofOutput(escapedRootOutput, proofId, `${sharedRoot}/projects`), null, `${label} parser accepted a root outside projects containment`);
  const projectRoot = proof.projectRoot;
  const projectKind = proof.projectKind;
  assert.ok(projectRoot.startsWith(`${sharedRoot}/projects/`), `${label} root escaped the app project directory`);
  assert.equal(projectKind, "gradle");

  for (const rel of originalConfigFiles) {
    assert.deepEqual(fs.readFileSync(path.join(sourceFolder, rel)), originalHashes.get(rel), `source input changed: ${rel}`);
  }

  const artifact = path.join(projectRoot, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const build = await executeProjectBuildRunner({
    projectRoot,
    projectName: "hello-world",
    projectKind,
    backend: "termux",
    variant: "assembleDebug",
    command: `mkdir -p '${path.dirname(artifact)}' && printf '%s' 'mock-apk-bytes' > '${artifact}' && printf 'MOCK_NATIVE_BUILD_RESULT=SUCCESS\\nBUILD SUCCESSFUL\\nAIB_MOCK_ARTIFACT=%s\\n' '${artifact}'`,
    sharedRoot,
    timeoutMs: 30_000,
  }, async (command, executionOptions) => {
    assert.equal(executionOptions.backend, "termux");
    assert.equal(executionOptions.workdir, projectRoot);
    assert.equal(executionOptions.isBuild, true);
    return mockNative(command, { cwd: executionOptions.workdir, env: { ...env, AIB_SHARED_ROOT: sharedRoot } });
  });
  assert.equal(build.exitCode, 0, `${label} runner failed:\n${build.stdout}\n${build.stderr}`);
  assert.ok(build.projectBuildScriptPath?.startsWith(path.join(privateRoot, "work", "build-runners", "build-apk-")), `${label} did not materialize a backend-private temporary runner`);
  assert.match(build.stdout, /AIB_BUILD_COMMAND_START/);
  assert.match(build.stdout, /MOCK_NATIVE_BUILD_RESULT=SUCCESS/);
  assert.match(build.stdout, /AIB_BUILD_COMMAND_EXIT=0/);
  assert.equal(fs.readFileSync(artifact, "utf8"), "mock-apk-bytes");
  const runnerContent = fs.readFileSync(build.projectBuildScriptPath, "utf8");
  assert.match(runnerContent, /AI_BUILDER_PROJECT_BUILD_RUNNER:v1/);
  assert.match(build.stdout, /BUILD_CONFIG_PRESERVED=gradle\.properties/);
  assert.equal(llmCalls, 0, `${label} unexpectedly required an LLM reply to reach the runner`);
  return { projectRoot, build };
}

try {
  fs.mkdirSync(sharedRoot, { recursive: true });
  const sourceSymlink = path.join(temp, "hello-world-source-link");
  fs.symlinkSync(sourceFolder, sourceSymlink, "dir");
  const symlinkPreflight = mockNative(buildProjectSourcePreflightCommand(sourceSymlink, { sharedRoot, proofId: "source-symlink-proof" }), { cwd: temp });
  assert.notEqual(symlinkPreflight.exitCode, 0, "source symlink must be rejected before import");
  assert.match(`${symlinkPreflight.stdout}\n${symlinkPreflight.stderr}`, /PROJECT_SOURCE_SYMLINK_DENIED/);

  const zipRun = await handoffSource(sourceZip, "ZIP");
  const folderRun = await handoffSource(sourceFolder, "folder");

  const outsideBuildRoot = path.join(temp, "outside-build-root");
  fs.mkdirSync(outsideBuildRoot, { recursive: true });
  fs.symlinkSync(outsideBuildRoot, path.join(zipRun.projectRoot, "outside-build"), "dir");
  let escapedCommandRan = false;
  const escapedBuild = await executeProjectBuildRunner({
    projectRoot: zipRun.projectRoot,
    projectName: "hello-world",
    projectKind: "gradle",
    backend: "termux",
    variant: "assembleDebug",
    buildSubdirectory: "outside-build",
    command: "echo AIB_BUILD_ESCAPE_PAYLOAD_RAN=1",
    sharedRoot,
    timeoutMs: 30_000,
  }, async (command, executionOptions) => {
    const result = mockNative(command, { cwd: executionOptions.workdir, env: { ...env, AIB_SHARED_ROOT: sharedRoot } });
    escapedCommandRan = /AIB_BUILD_ESCAPE_PAYLOAD_RAN=1/.test(result.stdout);
    return result;
  });
  assert.notEqual(escapedBuild.exitCode, 0, "symlinked build root must be rejected");
  assert.match(`${escapedBuild.stdout}\n${escapedBuild.stderr}`, /AIB_PROJECT_BUILD_ROOT_OUTSIDE_PROJECT/);
  assert.equal(escapedCommandRan, false, "build command must not execute outside the project root");

  // Verify the native executor's actual failing exit is recorded, not replaced by
  // a success-shaped textual response.
  const failed = await executeProjectBuildRunner({
    projectRoot: zipRun.projectRoot,
    projectName: "hello-world",
    projectKind: "gradle",
    backend: "termux",
    variant: "assembleDebug",
    command: "printf 'MOCK_NATIVE_BUILD_RESULT=FAILURE\\n'; sh -c 'exit 23'",
    sharedRoot,
    timeoutMs: 30_000,
  }, async (command, executionOptions) => mockNative(command, {
    cwd: executionOptions.workdir,
    env: { ...env, AIB_SHARED_ROOT: sharedRoot },
  }));
  assert.equal(failed.exitCode, 23);
  assert.match(failed.stdout, /MOCK_NATIVE_BUILD_RESULT=FAILURE/);
  assert.match(failed.stdout, /AIB_BUILD_COMMAND_EXIT=23/);
  assert.ok(failed.projectBuildScriptPath, "failed native build must retain the generated script path for diagnostics");

  console.log(`AIB_V387_PROJECT_SOURCE_CALLBACK_SELFTEST_OK archive=PASS folder=PASS partial_callback=REJECTED exact_source_path=PASS atomic_marker_recovery=PASS project_runner=PASS mock_native_success=PASS mock_native_exit=23 llm_calls=${llmCalls} source_preserved=PASS roots=${path.basename(zipRun.projectRoot)},${path.basename(folderRun.projectRoot)}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
