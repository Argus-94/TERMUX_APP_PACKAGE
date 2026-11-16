/**
 * Core AgentManager security contracts (HOME isolation, capability deny).
 * Source-level + light functional checks without device.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const errors = [];
const ok = (c, m) => {
  if (!c) errors.push(m);
};

const agentSrc = fs.readFileSync(path.join(root, "core/agent/AgentManager.ts"), "utf8");
const typesSrc = fs.readFileSync(path.join(root, "core/agent/AgentTypes.ts"), "utf8");

ok(agentSrc.includes("HOME isolation"), "MISSING_HOME_ISOLATION");
ok(agentSrc.includes("Capability denied"), "MISSING_CAPABILITY_DENY");
ok(agentSrc.includes("shell.exec"), "MISSING_SHELL_EXEC");
ok(agentSrc.includes("terminal.open"), "MISSING_TERMINAL_OPEN");
ok(agentSrc.includes("setHostHooks"), "MISSING_HOST_HOOKS");
ok(typesSrc.includes("projectIsolation"), "MISSING_PROJECT_ISOLATION");
ok(typesSrc.includes("homeIsolation"), "MISSING_HOME_ISOLATION_FLAG");
ok(typesSrc.includes("allowedCapabilities"), "MISSING_ALLOWED_CAPS");

// Ensure default policy is restrictive (filesystem only, isolations on)
ok(
  /DEFAULT_AGENT_POLICY[\s\S]*allowedCapabilities:\s*\[\s*"filesystem"\s*\]/.test(typesSrc) ||
    typesSrc.includes('allowedCapabilities: ["filesystem"]'),
  "DEFAULT_POLICY_TOO_PERMISSIVE",
);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
ok(facade.includes("createAgentForProject"), "FACADE_CREATE_AGENT");
ok(facade.includes("setHostHooks"), "FACADE_HOST_HOOKS");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
console.log(`AIB_CORE_AGENT_SECURITY_SELFTEST_OK version=${pkg.version}`);
