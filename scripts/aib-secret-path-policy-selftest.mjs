#!/usr/bin/env node
import assert from "node:assert/strict";
import { setAgentUnrestrictedShell } from "../lib/agent-unrestricted.ts";
setAgentUnrestrictedShell(false); // this test covers the strict guard; the unrestricted default is covered by aib-v389-guard-selftest
import { guardTermuxCommand } from "../lib/termux-guard.ts";
import path from "node:path";
import { resolveAllowedWritePath, SHARED_APP_WRITE_ROOTS, AI_BUILDER_SHARED_ROOT } from "../lib/writable-path-policy.ts";

const blockedCommands = [
  "cat .env",
  "sed -n '1,20p' ./config/.env.local",
  "cat config/api_key.json",
  "find . -name .env -exec cat {} \\;",
  "python -c \"print(open('.env').read())\"",
];
for (const command of blockedCommands) {
  const result = guardTermuxCommand(command);
  assert.equal(result.ok, false, `sensitive shell path must be denied: ${command}`);
  assert.match(result.reason, /sensitive file access/i);
  assert.equal(result.confirmable, undefined, "secret-file reads are non-confirmable hard blocks");
}
assert.equal(guardTermuxCommand("cat .env", { allowDangerous: true }).ok, false, "dangerous mode cannot authorize secret-file reads");
assert.equal(guardTermuxCommand("cat .env.example").ok, true, "benign environment templates remain available");
assert.equal(guardTermuxCommand("cat README.md").ok, true, "benign project files remain available");
assert.equal(guardTermuxCommand("ls -la").ok, true);
const blockedRedirects = [
  "printf '%s' payload > /storage/emulated/0/Documents/escape.txt",
  "printf '%s' payload >> '/storage/emulated/0/Documents/escape.txt'",
  "printf '%s' payload | tee /storage/emulated/0/Documents/escape.txt",
  "mkdir -p /storage/emulated/0/Documents/escape-dir",
  "touch /storage/emulated/0/Documents/escape.txt",
  "curl --output=/storage/emulated/0/Documents/escape.bin https://example.invalid/file",
  "wget -O /storage/emulated/0/Documents/escape.bin https://example.invalid/file",
  "dd of=/storage/emulated/0/Documents/escape.bin bs=1 count=0",
  "tar -xf /tmp/archive.tar -C /storage/emulated/0/Documents",
  "unzip archive.zip -d /storage/emulated/0/Documents",
  "sed -i 's/a/b/' /storage/emulated/0/Documents/escape.txt",
  "perl -pi -e 's/a/b/' /storage/emulated/0/Documents/escape.txt",
  "awk -i inplace '{print}' /storage/emulated/0/Documents/escape.txt",
  "vim /storage/emulated/0/Documents/escape.txt",
  "vim -c 'w! /storage/emulated/0/Documents/escape.txt'",
  "git -C /storage/emulated/0/Documents config user.name attacker",
  "git config --system user.name attacker",
  "git config --file=/storage/emulated/0/Documents/gitconfig user.name attacker",
  "cp --target-directory=/storage/emulated/0/Documents safe.txt",
  "cd /storage/emulated/0/Documents; touch escape.txt",
  "bash -c \"printf x > /storage/emulated/0/Documents/escape.txt\"",
  "sh -c 'sed -i s/a/b/ /storage/emulated/0/Documents/escape.txt'",
  "busybox sh -c 'touch /storage/emulated/0/Documents/escape.txt'",
  "bash -c 'cd /storage/emulated/0/Documents; touch escape.txt'",
  "bash -c 'printf x > $(printf /storage/emulated/0/Documents/escape.txt)'",
  "HOME=/storage/emulated/0/Documents sed -i 's/a/b/' $HOME/escape.txt",
  "HOME=/storage/emulated/0/Documents sed -i 's/a/b/' ~/escape.txt",
  "env HOME=/storage/emulated/0/Documents bash -c 'printf x > $HOME/escape.txt'",
  "export HOME=/storage/emulated/0/Documents; bash -c 'printf x > ~/escape.txt'",
  "printf '%s' payload > $HOME/../../storage/emulated/0/Documents/escape.txt",
  "export HOME='/storage/emulated/0/Documents'; printf payload > \"$HOME/escape.txt\"",
];
for (const command of blockedRedirects) {
  const result = guardTermuxCommand(command);
  assert.equal(result.ok, false, `out-of-root shell write must be denied: ${command}`);
}
assert.equal(guardTermuxCommand(blockedRedirects[0], { allowDangerous: true }).ok, false, "dangerous mode cannot authorize out-of-root writes");
assert.equal(guardTermuxCommand("printf '%s' payload > /storage/emulated/0/AIBuilderTermux/projects/demo/out.txt").ok, true, "writes inside the app workspace remain available");
assert.equal(guardTermuxCommand("printf '%s' payload | tee /storage/emulated/0/AIBuilderTermux/projects/demo/out.txt").ok, true, "tee writes inside the app workspace remain available");
assert.equal(guardTermuxCommand("sed -i 's/a/b/' /storage/emulated/0/AIBuilderTermux/projects/demo/file.txt").ok, true, "in-place sed edits inside the app workspace remain available");
assert.equal(guardTermuxCommand("perl -pi -e 's/a/b/' /storage/emulated/0/AIBuilderTermux/projects/demo/file.txt").ok, true, "in-place Perl edits inside the app workspace remain available");
assert.equal(guardTermuxCommand("awk -i inplace '{print}' /storage/emulated/0/AIBuilderTermux/projects/demo/file.txt").ok, true, "in-place awk edits inside the app workspace remain available");
assert.equal(guardTermuxCommand("vim /storage/emulated/0/AIBuilderTermux/projects/demo/file.txt").ok, true, "editor access inside the app workspace remains available");
assert.equal(guardTermuxCommand("vim -c 'w! /storage/emulated/0/AIBuilderTermux/projects/demo/file.txt'").ok, true, "forced editor writes inside the app workspace remain available");
assert.equal(guardTermuxCommand("cd /storage/emulated/0/AIBuilderTermux/projects/demo; touch file.txt").ok, true, "relative mutations after entering the trusted app workspace remain available");
assert.equal(guardTermuxCommand("printf payload | tee /dev/null").ok, true, "the harmless null sink remains available");
assert.equal(guardTermuxCommand("git -C /storage/emulated/0/AIBuilderTermux/projects/demo config user.name tester").ok, true, "trusted Git worktree operations remain available");
assert.equal(guardTermuxCommand("bash -c 'printf x > /storage/emulated/0/AIBuilderTermux/projects/demo/file.txt'").confirmable, true, "nested shell commands require explicit confirmation even for trusted targets");
assert.equal(guardTermuxCommand("printf '%s' payload 2>/dev/null").ok, true, "standard null stderr redirection remains available");
assert.equal(guardTermuxCommand("printf '%s' payload 2>&1").ok, true, "file descriptor duplication remains available");
assert.equal(guardTermuxCommand("sed -i 's/a/b/' /storage/emulated/0/Documents/escape.txt", { allowDangerous: true }).ok, false, "dangerous mode cannot bypass out-of-root editor target checks");
assert.equal(guardTermuxCommand("bash -c 'printf x > /storage/emulated/0/Documents/escape.txt'", { allowDangerous: true }).ok, false, "dangerous mode cannot bypass nested-shell output path checks");
assert.equal(guardTermuxCommand("cp --target-directory=/storage/emulated/0/Documents safe.txt", { allowDangerous: true }).ok, false, "dangerous mode cannot bypass option-form destination containment");
const homeRoot = "/data/data/com.termux/files/home/AIBuilderTermux";
const resolve = async (candidate) => {
  if (candidate.startsWith(`${homeRoot}/symlink/`)) return candidate.replace(`${homeRoot}/symlink`, "/storage/emulated/0/Documents");
  return path.posix.normalize(candidate);
};
assert.equal(await resolveAllowedWritePath(`${homeRoot}/projects/demo/out.txt`, [homeRoot, ...SHARED_APP_WRITE_ROOTS], resolve), `${homeRoot}/projects/demo/out.txt`);
assert.equal(await resolveAllowedWritePath(`${AI_BUILDER_SHARED_ROOT}/backups/export.zip`, [homeRoot, ...SHARED_APP_WRITE_ROOTS], resolve), `${AI_BUILDER_SHARED_ROOT}/backups/export.zip`);
await assert.rejects(() => resolveAllowedWritePath("/storage/emulated/0/Download/export.zip", [homeRoot, ...SHARED_APP_WRITE_ROOTS], resolve), /PATH_OUTSIDE_ALLOWED_WRITE_ROOT/, "default outputs are confined to the visible AIBuilderTermux workspace");
await assert.rejects(() => resolveAllowedWritePath(`${homeRoot}/../outside.txt`, [homeRoot, ...SHARED_APP_WRITE_ROOTS], resolve), /PATH_OUTSIDE_ALLOWED_WRITE_ROOT/);
await assert.rejects(() => resolveAllowedWritePath(`${homeRoot}/symlink/escape.txt`, [homeRoot, ...SHARED_APP_WRITE_ROOTS], resolve), /PATH_OUTSIDE_ALLOWED_WRITE_ROOT/, "a symlink into another storage tree cannot escape the trusted root");
await assert.rejects(() => resolveAllowedWritePath("relative.txt", [homeRoot], resolve), /PATH_INVALID/);
console.log(`AIB_SECRET_PATH_POLICY_SELFTEST_OK blocked=${blockedCommands.length + blockedRedirects.length + 2} benign=6 override=denied`);
