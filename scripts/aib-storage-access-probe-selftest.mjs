#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { buildStorageAccessProbeCommand, classifyStorageAccessProbeExitCode } = await import("../core/enhancements/onboarding/StorageAccessProbe.ts");
const runtimeFacade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
const command = buildStorageAccessProbeCommand("/storage/emulated/0/AIBuilderTermux");
for (const token of [
  "test -d '/storage/emulated/0'",
  "test -r '/storage/emulated/0'",
  "test -w '/storage/emulated/0'",
  "test -x '/storage/emulated/0'",
  "test -d '/storage/emulated/0/AIBuilderTermux'",
  "test -r '/storage/emulated/0/AIBuilderTermux'",
  "test -w '/storage/emulated/0/AIBuilderTermux'",
  "test -x '/storage/emulated/0/AIBuilderTermux'",
]) assert.ok(command.includes(token), `storage probe missing ${token}`);
assert.doesNotMatch(command, /\b(rm|touch|mkdir|rmdir|tee)\b/, "the permission probe must not mutate user files");
assert.throws(() => buildStorageAccessProbeCommand("/tmp/not-the-user-root"), /STORAGE_HOME_ROOT_UNEXPECTED/);
assert.equal(classifyStorageAccessProbeExitCode(0), "ok");
assert.equal(classifyStorageAccessProbeExitCode(1), "denied");
assert.equal(classifyStorageAccessProbeExitCode(126), "unknown");
assert.match(runtimeFacade, /buildStorageAccessProbeCommand\(this\.home\.root\)/);
assert.match(runtimeFacade, /classifyStorageAccessProbeExitCode\(probe\.exitCode\)/);
assert.doesNotMatch(runtimeFacade, /environment\.exists\("\/storage\/emulated\/0"\)/, "existence alone must not report writable storage readiness");
console.log("AIB_STORAGE_ACCESS_PROBE_SELFTEST_OK sharedRoot=read-write-traverse workspace=read-write-traverse mutation=none");
