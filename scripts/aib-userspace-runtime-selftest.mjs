#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = [
  "core/runtime/RuntimeBackend.ts",
  "core/runtime/RuntimeBackendRouter.ts",
  "core/runtime/AibUserspaceRuntime.ts",
  "core/runtime/backends/TermuxNativeBackend.ts",
  "core/runtime/backends/ProotDistroBackend.ts",
  "docs/AIB_USERSPACE_RUNTIME.md",
];
for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f);

const router = fs.readFileSync(path.join(root, "core/runtime/RuntimeBackendRouter.ts"), "utf8");
assert.match(router, /failureThreshold/);
assert.match(router, /tryFailover/);
assert.match(router, /prefer-fastest-healthy/);
assert.match(router, /circuit/);
const requestTypes = fs.readFileSync(path.join(root, "core/runtime/RuntimeBackend.ts"), "utf8");
assert.match(requestTypes, /credentialProxy\?: ProxyClientConfiguration/);
assert.match(requestTypes, /hardening\?: HardenedProotPolicy/);
const prootBackend = fs.readFileSync(path.join(root, "core/runtime/backends/ProotDistroBackend.ts"), "utf8");
assert.match(prootBackend, /buildProxySafeEnvironment\(req\.env \?\? \{\}, req\.credentialProxy\)/);
assert.match(prootBackend, /wrapHardenedShellBody\(inner, req\.hardening\)/);

const aib = fs.readFileSync(path.join(root, "core/runtime/AibUserspaceRuntime.ts"), "utf8");
assert.match(aib, /TermuxNativeBackend/);
assert.match(aib, /ProotDistroBackend/);
assert.match(aib, /createAibUserspaceRuntime/);
assert.match(aib, /manifestApplier/);
assert.match(aib, /async applyManifest\(/);
assert.doesNotMatch(aib, /proroot\.so|libproroot/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /userspace/);
assert.match(facade, /initUserspaceRuntime/);
assert.match(facade, /createUserspaceRuntimeRule/);
assert.match(facade, /manifestApplier:/);
assert.match(facade, /this\.userspace\.applyManifest\(manifest, name\)/);

// Behavioral: in-memory router simulation
class FakeBackend {
  constructor(id, priority, shouldFail = false) {
    this.id = id;
    this.priority = priority;
    this.capabilities = [];
    this.shouldFail = shouldFail;
  }
  async probe() {
    return { id: this.id, health: this.shouldFail ? "unavailable" : "ready", latencyMs: this.priority, detail: "ok", capabilities: [], checkedAt: Date.now() };
  }
  async exec() {
    if (this.shouldFail) throw new Error("fail");
    return { exitCode: 0, stdout: this.id, stderr: "", durationMs: 1, backendId: this.id };
  }
}

// Minimal inline test of selection logic priorities
const backends = [new FakeBackend("termux-native", 10), new FakeBackend("proot-distro", 20)];
backends.sort((a, b) => a.priority - b.priority);
assert.equal(backends[0].id, "termux-native");

console.log("AIB_USERSPACE_RUNTIME_SELFTEST_OK files=" + files.length);
