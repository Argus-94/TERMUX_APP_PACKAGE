#!/usr/bin/env node
import assert from "node:assert/strict";
import { guardReadOnlyTermuxCommand } from "../lib/termux-guard.ts";

for (const command of ["git branch -D topic", "git branch -d topic", "git branch -m old new", "git branch --delete topic"]) {
  const result = guardReadOnlyTermuxCommand(command);
  assert.equal(result.ok, false, `read-only subagent rejects mutating Git operation: ${command}`);
}
for (const command of ["git status --short", "git log -1", "git rev-parse --show-toplevel"]) {
  assert.equal(guardReadOnlyTermuxCommand(command).ok, true, `safe Git inspection remains available: ${command}`);
}
for (const command of ["cat secret-link", "head secret-link", "tail secret-link", "sed -n 1p secret-link", "grep x secret-link", "rg x secret-link", "find secret-link", "ls secret-link"]) {
  assert.equal(guardReadOnlyTermuxCommand(command).ok, false, `file-reading command must use the guarded AIB_TOOL path: ${command}`);
}
assert.equal(guardReadOnlyTermuxCommand("git log --output=outside.txt").ok, false, "Git output-file options are not allowed in read-only mode");
console.log("AIB_READONLY_GIT_GUARD_SELFTEST_OK destructive_branch=blocked symlink_read_shell=blocked git_output=blocked safe_inspection=retained");
