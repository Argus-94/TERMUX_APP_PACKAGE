#!/usr/bin/env node
import assert from "node:assert/strict";
import { configureDurablePersistence, mirrorDurableRecord, readDurableRecord, removeDurableRecord } from "../lib/durable-persistence.ts";

const files = new Map();
configureDurablePersistence({
  async read(key) { return files.get(key) ?? null; },
  async write(key, value) { files.set(key, value); },
  async remove(key) { files.delete(key); },
});

const settings = JSON.stringify({
  mode: "online",
  localParamsAuto: true,
  localParams: { nCtx: 2048, nThreads: 4, nGpuLayers: 0, unsafe: "ignore" },
  onlineGenParams: { temperature: 0.2, maxTokens: 700 },
  openRouterModelId: "openai/model-x",
  activeCustomSlot: 2,
  customProvider: { baseUrl: "https://user:password@example.invalid", extraHeadersJson: "{\"Authorization\":\"Bearer secret\"}" },
  systemPrompt: "API_KEY=should-not-persist",
  apiKey: "SYNTHETIC_CREDENTIAL_FIXTURE",
});
await mirrorDurableRecord("aibuilder.settings.v1", settings);
const savedSettings = files.get("app-state/app-settings.json");
assert.ok(savedSettings);
assert.equal(savedSettings.includes("password"), false);
assert.equal(savedSettings.includes("secret"), false);
assert.equal(savedSettings.includes("should-not-persist"), false);
assert.equal(savedSettings.includes("SYNTHETIC_CREDENTIAL_FIXTURE"), false);
assert.deepEqual(JSON.parse(savedSettings), {
  mode: "online", localParamsAuto: true, localParams: { nCtx: 2048, nThreads: 4, nGpuLayers: 0 },
  onlineGenParams: { temperature: 0.2, maxTokens: 700 }, openRouterModelId: "openai/model-x", activeCustomSlot: 2,
});

await mirrorDurableRecord("aibuilder.projectList.v1", JSON.stringify([{ id: "p1", name: "Demo", packageName: "com.example.demo", path: "/storage/emulated/0/AIBuilderTermux/projects/Demo", createdAt: 1, updatedAt: 2 }]));
assert.equal(JSON.parse(await readDurableRecord("aibuilder.projectList.v1"))[0].id, "p1");
const fakeProviderToken = ["sk", "abcdefghijklmnopqrstuvwxyz"].join("-");
const fakeBridgeToken = "aib_ab12cd34ef56_1700000000000";
await mirrorDurableRecord("aibuilder.session-memory.v1", JSON.stringify({ "/storage/emulated/0/AIBuilderTermux/projects/Demo": { digest: "API_KEY=\"secret-key-value\"; token=token-value", updatedAt: 3, items: [{ id: "i1", kind: "fact", text: `Bearer ${fakeProviderToken} bridge=${fakeBridgeToken}`, updatedAt: 3 }] } }));
const memory = files.get("app-state/session-memory.json");
assert.ok(memory.includes("[REDACTED]"));
assert.equal(memory.includes("secret-key-value"), false);
assert.equal(memory.includes("token-value"), false);
assert.equal(memory.includes(fakeProviderToken), false);
assert.equal(memory.includes(fakeBridgeToken), false, "timestamped bridge token contents are redacted before durable persistence");
await mirrorDurableRecord("aibuilder.openrouter.apikey", ["sk", "aaaaaaaaaaaaaaaaaaaa"].join("-"));
await mirrorDurableRecord("aibuilder.systemPrompt.v1", "never mirror user prompts");
assert.equal([...files.keys()].some((key) => key.includes("apikey") || key.includes("system-prompt")), false);
await removeDurableRecord("aibuilder.projectList.v1");
assert.equal(await readDurableRecord("aibuilder.projectList.v1"), null);
console.log("AIB_DURABLE_PERSISTENCE_SELFTEST_OK allowlist=verified settings_sanitized=verified memory_redaction=verified credentials=omitted");
