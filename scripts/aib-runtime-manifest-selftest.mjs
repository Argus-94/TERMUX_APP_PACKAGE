#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const require = createRequire(import.meta.url);
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-manifest-"));
try {
  for (const rel of ["types.ts", "RuntimeManifest.ts", "ManifestParser.ts", "Presets.ts"]) {
    const source = fs.readFileSync(path.join(root, "core/enhancements/manifest", rel), "utf8");
    const dest = path.join(out, rel.replace(/\.ts$/, ".js"));
    fs.writeFileSync(dest, typescript.transpile(source, { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }));
  }
  const { parseManifest } = require(path.join(out, "ManifestParser.js"));
  const { validateManifest, applyManifest } = require(path.join(out, "RuntimeManifest.js"));
  const { getRuntimePreset, runtimePresetNames } = require(path.join(out, "Presets.js"));

  const manifest = parseManifest(`version: 1
web:
  command: npm run dev
  port: 3000
  health: curl -fsS http://127.0.0.1:3000/health
workers:
  - name: queue
    command: node worker.js
    restart: true
env:
  NODE_ENV: development
health:
  command: node --version
  intervalMs: 15000
capabilities:
  - terminal
  - network
  - filesystem.read
  - filesystem.write
restartAfterTask: true
`);
  assert.equal(manifest.web.port, 3000);
  assert.equal(manifest.workers[0].name, "queue");
  assert.equal(manifest.env.NODE_ENV, "development");
  assert.equal(manifest.capabilities.includes("network"), true);
  assert.equal(parseManifest("version: 1\nweb:\n  command: 'echo ''quoted'''\n").web.command, "echo 'quoted'");
  assert.throws(() => parseManifest("version: 1\nweb:\n  command: 'echo 'broken''\n"), (error) => error.code === "PARSE_FAILED");
  assert.equal(validateManifest({ version: 1, env: { OPENAI_API_KEY: "should-not-be-here" } }).ok, false);
  assert.equal(validateManifest({ version: 1, env: { APP_MODE: "credential-value" } }).ok, false);
  assert.equal(validateManifest({ version: 1, env: { APP_MODE: "sk-SYNTHETICTESTFIXTURE01XXXXX6789" } }).ok, false);
  assert.equal(validateManifest({ version: 1, env: { APP_MODE: "production" } }).ok, true);
  assert.throws(() => parseManifest("version: 1\nweb:\n  command: x\n  port: 99999"), (error) => error.code === "VALIDATION_FAILED");
  assert.throws(() => parseManifest("version: 1\nunsafe: &anchor x"), (error) => error.code === "PARSE_FAILED");
  assert.equal(validateManifest({ version: 1, build: { command: "./gradlew" }, health: { command: "test -x ./gradlew", intervalMs: 60_000 } }).ok, false, "a one-shot build cannot advertise a discarded periodic health probe");
  assert.deepEqual([...runtimePresetNames].sort(), ["android-build", "debian-shell", "kali-tools", "node-dev", "offline-gguf", "python-fastapi"].sort());
  for (const name of runtimePresetNames) assert.equal(validateManifest(getRuntimePreset(name).manifest).ok, true, `preset ${name} must validate`);
  assert.equal(Object.hasOwn(getRuntimePreset("android-build").manifest, "health"), false);

  const processes = new Map();
  const registry = {
    register(process) { if (processes.has(process.id)) throw new Error("duplicate id"); processes.set(process.id, process); },
    unregister(id) { return processes.delete(id); },
    get(id) { return processes.get(id); },
    list() { return [...processes.values()]; },
    patchMetadata(id, patch) { const current = processes.get(id); if (!current) return false; processes.set(id, { ...current, metadata: { ...current.metadata, ...patch } }); return true; },
  };
  let calls = 0;
  const authorized = [];
  const starts = [];
  const builds = [];
  const adapter = {
    authorize: (command, name, capabilities = []) => { authorized.push({ command, name, capabilities: [...capabilities] }); return true; },
    start: async (process, context) => { calls++; starts.push({ process, context }); return { id: `p${calls}`, pid: 42 }; },
    stop: async (id) => processes.delete(id),
    runOnce: async (command, env, capabilities = []) => builds.push({ command, env, capabilities: [...capabilities] }),
  };
  const ids = await applyManifest(registry, adapter, manifest, "demo");
  assert.equal(ids.length, 2);
  assert.equal(processes.size, 2);
  assert.equal(processes.get("p1").metadata.watchdog, "true");
  assert.ok(starts.every(({ process, context }) => process.capabilities.includes("network") && Array.isArray(context.occupiedIds)));
  assert.ok(authorized.every((entry) => entry.capabilities.includes("filesystem.write")), "process and health authorization receive declared capabilities");

  const healthManifest = { version: 1, web: { command: "npm run dev", health: "curl -fsS http://127.0.0.1:3000/health" }, health: { command: "node --version", intervalMs: 15000 }, capabilities: ["terminal", "web"] };
  const healthIds = await applyManifest(registry, adapter, healthManifest, "demo");
  assert.equal(processes.get(healthIds[0]).metadata.healthIntervalMs, "15000");
  assert.ok(authorized.some((entry) => entry.name === "web:health" && entry.capabilities.includes("web")));

  const immediateBuild = { version: 1, build: { command: "npm run build" }, capabilities: ["terminal", "build"] };
  await applyManifest(registry, adapter, immediateBuild, "demo");
  assert.equal(builds.at(-1).command, "npm run build");
  assert.ok(builds.at(-1).capabilities.includes("build"));
  const denied = { ...adapter, authorize: () => false };
  await assert.rejects(() => applyManifest(registry, denied, manifest, "demo"), (error) => error.code === "POLICY_DENIED");

  const existing = { id: "collision", kind: "runtime", projectId: "original", startedAt: 1, label: "keep-me", metadata: { health: "healthy" } };
  const collisionProcesses = new Map([[existing.id, existing]]);
  const collisionRegistry = {
    register(process) { if (collisionProcesses.has(process.id)) throw new Error("duplicate id"); collisionProcesses.set(process.id, process); },
    unregister(id) { return collisionProcesses.delete(id); },
    get(id) { return collisionProcesses.get(id); },
    list() { return [...collisionProcesses.values()]; },
    patchMetadata(id, patch) { const current = collisionProcesses.get(id); if (!current) return false; collisionProcesses.set(id, { ...current, metadata: { ...current.metadata, ...patch } }); return true; },
  };
  const rollbackStops = [];
  const collisionAdapter = { authorize: () => true, start: async (_process, context) => { assert.ok(context.occupiedIds.includes("collision")); return { id: "collision", pid: 99 }; }, stop: async (id) => rollbackStops.push(id) };
  await assert.rejects(() => applyManifest(collisionRegistry, collisionAdapter, { version: 1, web: { command: "npm run dev" } }, "demo"), (error) => error.code === "APPLY_FAILED");
  assert.deepEqual(rollbackStops, [], "a colliding id is never stopped as though it belonged to the failed call");
  assert.strictEqual(collisionRegistry.get("collision"), existing, "pre-existing registry ownership remains unchanged");

  const rollbackProcesses = new Map();
  const rollbackRegistry = {
    register(process) { rollbackProcesses.set(process.id, process); }, unregister(id) { return rollbackProcesses.delete(id); }, get(id) { return rollbackProcesses.get(id); }, list() { return [...rollbackProcesses.values()]; },
    patchMetadata(id, patch) { const current = rollbackProcesses.get(id); if (!current) return false; rollbackProcesses.set(id, { ...current, metadata: { ...current.metadata, ...patch } }); return true; },
  };
  const stopFailAdapter = { authorize: () => true, start: async () => ({ id: "owned-process", pid: 77 }), stop: async () => { throw new Error("stop failed"); }, runOnce: async () => { throw new Error("build failed"); } };
  await assert.rejects(() => applyManifest(rollbackRegistry, stopFailAdapter, { version: 1, web: { command: "npm run dev" }, build: { command: "npm run build" } }, "demo"), (error) => error.code === "APPLY_FAILED");
  assert.equal(rollbackRegistry.get("owned-process").metadata.health, "quarantined", "failed rollback keeps the live process registered for supervision");
  assert.equal(rollbackRegistry.get("owned-process").metadata.manifestRollbackStopFailed, "true");

  console.log("AIB_RUNTIME_MANIFEST_SELFTEST_OK yaml_quotes=verified secrets=blocked capabilities=propagated rollback_ownership=preserved stop_failures=tracked");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
