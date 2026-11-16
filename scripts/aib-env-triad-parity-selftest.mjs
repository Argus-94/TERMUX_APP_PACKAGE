#!/usr/bin/env node
/**
 * Env parity: Termux + Ubuntu only (Debian removed).
 */
import fs from "node:fs";
const fail = (m) => { console.error("AIB_ENV_TRIAD_FAIL", m); process.exit(1); };
const backend = fs.readFileSync("lib/agent-shell-backend.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const runner = fs.readFileSync("lib/agent-playbook-runner.ts", "utf8");
const env = fs.readFileSync("lib/agent-env-state.ts", "utf8");
const policy = fs.readFileSync("lib/agent-policy-router.ts", "utf8");
const goal = fs.readFileSync("lib/agent-goal.ts", "utf8");
const usp = fs.readFileSync("lib/user-storage-paths.ts", "utf8");
const ctx = fs.readFileSync("lib/agent-runtime-context.ts", "utf8");

for (const x of ["termux", "ubuntu-proot", "TERMUX_RUN", "UBUNTU_RUN"]) {
  if (!backend.includes(x) && !env.includes(x) && !ctx.includes(x)) fail("missing:" + x);
}
if (backend.includes('AgentShellBackend = "termux" | "ubuntu-proot" | "debian-proot"')) {
  fail("debian_still_in_type");
}
if (!backend.includes("isLinuxProotBackend")) fail("isLinuxProot");
if (!runner.includes("preferGuest") || !runner.includes("retry host Termux")) fail("guest_first");
if (!policy.includes('backend === "termux"')) fail("policy_backend");
if (!goal.includes("resolveUserStorageBase") && !usp.includes("resolveUserStorageBase")) {
  /* soft */ 
}
if (!ctx.includes("ubuntu-proot") || !ctx.includes("termux")) fail("runtime_context");
if (ctx.includes("debian-proot")) fail("context_has_debian");
console.log("AIB_ENV_TRIAD_OK termux+ubuntu");
