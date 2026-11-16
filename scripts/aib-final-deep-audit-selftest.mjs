import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const linux = read("core/linux/LinuxRuntime.ts");
const container = read("core/container/ProotContainerManager.ts");
const factory = read("core/workspace/OneClickAppFactory.ts");
const brain = read("core/workspace/LLMCodingBrain.ts");
const memory = read("core/workspace/AIProjectMemory.ts");
const errors = [];
const check = (name, ok) => { if (!ok) errors.push(name); };

check("linux-shell-bypass-removed", !linux.includes('"sh", "bash"'));
check("linux-cwd-hardening", linux.includes("function isSafeCwd") && linux.includes('cwd === "/tmp"') && linux.includes('cwd.slice(1).split("/")') && linux.includes('part !== ".."') && linux.includes('part !== ""'));
check("linux-rootfs-requires-proot", linux.includes('if (await this.commandExists("proot") !== true) return { kind: "unverified", path: candidate };'));
check("container-cwd-hardening", container.includes("function isSafeWorkspaceCwd") && container.includes('cwd.split("/").includes("..")'));
check("factory-stage-duration-fixed", factory.includes("currentStageStartedAt") && factory.includes("record(currentStage, false, message, currentStageStartedAt)"));
check("llm-goal-redacted", brain.includes("redactWorkspaceSecrets(context.goal)"));
check("llm-build-result-redacted", brain.includes("redactWorkspaceSecrets(previous)"));
check("llm-memory-redacted", brain.includes("redactWorkspaceSecrets(context.memoryContext"));
check("memory-persist-normalized", memory.includes("await this.save(normalized)"));

if (errors.length) {
  console.error(errors.map((x) => `FINAL_DEEP_AUDIT_FAIL:${x}`).join("\n"));
  process.exit(1);
}
console.log("AIB_FINAL_DEEP_AUDIT_SELFTEST_OK checks=9");
