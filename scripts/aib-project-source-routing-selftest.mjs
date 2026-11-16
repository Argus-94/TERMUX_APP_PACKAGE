#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { buildProjectSourcePreflightCommand, classifyProjectSourceMarkers } = await import("../lib/project-source-import.ts");
const { buildProjectArtifactRootShell } = await import("../lib/termux-project-path.ts");
const termuxAgentSource = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
const collectStart = termuxAgentSource.indexOf("function buildApkCollectCmd(): string {");
const collectEnd = termuxAgentSource.indexOf("/** @deprecated single-shot", collectStart);
assert.ok(collectStart >= 0 && collectEnd > collectStart, "production artifact collector is present");
const collectSource = termuxAgentSource.slice(collectStart, collectEnd);
assert.match(collectSource, /buildProjectArtifactRootShell\(\)/);
assert.match(collectSource, /OUTDIR="\$ARTIFACT_ROOT"/);
assert.match(collectSource, /APK_PATH=\$SIGNED/);
assert.doesNotMatch(collectSource, /OUTDIR="\$WORK\/outputs"|\/storage\/emulated\/0\/Download|\/sdcard\/Download/);
assert.doesNotMatch(termuxAgentSource, /HOME\/aibuilder_work/, "stale HOME workdirs cannot overwrite proven build markers");
const prepareStart = termuxAgentSource.indexOf("function buildApkPrepareCmd(srcPath: string): string {");
const prepareEnd = termuxAgentSource.indexOf("function apkGradleEnvLines()", prepareStart);
assert.ok(prepareStart >= 0 && prepareEnd > prepareStart, "production APK preparation command is present");
const prepareSource = termuxAgentSource.slice(prepareStart, prepareEnd);
assert.doesNotMatch(prepareSource, /pkg install|npm install|pnpm install|yarn install|sdkmanager\s+--(?:install|sdk_root|licenses)|prebuild --clean|curl |wget |wrapper_restored|\bcp\b[^;\n]*gradle-wrapper\.jar/i, "preparation does not install packages, run prebuild, or restore arbitrary wrappers");
assert.doesNotMatch(prepareSource, /local\.properties|chmod \+x \"\$PROJ\/gradlew\"/i, "preparation does not write project-local SDK metadata or mutate wrapper permissions");
const gradleEnvStart = termuxAgentSource.indexOf("function apkGradleEnvLines(): string {");
const gradleEnvEnd = termuxAgentSource.indexOf("/** Вызов сборки:", gradleEnvStart);
assert.ok(gradleEnvStart >= 0 && gradleEnvEnd > gradleEnvStart, "shared Gradle environment helper is present");
assert.doesNotMatch(termuxAgentSource.slice(gradleEnvStart, gradleEnvEnd), /local\.properties|chmod \+x/i, "shared Gradle environment does not mutate source or SDK files");
const runAssembleStart = termuxAgentSource.indexOf("function apkRunAssemble(");
const runAssembleEnd = termuxAgentSource.indexOf("/** Offline-only:", runAssembleStart);
assert.ok(runAssembleStart >= 0 && runAssembleEnd > runAssembleStart, "verified Gradle wrapper runner is present");
assert.doesNotMatch(termuxAgentSource.slice(runAssembleStart, runAssembleEnd), /chmod \+x|local\.properties/i, "verified wrapper is invoked without in-place chmod or local.properties writes");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-project-source-"));
const sharedRoot = path.join(temp, "AIBuilderTermux");
const internalRoot = path.join(temp, "aib-internal");
const input = path.join(temp, "hello-world source.zip");
const source = path.join(temp, "source");
fs.mkdirSync(path.join(source, "app", "src", "main"), { recursive: true });
fs.writeFileSync(path.join(source, "settings.gradle"), "rootProject.name='Demo'\n");
fs.writeFileSync(path.join(source, "app", "build.gradle"), "plugins { id 'com.android.application' }\n");
fs.writeFileSync(path.join(source, "app", "src", "main", "AndroidManifest.xml"), "<manifest package=\"com.example.demo\"/>\n");
fs.writeFileSync(path.join(source, "README.md"), "keep source visible\n");

try {
  const zip = spawnSync("zip", ["-qr", input, "."], { cwd: source, encoding: "utf8" });
  assert.equal(zip.status, 0, `fixture ZIP creation failed: ${zip.stderr}`);
  const beforeHash = spawnSync("sha256sum", [input], { encoding: "utf8" }).stdout.split(/\s+/)[0];
  const command = buildProjectSourcePreflightCommand(input, { sharedRoot });
  const syntax = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
  assert.equal(syntax.status, 0, `generated preflight shell must parse: ${syntax.stderr}`);
  const good = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, AIB_INTERNAL_ROOT: internalRoot } });
  assert.equal(good.status, 0, `supported ZIP should import: ${good.stderr}\n${good.stdout}`);
  assert.match(good.stdout, /PROJECT_SOURCE_READ_OK=1/);
  assert.match(good.stdout, /PROJECT_KIND_PROVEN=gradle/);
  assert.match(good.stdout, /PROJECT_IMPORT=created/);
  const projectRoot = good.stdout.match(/^PROJECT_ROOT=(.+)$/m)?.[1];
  assert.ok(projectRoot?.startsWith(path.join(sharedRoot, "projects") + path.sep), "model-visible source is under shared AIBuilderTermux/projects");
  assert.equal(fs.readFileSync(path.join(projectRoot, "README.md"), "utf8"), "keep source visible\n");
  assert.equal(fs.readFileSync(path.join(internalRoot, "work", "project_root"), "utf8").trim(), projectRoot);
  assert.equal(fs.readFileSync(path.join(internalRoot, "work", "project_kind"), "utf8").trim(), "gradle");
  assert.equal(spawnSync("sha256sum", [input], { encoding: "utf8" }).stdout.split(/\s+/)[0], beforeHash, "the supplied ZIP is never modified");
  assert.equal(fs.readdirSync(path.join(internalRoot, "tmp")).length, 0, "temporary hidden extraction is cleaned up");

  const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  const runArtifactRoot = (src) => spawnSync("bash", ["-c", `set -eu; AIB_ROOT=${shellQuote(sharedRoot)}; SRC=${shellQuote(src)}; ${buildProjectArtifactRootShell()} printf 'ARTIFACT_ROOT=%s\\n' "$ARTIFACT_ROOT"`], { encoding: "utf8" });
  const visibleArtifact = runArtifactRoot(projectRoot);
  assert.equal(visibleArtifact.status, 0, `project artifact path should resolve: ${visibleArtifact.stderr}`);
  assert.equal(visibleArtifact.stdout.trim(), `ARTIFACT_ROOT=${path.join(projectRoot, "outputs")}`);
  assert.ok(fs.statSync(path.join(projectRoot, "outputs")).isDirectory());
  const fallbackArtifact = runArtifactRoot("");
  assert.equal(fallbackArtifact.status, 0, `visible fallback artifact path should resolve: ${fallbackArtifact.stderr}`);
  assert.equal(fallbackArtifact.stdout.trim(), `ARTIFACT_ROOT=${path.join(sharedRoot, "outputs")}`);
  const outsideSource = path.join(temp, "outside-projects");
  fs.mkdirSync(outsideSource);
  const rejectedArtifact = runArtifactRoot(outsideSource);
  assert.notEqual(rejectedArtifact.status, 0, "artifact output must reject project roots outside AIBuilderTermux/projects");
  assert.match(`${rejectedArtifact.stdout}\n${rejectedArtifact.stderr}`, /PROJECT_ARTIFACT_ROOT_INVALID/);
  const symlinkSource = path.join(sharedRoot, "projects", "outside-link");
  fs.symlinkSync(outsideSource, symlinkSource, "dir");
  const rejectedSymlinkArtifact = runArtifactRoot(symlinkSource);
  assert.notEqual(rejectedSymlinkArtifact.status, 0, "artifact output must reject symlink escapes from AIBuilderTermux/projects");
  assert.match(`${rejectedSymlinkArtifact.stdout}\n${rejectedSymlinkArtifact.stderr}`, /PROJECT_ARTIFACT_ROOT_INVALID/);
  assert.equal(fs.existsSync(path.join(outsideSource, "outputs")), false, "symlink escape must never create outputs outside the shared root");

  fs.writeFileSync(path.join(projectRoot, "README.md"), "user edit must survive re-import\n");
  const secondImport = spawnSync("bash", ["-c", buildProjectSourcePreflightCommand(input, { sharedRoot })], { encoding: "utf8", env: { ...process.env, AIB_INTERNAL_ROOT: internalRoot } });
  assert.equal(secondImport.status, 0, `repeat import should create a non-overwriting collision-safe copy: ${secondImport.stderr}`);
  const secondRoot = secondImport.stdout.match(/^PROJECT_ROOT=(.+)$/m)?.[1];
  assert.ok(secondRoot && secondRoot !== projectRoot, "repeat ZIP imports receive distinct project directories");
  assert.equal(fs.readFileSync(path.join(projectRoot, "README.md"), "utf8"), "user edit must survive re-import\n", "existing project edits are never overwritten");
  assert.equal(fs.readFileSync(path.join(secondRoot, "README.md"), "utf8"), "keep source visible\n");

  const projectsDir = path.join(sharedRoot, "projects");
  const visibleBeforeFailedCopy = fs.readdirSync(projectsDir).sort();
  const failBin = path.join(temp, "fail-bin");
  fs.mkdirSync(failBin);
  const failingCp = path.join(failBin, "cp");
  fs.writeFileSync(failingCp, "#!/bin/sh\ntarget=\nfor arg do target=$arg; done\nmkdir -p \"$target\"\nprintf partial > \"$target/partial-copy-marker\"\nexit 19\n");
  fs.chmodSync(failingCp, 0o755);
  const failedCopy = spawnSync("bash", ["-c", buildProjectSourcePreflightCommand(input, { sharedRoot })], {
    encoding: "utf8",
    env: { ...process.env, AIB_INTERNAL_ROOT: internalRoot, PATH: `${failBin}:${process.env.PATH}` },
  });
  assert.notEqual(failedCopy.status, 0, "a partial filesystem copy must fail closed");
  assert.match(`${failedCopy.stdout}\n${failedCopy.stderr}`, /PROJECT_IMPORT_COPY_FAILED/);
  assert.deepEqual(fs.readdirSync(projectsDir).sort(), visibleBeforeFailedCopy, "failed copy never leaves a visible partial project");
  assert.equal(fs.readdirSync(path.join(internalRoot, "tmp")).length, 0, "failed copy cleans private extraction staging");
  assert.equal(fs.readdirSync(projectsDir).some((name) => name.startsWith(".aib-import-") && name.endsWith(".pending")), false, "failed copy removes only its hidden shared-storage staging directory");

  const invalidDir = path.join(temp, "plain-files");
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.writeFileSync(path.join(invalidDir, "hello.txt"), "not an Android project\n");
  const invalidZip = path.join(temp, "plain.zip");
  const invalidCreate = spawnSync("zip", ["-qr", invalidZip, "."], { cwd: invalidDir, encoding: "utf8" });
  assert.equal(invalidCreate.status, 0);
  const invalid = spawnSync("bash", ["-c", buildProjectSourcePreflightCommand(invalidZip, { sharedRoot })], { encoding: "utf8", env: { ...process.env, AIB_INTERNAL_ROOT: internalRoot } });
  assert.notEqual(invalid.status, 0);
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /PROJECT_SOURCE_INVALID kind=unrecognized/);
  assert.equal(fs.readdirSync(path.join(internalRoot, "tmp")).length, 0, "failed input also cleans temporary extraction");

  const traversalZip = path.join(temp, "traversal.zip");
  const maliciousArchive = `import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n z.writestr('../escaped.txt', 'must not escape')\n z.writestr('demo/settings.gradle', "rootProject.name='Demo'\\n")\n z.writestr('demo/app/build.gradle', "plugins { id 'com.android.application' }\\n")\n z.writestr('demo/app/src/main/AndroidManifest.xml', '<manifest/>')\n`;
  const maliciousCreate = spawnSync("python3", ["-c", maliciousArchive, traversalZip], { encoding: "utf8" });
  assert.equal(maliciousCreate.status, 0, `malicious ZIP fixture creation failed: ${maliciousCreate.stderr}`);
  const traversal = spawnSync("bash", ["-c", buildProjectSourcePreflightCommand(traversalZip, { sharedRoot })], { encoding: "utf8", env: { ...process.env, AIB_INTERNAL_ROOT: internalRoot } });
  assert.notEqual(traversal.status, 0, "zip-slip member must be refused before extraction into projects");
  assert.match(`${traversal.stdout}\n${traversal.stderr}`, /PROJECT_ARCHIVE_(?:UNSAFE_MEMBER|PATH_VALIDATION_FAILED)/);
  assert.equal(fs.existsSync(path.join(temp, "escaped.txt")), false, "zip-slip member never escapes the staging directory");

  const symlinkZip = path.join(temp, "symlink.zip");
  const symlinkArchive = `import sys,zipfile\nzi=zipfile.ZipInfo('demo/link')\nzi.create_system=3\nzi.external_attr=(0o120777 << 16)\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n z.writestr('demo/settings.gradle', "rootProject.name='Demo'\\n")\n z.writestr('demo/app/build.gradle', "plugins { id 'com.android.application' }\\n")\n z.writestr('demo/app/src/main/AndroidManifest.xml', '<manifest/>')\n z.writestr(zi, '../../escaped.txt')\n`;
  const symlinkCreate = spawnSync("python3", ["-c", symlinkArchive, symlinkZip], { encoding: "utf8" });
  assert.equal(symlinkCreate.status, 0, `symlink ZIP fixture creation failed: ${symlinkCreate.stderr}`);
  const symlink = spawnSync("bash", ["-c", buildProjectSourcePreflightCommand(symlinkZip, { sharedRoot })], { encoding: "utf8", env: { ...process.env, AIB_INTERNAL_ROOT: internalRoot } });
  assert.notEqual(symlink.status, 0, "symlink member must be refused");
  assert.match(`${symlink.stdout}\n${symlink.stderr}`, /PROJECT_ARCHIVE_LINK_OR_SPECIAL_FILE_DENIED/);
  assert.equal(classifyProjectSourceMarkers(["settings.gradle", "app/build.gradle", "app/src/main/AndroidManifest.xml"]).split("\t")[0], "gradle");
  const expoArchiveMarkers = ["aibuilder-v506/package.json", "aibuilder-v506/app.config.ts", "aibuilder-v506/gradlew", "aibuilder-v506/native/expo-pdf-text-extract/android/src/main/AndroidManifest.xml"];
  assert.equal(classifyProjectSourceMarkers(expoArchiveMarkers), "expo", "paired Expo config must win over the root Gradle wrapper and nested native-module manifest");
  assert.equal(classifyProjectSourceMarkers(["other/package.json", "aibuilder-v506/app.config.ts", "aibuilder-v506/gradlew", "aibuilder-v506/native/AndroidManifest.xml"]), "gradle", "an unrelated package manifest cannot validate a detached Expo config");
  assert.equal(classifyProjectSourceMarkers(["hello.txt"]), null);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("AIB_PROJECT_SOURCE_ROUTING_SELFTEST_OK visible_root=PASS archive_preserved=PASS collision_preserved=PASS zip_slip_denied=PASS symlink_denied=PASS invalid_project_fail_fast=PASS no_source_mutation=PASS visible_artifacts=PASS tmp_cleanup=PASS");
