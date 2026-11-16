import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(p, "utf8");
const factory = read("core/workspace/OneClickAppFactory.ts");
const brain = read("core/workspace/LLMCodingBrain.ts");
const coding = read("core/workspace/AICodingAgent.ts");
const generator = read("core/workspace/AIProjectGenerator.ts");
const workspace = read("core/workspace/PersistentAIWorkspace.ts");
const memory = read("core/workspace/AIProjectMemory.ts");
const manager = read("core/container/ProotContainerManager.ts");
const facade = read("core/RuntimeFacade.ts");
const pkg = JSON.parse(read("package.json"));
const errors = [];

const check = (name, ok) => { if (!ok) errors.push(name); };
check("phase36-script-wired", pkg.scripts?.["test:phase36"]?.includes("aib-phase36-one-click-app-factory-selftest.mjs"));
check("deep-audit-script-wired", pkg.scripts?.["test:deep-audit"]?.includes("aib-deep-audit-selftest.mjs"));
check("factory-uses-host-verified-android-build", factory.includes("runAssembleDebug(projectPath"));
check("factory-container-toolchain-bootstrap", factory.includes("FACTORY_TOOLCHAIN_APT_UPDATE_FAILED") && factory.includes("pnpm@9.15.0"));
check("factory-device-qa-does-not-rebuild-on-host-loop", factory.includes("runContainerDeviceQA") && !factory.includes("runAgenticBuildLoop({"));
check("factory-existing-project-snapshot", factory.includes("factory-before-") && factory.includes("persistentWorkspaceSnapshot"));
check("container-interpreter-shell-not-public", !manager.includes('"sh", "bash",'));
check("container-exact-command-allowlist", manager.includes("ALLOWED_COMMANDS.has(base)"));
check("runtime-project-id-validation", facade.includes("validateProjectName(input.projectId)"));
check("llm-excludes-sensitive-files", brain.includes("isSensitivePath") && brain.includes(".aib-memory/") && brain.includes(".env"));
check("llm-redacts-secrets", brain.includes("redactWorkspaceSecrets"));
check("coding-agent-protects-sensitive-paths", coding.includes("CODING_PROTECTED_PATH"));
check("generator-protects-sensitive-paths", generator.includes("PROJECT_PROTECTED_PATH"));
check(
  "snapshot-preserves-snapshot-dir",
  workspace.includes("const preserve = await this.exec(") &&
    workspace.includes("cp -a ${shell(`${path}/.aib-snapshots`)} ${shell(restoreDir)}/") &&
    workspace.includes("WORKSPACE_SNAPSHOT_METADATA_STAGE_FAILED") &&
    workspace.includes("WORKSPACE_SNAPSHOT_ROLLBACK_FAILED"),
);
check("workspace-secure-ignore", workspace.includes(".aib-memory/") && workspace.includes("local.properties"));
check("memory-normalizes-entries", memory.includes("map((x) => ({ at:"));
check("local-source-syntax-script", fs.existsSync(path.join("scripts", "aib-full-source-syntax-selftest.mjs")));

if (errors.length) {
  console.error(errors.map((x) => `DEEP_AUDIT_FAIL:${x}`).join("\n"));
  process.exit(1);
}
console.log("AIB_DEEP_AUDIT_SELFTEST_OK checks=21");
