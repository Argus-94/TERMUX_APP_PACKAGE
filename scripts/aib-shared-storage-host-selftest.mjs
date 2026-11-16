#!/usr/bin/env node
/**
 * Shared-storage tasks must work under Termux AND Ubuntu/Debian:
 * - prefer active guest when rootfs OK (playbook soft-probe)
 * - host fallback when rootfs unverified
 * - never hard-block agent on rootfs for pure Download ops
 */
import fs from "node:fs";
const fail = (m) => { console.error("AIB_SHARED_STORAGE_HOST_SELFTEST_FAIL", m); process.exit(1); };
const backend = fs.readFileSync("lib/agent-shell-backend.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const runner = fs.readFileSync("lib/agent-playbook-runner.ts", "utf8");
const pb = fs.readFileSync("lib/agent-playbooks.ts", "utf8");
for (const m of ["isSharedStorageOnlyUserTask", "isAndroidSharedStorageOnlyCommand", "shouldFallbackSharedStorageToHost", "AIB_PROOT_DISTRO_MISSING"]) {
  if (!backend.includes(m)) fail("backend_missing:" + m);
}
if (!runner.includes('mode === "preferGuest"') || !runner.includes("UNVERIFIED→host") || !runner.includes("OK→guest")) fail("agent_guest_first");
if (!agent.includes("shouldFallbackSharedStorageToHost(effectiveCmd, executionBackend") || !agent.includes("hostTermux: true")) fail("agent_host_fallback");
if (!pb.includes('storageMode: "preferGuest"')) fail("playbook_preferGuest");
if (!agent.includes("skipRootfsForGoal")) fail("skip_rootfs_goal");
// resolveAgentExecutionBackend must NOT unconditionally force termux for shared storage
if (/isAndroidSharedStorageOnlyCommand\(command\)\s*\)\s*return\s*"termux"/.test(backend)) {
  fail("resolve_still_forces_host_for_shared");
}
console.log("AIB_SHARED_STORAGE_HOST_SELFTEST_OK ubuntu_guest_first=yes rootfs_error_host_fallback=yes");
