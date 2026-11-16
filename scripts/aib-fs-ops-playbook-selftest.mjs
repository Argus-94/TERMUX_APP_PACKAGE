#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_FS_OPS_FAIL", m); process.exit(1); };
const goal = fs.readFileSync("lib/agent-goal.ts", "utf8");
const pb = fs.readFileSync("lib/agent-playbooks.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const runner = fs.readFileSync("lib/agent-playbook-runner.ts", "utf8");
const intent = fs.readFileSync("lib/termux-intent.ts", "utf8");
const llm = fs.readFileSync("hooks/useLLM.ts", "utf8");
for (const k of ["file_rename", "file_copy", "dir_list"]) {
  if (!goal.includes(`"${k}"`) || !goal.includes(`kind: "${k}"`)) fail("goal:" + k);
}
for (const fn of ["tryFileRenamePlaybook", "tryFileCopyPlaybook", "tryDirListPlaybook"]) {
  if (!pb.includes(fn)) fail("pb:" + fn);
}
if (!pb.includes("wantApk")) fail("github_apk");
if (!runner.includes("__MATERIALIZE_BUILD__") || !agent.includes("executeDeterministicPlaybook")) fail("build_inject");
if (!intent.includes("переимен") && !intent.includes("rename")) fail("intent");
if (!llm.includes("isSharedStorageOnlyUserTask")) fail("llm_storage");
console.log("AIB_FS_OPS_PLAYBOOK_SELFTEST_OK rename+copy+list+github_apk+routing");
