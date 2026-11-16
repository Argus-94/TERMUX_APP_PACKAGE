/**
 * Contract self-test for device/E2E readiness of runtime stack.
 * Does not require a physical device; validates source wiring.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const errors = [];
const ok = (c, m) => {
  if (!c) errors.push(m);
};

const required = [
  "core/RuntimeFacade.ts",
  "core/environment/TermuxTerminalBackend.ts",
  "core/terminal/TerminalOutputBus.ts",
  "core/container/ProotCommandBuilder.ts",
  "core/container/RootfsDiscovery.ts",
  "core/container/RootfsEnsure.ts",
  "core/container/RootfsImageManifest.ts",
  "core/privilege/DevicePrivilegeDetection.ts",
  "lib/agent-tools/runtime/status.ts",
  "lib/agent-tools/runtime/session.ts",
  "lib/agent-tools/runtime/terminal.ts",
  "lib/agent-tools/runtime/proot.ts",
  "app/runtime.tsx",
  "hooks/useRuntime.ts",
  "components/TermuxConsoleContext.tsx",
  "lib/runtime-facade.ts",
];
for (const rel of required) {
  ok(fs.existsSync(path.join(root, rel)), `MISSING:${rel}`);
}

const types = fs.readFileSync(path.join(root, "lib/agent-tools/types.ts"), "utf8");
for (const tool of ["runtime.status", "runtime.session", "runtime.terminal", "runtime.proot"]) {
  ok(types.includes(`"${tool}"`), `TOOL_NOT_REGISTERED:${tool}`);
}

const backend = fs.readFileSync(
  path.join(root, "core/environment/TermuxTerminalBackend.ts"),
  "utf8",
);
ok(backend.includes("publishTerminalOutput"), "TERMINAL_STREAM_NOT_WIRED");

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
for (const token of [
  "runProotAuto",
  "ensureRootfs",
  "openTerminalForProject",
  "createAgentForProject",
  "finalValidation",
]) {
  ok(facade.includes(token), `FACADE_MISSING:${token}`);
}

const bridge = fs.readFileSync(path.join(root, "lib/termux-bridge.ts"), "utf8");
ok(bridge.includes("emitJsConsoleEvent"), "BRIDGE_JS_CONSOLE_MISSING");
ok(bridge.includes("subscribeTermuxOutput"), "BRIDGE_SUBSCRIBE_MISSING");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
console.log(`AIB_RUNTIME_E2E_CONTRACT_SELFTEST_OK version=${pkg.version}`);
