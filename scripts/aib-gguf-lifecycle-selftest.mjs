#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const tsPath = (() => {
  try { return require.resolve("typescript"); } catch { /* global toolchain */ }
  const globalModules = path.resolve(path.dirname(process.execPath), "../lib/node_modules");
  for (const candidate of [
    path.join(globalModules, "typescript/lib/typescript.js"),
    path.join(globalModules, "graphql-language-service-cli/node_modules/typescript/lib/typescript.js"),
    "/usr/local/lib/node_modules/typescript/lib/typescript.js",
  ]) if (fs.existsSync(candidate)) return candidate;
  throw new Error("TYPESCRIPT_LOADER_UNAVAILABLE");
})();
const ts = require(tsPath);
const cache = new Map();
function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
function loadTs(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  cache.set(file, mod);
  mod.require = (request) => {
    const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
    return resolved ? loadTs(resolved) : createRequire(file)(request);
  };
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}
const { GGUFLifecycle, GGUFLifecycleError } = loadTs(path.join(root, "core/enhancements/offline/GGUFLifecycle.ts"));
function modelPort({ downloaded = true, loaded = false } = {}) {
  const model = {
    downloaded, loaded, loadCalls: 0, unloadCalls: 0, applied: null,
    isDownloaded() { return this.downloaded; }, isLoaded() { return this.loaded; }, getAppliedParams() { return this.applied; },
    async load(params) { this.loadCalls += 1; if (!this.downloaded) throw new Error("missing"); this.loaded = true; this.applied = params ?? { nCtx: 3072, nThreads: 4, nGpuLayers: 0 }; },
    async unload() { this.unloadCalls += 1; this.loaded = false; this.applied = null; },
  };
  return model;
}
const cases = [];
async function scenario(name, fn) { await fn(); cases.push(name); console.log(`PASS ${name}`); }
await scenario("loads an existing model using the injected local-model port", async () => {
  const port = modelPort();
  const events = [];
  const lifecycle = new GGUFLifecycle(port, { onEvent: (event) => events.push(event) });
  await lifecycle.ensureLoaded();
  assert.equal(port.loadCalls, 1);
  assert.equal(port.loaded, true);
  assert.equal(lifecycle.getState(), "loaded");
  assert.deepEqual(events.map((event) => event.action), ["load-start", "loaded"]);
  await lifecycle.dispose();
});
await scenario("missing local model file fails without any download attempt", async () => {
  const port = modelPort({ downloaded: false });
  const lifecycle = new GGUFLifecycle(port);
  await assert.rejects(lifecycle.ensureLoaded(), (error) => error instanceof GGUFLifecycleError && error.code === "MODEL_FILE_MISSING");
  assert.equal(port.loadCalls, 0);
  assert.equal(port.unloadCalls, 0);
});
await scenario("keepalive expiry unloads model memory", async () => {
  const port = modelPort({ loaded: true });
  const lifecycle = new GGUFLifecycle(port, { keepAliveMs: 5 });
  lifecycle.keepAlive();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(port.unloadCalls, 1);
  assert.equal(lifecycle.getState(), "unloaded");
  await lifecycle.dispose();
});
await scenario("memory-pressure hook unloads immediately", async () => {
  const port = modelPort({ loaded: true });
  const events = [];
  const lifecycle = new GGUFLifecycle(port, { onEvent: (event) => events.push(event) });
  await lifecycle.onMemoryPressure();
  assert.equal(port.unloadCalls, 1);
  assert.equal(port.loaded, false);
  assert.equal(events[0].action, "memory-pressure");
  await lifecycle.dispose();
});
await scenario("active inference lease defers pressure unload until release", async () => {
  const port = modelPort({ loaded: true });
  const lifecycle = new GGUFLifecycle(port);
  const release = await lifecycle.acquire();
  let pressureFinished = false;
  const pressure = lifecycle.onMemoryPressure().then(() => { pressureFinished = true; });
  await Promise.resolve();
  assert.equal(port.unloadCalls, 0, "in-use model must not be unloaded underneath inference");
  assert.equal(pressureFinished, false);
  await release();
  await pressure;
  assert.equal(port.unloadCalls, 1);
  assert.equal(port.loaded, false);
  await lifecycle.dispose();
});
await scenario("background and PerformanceMode hooks apply restrictive unload policy", async () => {
  const port = modelPort({ loaded: true });
  const lifecycle = new GGUFLifecycle(port);
  await lifecycle.onBackground(true);
  assert.equal(port.unloadCalls, 0, "Balanced mode preserves by default until keepalive expiry");
  await lifecycle.onPerformanceModeChange("Battery");
  assert.equal(port.unloadCalls, 1);
  assert.equal(port.loaded, false);
  await lifecycle.onBackground(false);
  await lifecycle.dispose();
});
await scenario("background policy can be explicitly configured to unload", async () => {
  const port = modelPort({ loaded: true });
  const lifecycle = new GGUFLifecycle(port, { unloadInBackground: true });
  await lifecycle.onBackground(true);
  assert.equal(port.unloadCalls, 1);
  await lifecycle.dispose();
});
console.log(`aib-gguf-lifecycle-selftest: OK (${cases.length} scenarios)`);
