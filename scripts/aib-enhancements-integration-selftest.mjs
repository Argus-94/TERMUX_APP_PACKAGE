#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const enhancementsIndex = read("core/enhancements/index.ts");
for (const moduleName of ["auth", "checkpoint", "manifest", "supervisor", "lifecycle", "isolation", "timeline", "snapshot"]) assert.match(enhancementsIndex, new RegExp(`from \\"\\./${moduleName}\\"`));
const coreIndex = read("core/index.ts");
assert.match(coreIndex, /export \* from "\.\/enhancements"/);
assert.match(coreIndex, /ProotCommandError/);
const manifestBarrel = read("core/enhancements/manifest/index.ts");
assert.match(manifestBarrel, /export const RuntimeManifest/);
assert.match(manifestBarrel, /export const Presets/);
for (const file of [
  "core/enhancements/auth/index.ts",
  "core/enhancements/checkpoint/index.ts",
  "core/enhancements/manifest/index.ts",
  "core/enhancements/supervisor/index.ts",
  "core/enhancements/lifecycle/index.ts",
  "core/enhancements/isolation/index.ts",
  "core/enhancements/timeline/index.ts",
  "core/enhancements/snapshot/index.ts",
]) assert.ok(fs.existsSync(path.join(root, file)), `barrel missing: ${file}`);

const facade = read("core/RuntimeFacade.ts");
for (const contract of ["agentAuthStore: Pick<AgentAuthStore", "#agentAuthStore: AgentAuthStore", "credentialProxy: CredentialProxy", "timeline: ActivityTimeline", "checkpoints: TaskCheckpointManager", "workspaceSnapshots: WorkspaceSnapshot", "setAppLifecycleState(", "tickMaintenance(", "startAgentCredentialProxy(", "applyRuntimeManifest(", "workspaceSnapshots", "this.userspace.applyManifest(manifest, name)"]) assert.ok(facade.includes(contract), `RuntimeFacade integration missing: ${contract}`);
assert.match(facade, /taskProxySessions\.set\([\s\S]*proxyConfig\.sessionId/);
assert.match(facade, /credentialProxy\.stopSession\(sessionId\)/);
assert.match(facade, /const canonicalManifestPath = await this\.environment\.resolvePath\(file\)/);
assert.match(facade, /canonicalManifestPath\.startsWith\(/);
assert.match(facade, /environment\.read\(canonicalManifestPath\)/);

const agent = read("core/agent/AgentManager.ts");
assert.match(agent, /wakeForTask\?\.\(agent\)/);
assert.match(agent, /beforeTask\?\.\(agent, activeTaskId, promptSummary, request\)/);
assert.match(agent, /env: taskEnv/);
assert.match(agent, /finishTask\(/);

const runtime = read("core/runtime/AibUserspaceRuntime.ts");
assert.match(runtime, /manifestApplier/);
assert.match(runtime, /async applyManifest\(/);
const backend = read("core/runtime/RuntimeBackend.ts");
assert.match(backend, /credentialProxy\?: ProxyClientConfiguration/);
assert.match(backend, /hardening\?: HardenedProotPolicy/);
for (const rel of ["core/runtime/backends/TermuxNativeBackend.ts", "core/runtime/backends/ProotDistroBackend.ts"]) assert.match(read(rel), /buildProxySafeEnvironment\(req\.env \?\? \{\}, req\.credentialProxy\)/);

const maintenance = read("core/runtime/RuntimeMaintenanceCoordinator.ts");
assert.match(maintenance, /async tick\(/);
assert.match(maintenance, /wakeContainer\(/);
const appConfig = read("app.config.ts");
assert.match(appConfig, /withAibCredentialProxy/);
const plugin = read("plugins/withAibCredentialProxy.js");
assert.match(plugin, /AibCredentialProxyPackage\(\)/);
assert.match(plugin, /AibCredentialHttpProxyServer\.java/);

console.log("AIB_ENHANCEMENTS_INTEGRATION_SELFTEST_OK barrels=8 facade=agent,auth,checkpoint,timeline,snapshot lifecycle=maintenance backends=termux,proot");
