#!/usr/bin/env node
import assert from "node:assert/strict";import fs from "node:fs";import os from "node:os";import path from "node:path";import {createRequire} from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";
const root = process.cwd();
const require = createRequire(import.meta.url);
const ts = typescript;
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-supervisor-"));
const files = ["core/enhancements/manifest/types.ts", "core/enhancements/manifest/RuntimeManifest.ts", "core/enhancements/supervisor/types.ts", "core/enhancements/supervisor/InContainerSupervisor.ts", "core/runtime/SupervisorPolicy.ts", "core/runtime/RuntimeSupervisor.ts", "core/process/ProcessRegistry.ts", "core/runtime/RuntimeJournal.ts"];
try {
  for (const rel of files) {
    const dest = path.join(out, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, ts.transpile(fs.readFileSync(path.join(root, rel), "utf8"), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }));
  }
  const { ProcessRegistry } = require(path.join(out, "core/process/ProcessRegistry.js"));
  const { RuntimeSupervisor } = require(path.join(out, "core/runtime/RuntimeSupervisor.js"));
  const { RuntimeJournal } = require(path.join(out, "core/runtime/RuntimeJournal.js"));
  const { InContainerSupervisor } = require(path.join(out, "core/enhancements/supervisor/InContainerSupervisor.js"));
  const registry = new ProcessRegistry();
  const store = { value: null, async read() { return this.value; }, async write(value) { this.value = value; } };
  const journal = new RuntimeJournal(store);
  const removed = [], started = [], stopped = [], authorized = [], restartSpecs = [], builds = [], deniedCommands = new Set();
  let idSuffix = 1;
  let service;
  const supervisor = new RuntimeSupervisor(registry, async (process) => {
    removed.push(process.id);
    if (process.metadata?.manifestManaged === "true") await service.stopFailedProcess(process);
    else registry.unregister(process.id);
  }, undefined);
  const manifestAdapter = {
    authorize: (command, name, capabilities = []) => { authorized.push({ command, name, capabilities: [...capabilities] }); return !deniedCommands.has(command); },
    start: async (process, options = {}) => { let id = process.name; while (options.occupiedIds?.includes(id)) id = `${process.name}-${++idSuffix}`; started.push(id); return { id, pid: 100 + idSuffix }; },
    stop: async (id) => { stopped.push(id); },
    runOnce: async (command, env, capabilities = []) => { builds.push({ command, env, capabilities: [...capabilities] }); },
  };
  let healthy = true, restarts = 0, canRestart = true, probes = 0;
  const processAdapter = {
    probe: async () => { probes++; return healthy; },
    restart: async (_process, spec) => { restarts++; restartSpecs.push(spec); return canRestart; },
    collectOutput: async () => ({ stdout: "token=unsafe-secret Authorization: Bearer abc-secret", stderr: "ready Authorization: Bearer stderr-secret" }),
  };
  service = new InContainerSupervisor(registry, supervisor, journal, processAdapter, manifestAdapter);
  const capabilities = ["terminal", "network", "web", "build"];
  await service.apply({ version: 1, web: { command: "npm run dev", health: "check" }, health: { command: "fallback-health", intervalMs: 15000 }, build: { command: "npm run build", afterTask: true }, restartAfterTask: true, capabilities }, "demo");
  const process = registry.get("web");
  assert.equal(process.metadata.manifestManaged, "true");
  assert.equal(process.metadata.healthIntervalMs, "15000");
  assert.ok(authorized.some((entry) => entry.name === "web" && entry.capabilities.includes("web")));
  assert.ok(authorized.some((entry) => entry.name === "web:health" && entry.capabilities.includes("network")));
  assert.equal(started.length, 1);
  deniedCommands.add("check");
  registry.patchMetadata("web", { lastHealthAt: "0" });
  await service.tick();
  assert.equal(probes, 0, "a denied health command must never reach the process adapter");
  assert.equal(restarts, 0, "denied health authorization is not a health failure and must not trigger recovery");
  assert.equal(registry.get("web").metadata.health, "policy-blocked");
  deniedCommands.clear();
  registry.patchMetadata("web", { lastHealthAt: "0" });
  await service.tick();
  assert.equal(probes, 1);
  const logged = JSON.parse(store.value).at(-1).metadata;
  assert.doesNotMatch(logged.stdout, /unsafe-secret|abc-secret/);
  assert.doesNotMatch(logged.stderr, /stderr-secret/);
  assert.ok(authorized.some((entry) => entry.name === "web:health" && entry.command === "check" && entry.capabilities.includes("build")), "periodic health authorization retains capabilities");
  healthy = false;
  await service.tick();
  assert.equal(restarts, 0, "health probes must respect the configured interval");
  registry.patchMetadata("web", { lastHealthAt: "0" });
  await service.tick();
  assert.equal(restarts, 1);
  assert.deepEqual(removed, []);
  assert.equal(registry.get("web").metadata.health, "healthy");
  assert.equal(await service.afterTask(), 1);
  assert.equal(restarts, 2);
  assert.ok(restartSpecs.every((spec) => spec.capabilities.includes("network")), "restart receives the manifest capability set");
  assert.equal(builds.length, 1);
  assert.equal(builds[0].command, "npm run build");
  assert.ok(builds[0].capabilities.includes("build"), "post-task build executes with validated capabilities");
  assert.ok(authorized.some((entry) => entry.name === "build:demo" && entry.capabilities.includes("build")));

  const firstId = process.id;
  const replacementIds = await service.apply({ version: 1, web: { command: "npm run dev", health: "check" }, health: { command: "fallback-health", intervalMs: 15000 }, build: { command: "npm run build", afterTask: true }, restartAfterTask: true, capabilities }, "demo");
  assert.equal(replacementIds.length, 1);
  const replacementId = replacementIds[0];
  assert.notEqual(replacementId, firstId);
  assert.equal(registry.get(firstId), undefined, "reapplying one project stops and removes stale services");
  assert.equal(registry.get(replacementId).projectId, "demo");
  assert.ok(stopped.includes(firstId));

  deniedCommands.add("npm run dev");
  healthy = false;
  registry.patchMetadata(replacementId, { lastHealthAt: "0" });
  await service.tick();
  assert.equal(restarts, 2, "revoked process authorization blocks health-failure restart");
  assert.equal(registry.get(replacementId), undefined, "a process with revoked restart authorization is stopped");
  assert.ok(stopped.includes(replacementId));
  deniedCommands.clear();

  const afterTaskIds = await service.apply({ version: 1, web: { command: "npm run dev", health: "check" }, health: { command: "fallback-health", intervalMs: 15000 }, build: { command: "npm run build", afterTask: true }, restartAfterTask: true, capabilities }, "demo");
  const afterTaskId = afterTaskIds[0];
  deniedCommands.add("npm run dev");
  await assert.rejects(() => service.afterTask("demo"), (error) => error.code === "POLICY_DENIED");
  assert.equal(registry.get(afterTaskId), undefined, "denied task restart stops the process and reports the policy failure");
  deniedCommands.clear();

  const failedIds = await service.apply({ version: 1, web: { command: "npm run dev", health: "check" }, health: { command: "fallback-health", intervalMs: 15000 }, build: { command: "npm run build", afterTask: true }, restartAfterTask: true, capabilities }, "demo");
  const failedId = failedIds[0];
  canRestart = false;
  registry.patchMetadata(failedId, { lastHealthAt: "0" });
  healthy = false;
  await service.tick();
  assert.ok(stopped.includes(failedId), "an unhealthy service is stopped when restart cannot recover it");
  assert.equal(registry.get(failedId), undefined, "a stopped service must not remain registered as a live process");
  service.dispose();
  console.log("AIB_INCONTAINER_SUPERVISOR_SELFTEST_OK capabilities=propagated health=verified build=verified process_lifecycle=verified");
} finally { fs.rmSync(out, { recursive: true, force: true }); }
