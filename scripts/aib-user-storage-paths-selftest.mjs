#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_USER_STORAGE_FAIL", m); process.exit(1); };
const src = fs.readFileSync("lib/user-storage-paths.ts", "utf8");
const goal = fs.readFileSync("lib/agent-goal.ts", "utf8");
const backend = fs.readFileSync("lib/agent-shell-backend.ts", "utf8");
const intent = fs.readFileSync("lib/termux-intent.ts", "utf8");
for (const d of ["Download", "Documents", "Pictures", "DCIM", "Music", "Movies", "AIBuilderTermux"]) {
  if (!src.includes(d)) fail("missing_dir:" + d);
}
if (!src.includes("SYSTEM_PATH_RE") || !src.includes("/system")) fail("no_system_block");
if (!src.includes("isUserSharedAbsolutePath") || !src.includes("resolveUserStorageBase")) fail("api");
if (!goal.includes("resolveUserStorageBase") || !goal.includes("joinUserStorage")) fail("goal_not_wired");
if (goal.includes('const DOWNLOAD =')) fail("goal_still_download_only");
if (!backend.includes("Pictures") || !backend.includes("Music")) fail("backend_folders");
if (!intent.includes("Pictures") || !intent.includes("Movies")) fail("intent_folders");
console.log("AIB_USER_STORAGE_PATHS_SELFTEST_OK dirs=Download,Documents,Pictures,DCIM,Music,Movies,AIBuilderTermux system_blocked=yes");
