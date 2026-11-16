#!/usr/bin/env node
// Run with: node --experimental-strip-types scripts/aib-profile-transfer-regression-selftest.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildProfileExportCommand, buildProfileImportCommand } from "../lib/profile-transfer-shell.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-profile-transfer-"));
const marker = path.join(temp, "AIB_PWNED");
const exportRoot = path.join(temp, "shared-root");
fs.mkdirSync(exportRoot, { recursive: true });
const run = (command, env = process.env) => spawnSync("bash", ["-c", command], {
  cwd: temp,
  encoding: "utf8",
  env,
  timeout: 15_000,
});

try {
  const home = path.join(temp, "home'$(touch AIB_PWNED)");
  for (const name of ["metadata", "projects", ".aibuilder"]) fs.mkdirSync(path.join(home, name), { recursive: true });
  fs.writeFileSync(path.join(home, "metadata", "profile.json"), "{}");
  fs.writeFileSync(path.join(home, "metadata", "access-token.json"), "secret");
  fs.writeFileSync(path.join(home, "projects", "README.txt"), "project data");
  fs.writeFileSync(path.join(home, "projects", "api_key.json"), "secret");
  fs.writeFileSync(path.join(home, ".aibuilder", "state.json"), "{}");
  fs.mkdirSync(path.join(home, ".aibuilder", "keys"), { recursive: true });
  fs.writeFileSync(path.join(home, ".aibuilder", "keys", "release.jks"), "synthetic archive fixture");

  const archive = path.join(exportRoot, "archive'$(touch AIB_PWNED).tar.gz");
  const exported = run(buildProfileExportCommand(archive, home, exportRoot));
  assert.equal(exported.status, 0, `${exported.stdout}\n${exported.stderr}`);
  assert.match(exported.stdout, /PROFILE_EXPORT_OK/);
  assert.equal(fs.existsSync(marker), false, "path substitution executed during export");
  const list = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /metadata\/profile\.json/);
  assert.doesNotMatch(list.stdout, /access-token|api_key/);
  assert.match(list.stdout, /projects\/README\.txt/);
  assert.match(list.stdout, /\.aibuilder\/state\.json/);
  assert.doesNotMatch(list.stdout, /\.aibuilder\/keys|release\.jks/);

  const fakeBin = path.join(temp, "fake-bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "tar"), "#!/bin/sh\nprintf partial > \"$2\"\nexit 7\n", { mode: 0o755 });
  const failedArchive = path.join(exportRoot, "failed.tar.gz");
  const failed = run(buildProfileExportCommand(failedArchive, home, exportRoot), {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || "/usr/bin:/bin"}`,
  });
  assert.equal(failed.status, 7, `${failed.stdout}\n${failed.stderr}`);
  assert.match(failed.stdout, /PROFILE_EXPORT_FAIL/);
  assert.doesNotMatch(failed.stdout, /PROFILE_EXPORT_OK/);
  assert.equal(fs.existsSync(failedArchive), false, "partial archive was committed after tar failure");
  assert.equal(fs.readdirSync(exportRoot).some((name) => name.startsWith("failed.tar.gz.aibuilder.tmp.")), false);

  const outsideExport = path.join(temp, "outside-export");
  fs.mkdirSync(outsideExport);
  fs.symlinkSync(outsideExport, path.join(exportRoot, "redirect"));
  const escapedArchive = path.join(outsideExport, "escaped.tar.gz");
  const escaped = run(buildProfileExportCommand(escapedArchive, home, exportRoot));
  assert.notEqual(escaped.status, 0, "canonical path checks reject a symlinked parent before archive creation");
  assert.match(`${escaped.stdout}\n${escaped.stderr}`, /PROFILE_EXPORT_SYMLINK_ESCAPE/);
  assert.equal(fs.existsSync(escapedArchive), false);
  assert.equal(fs.readdirSync(outsideExport).length, 0, "symlink escape preflight creates no outside artifacts");

  const importStage = path.join(temp, "import-stage");
  fs.mkdirSync(path.join(importStage, "metadata"), { recursive: true });
  fs.writeFileSync(path.join(importStage, "metadata", "imported.txt"), "restored");
  const importArchive = path.join(temp, "import'$(touch AIB_PWNED).tar.gz");
  const created = spawnSync("tar", ["-czf", importArchive, "metadata"], { cwd: importStage, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const importRoot = path.join(temp, "restore-home");
  const imported = run(buildProfileImportCommand(importArchive, importRoot));
  assert.equal(imported.status, 0, `${imported.stdout}\n${imported.stderr}`);
  assert.match(imported.stdout, /PROFILE_IMPORT_OK/);
  assert.equal(fs.readFileSync(path.join(importRoot, "metadata", "imported.txt"), "utf8"), "restored");
  assert.equal(fs.existsSync(marker), false, "path substitution executed during import");

  const maliciousStage = path.join(temp, "malicious-stage");
  const outside = path.join(temp, "outside-profile");
  const blockedHome = path.join(temp, "blocked-home");
  fs.mkdirSync(maliciousStage);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(blockedHome, "projects"), { recursive: true });
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside-safe");
  fs.writeFileSync(path.join(blockedHome, "projects", "keep.txt"), "active-safe");
  fs.symlinkSync(outside, path.join(maliciousStage, "projects"));
  const maliciousArchive = path.join(temp, "malicious-profile.tar.gz");
  const maliciousCreated = spawnSync("tar", ["-czf", maliciousArchive, "-C", maliciousStage, "projects"], { encoding: "utf8" });
  assert.equal(maliciousCreated.status, 0, maliciousCreated.stderr);
  const blocked = run(buildProfileImportCommand(maliciousArchive, blockedHome));
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /PROFILE_IMPORT_LINK_FORBIDDEN/);
  assert.equal(fs.readFileSync(path.join(blockedHome, "projects", "keep.txt"), "utf8"), "active-safe");
  assert.equal(fs.lstatSync(path.join(blockedHome, "projects")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "outside-safe");

  const secretImportStage = path.join(temp, "secret-import-stage");
  fs.mkdirSync(path.join(secretImportStage, "metadata"), { recursive: true });
  fs.writeFileSync(path.join(secretImportStage, "metadata", "api_key.json"), "never import");
  const secretArchive = path.join(temp, "secret-profile.tar.gz");
  const secretCreated = spawnSync("tar", ["-czf", secretArchive, "metadata"], { cwd: secretImportStage, encoding: "utf8" });
  assert.equal(secretCreated.status, 0, secretCreated.stderr);
  const secretBlocked = run(buildProfileImportCommand(secretArchive, blockedHome));
  assert.notEqual(secretBlocked.status, 0);
  assert.match(secretBlocked.stderr, /PROFILE_IMPORT_SECRET_FORBIDDEN/);

  const secretContentStage = path.join(temp, "secret-content-import-stage");
  fs.mkdirSync(path.join(secretContentStage, "metadata"), { recursive: true });
  fs.writeFileSync(path.join(secretContentStage, "metadata", "ordinary.json"), JSON.stringify({ api_key: "sk-SYNTHETICTESTFIXTURE01XXX6789" }));
  const secretContentArchive = path.join(temp, "secret-content-profile.tar.gz");
  const secretContentCreated = spawnSync("tar", ["-czf", secretContentArchive, "metadata"], { cwd: secretContentStage, encoding: "utf8" });
  assert.equal(secretContentCreated.status, 0, secretContentCreated.stderr);
  const secretContentBlocked = run(buildProfileImportCommand(secretContentArchive, blockedHome));
  assert.notEqual(secretContentBlocked.status, 0);
  assert.match(`${secretContentBlocked.stdout}\n${secretContentBlocked.stderr}`, /PROFILE_IMPORT_SECRET_CONTENT_FORBIDDEN/);

  const keyStoreStage = path.join(temp, "keystore-import-stage");
  fs.mkdirSync(path.join(keyStoreStage, ".aibuilder", "keys"), { recursive: true });
  fs.writeFileSync(path.join(keyStoreStage, ".aibuilder", "keys", "release.jks"), "synthetic archive fixture");
  const keyStoreArchive = path.join(temp, "keystore-profile.tar.gz");
  const keyStoreCreated = spawnSync("tar", ["-czf", keyStoreArchive, ".aibuilder"], { cwd: keyStoreStage, encoding: "utf8" });
  assert.equal(keyStoreCreated.status, 0, keyStoreCreated.stderr);
  const keyStoreBlocked = run(buildProfileImportCommand(keyStoreArchive, blockedHome));
  assert.notEqual(keyStoreBlocked.status, 0);
  assert.match(`${keyStoreBlocked.stdout}\n${keyStoreBlocked.stderr}`, /PROFILE_IMPORT_SECRET_FORBIDDEN/);

  const secretConfig = path.join(home, "projects", "config.json");
  fs.writeFileSync(secretConfig, JSON.stringify({ OPENROUTER_API_KEY: "sk-SYNTHETICTESTFIXTURE02XXXX6789" }));
  const secretExportPath = path.join(exportRoot, "secret-content-export.tar.gz");
  const secretExport = run(buildProfileExportCommand(secretExportPath, home, exportRoot));
  assert.notEqual(secretExport.status, 0);
  assert.match(`${secretExport.stdout}\n${secretExport.stderr}`, /PROFILE_EXPORT_SECRET_CONTENT_FORBIDDEN/);
  assert.equal(fs.existsSync(secretExportPath), false, "secret-bearing profile archives are never committed");
  fs.unlinkSync(secretConfig);

  const gitlabTokenStage = path.join(temp, "gitlab-token-stage");
  fs.mkdirSync(path.join(gitlabTokenStage, "metadata"), { recursive: true });
  fs.writeFileSync(path.join(gitlabTokenStage, "metadata", "ordinary.txt"), "synthetic token fixture glpat-ABCDEFGHIJKLMNOPQRSTUVWX");
  const gitlabTokenArchive = path.join(temp, "gitlab-token-profile.tar.gz");
  const gitlabTokenCreated = spawnSync("tar", ["-czf", gitlabTokenArchive, "metadata"], { cwd: gitlabTokenStage, encoding: "utf8" });
  assert.equal(gitlabTokenCreated.status, 0, gitlabTokenCreated.stderr);
  const gitlabTokenBlocked = run(buildProfileImportCommand(gitlabTokenArchive, blockedHome));
  assert.notEqual(gitlabTokenBlocked.status, 0);
  assert.match(`${gitlabTokenBlocked.stdout}\n${gitlabTokenBlocked.stderr}`, /PROFILE_IMPORT_SECRET_CONTENT_FORBIDDEN/);

  console.log("AIB_PROFILE_TRANSFER_REGRESSION_OK shell_quoting=verified tar_failure=fail_closed symlink_escape=blocked content_secrets=blocked gitlabPat=blocked keys_jks=blocked import=verified links=blocked");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
