#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-provider-transport-"));
const cache = new Map();
const recorded = [];
const transientProbes = [];
const forbiddenTestCredential = "fake-provider-credential-test-only";
const logger = { add() {}, markModelRequest() {}, markModelResponse() {}, subscribe() { return () => {}; }, getEntries() { return []; } };

function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
function fakeResponse(body, status = 200, headers = { "content-type": "application/json" }) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}
async function recordingTransport(provider, route, requestPath, init = {}, metadata) {
  const entry = { provider, route, path: requestPath, method: init.method || "POST", headers: init.headers || {}, body: typeof init.body === "string" ? init.body : "", metadata };
  recorded.push(entry);
  assert.equal(JSON.stringify(entry).includes(forbiddenTestCredential), false, "credential must never enter app-level provider transport context");
  assert.equal(JSON.stringify(entry.headers).toLowerCase().includes("authorization"), false, "provider Authorization must be injected only inside native proxy");
  if (requestPath === "key") return fakeResponse({ data: { label: "mock" } });
  if (requestPath === "models") return fakeResponse({ data: [{ id: "gpt-4o", name: "GPT-4o" }] });
  if (requestPath.endsWith("chat/completions")) return fakeResponse({ choices: [{ message: { content: "OK" } }] });
  throw new Error(`UNEXPECTED_PROVIDER_ROUTE:${provider}:${requestPath}`);
}
async function probeProviderModelsCredential(provider, route, credential) {
  transientProbes.push({ provider, baseUrl: route.baseUrl, credential });
  return recordingTransport(provider, route, "models", { method: "GET" });
}

function loadTs(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  cache.set(file, mod);
  mod.require = (request) => {
    if (request.endsWith("/productionProviderTransport")) return { securedProviderFetch: recordingTransport, probeProviderModelsCredential };
    if (request === "./persistent-logger") return { persistentLogger: logger };
    const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
    return resolved ? loadTs(resolved) : createRequire(file)(request);
  };
  const source = fs.readFileSync(file, "utf8");
  const js = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}

try {
  const online = loadTs(path.join(root, "lib/online-model.ts"));
  const custom = loadTs(path.join(root, "lib/custom-provider.ts"));

  const onlineEngine = new online.OnlineModelEngine(recordingTransport);
  assert.equal(await onlineEngine.chat([{ role: "user", content: "hello" }]), "OK");
  assert.equal((await online.validateOpenRouterApiKey(recordingTransport)).valid, true);
  const checked = await online.checkOpenRouterModels(
    [{ id: "mock/free", name: "Mock", vision: false, contextLength: 1024 }],
    undefined,
    { maxRetries: 0, staggerMs: 0 },
    recordingTransport,
  );
  assert.equal(checked["mock/free"].status, "working");

  const customConfig = {
    name: "Custom test", baseUrl: "https://custom.example/v1", providerId: "custom.slot1",
    hasApiKey: true, modelId: "gpt-4o", chatPath: "/chat/completions",
    extraHeadersJson: JSON.stringify({ Authorization: `Bearer ${forbiddenTestCredential}`, "X-API-Key": forbiddenTestCredential, "HTTP-Referer": "https://aibuilder.app" }),
  };
  const customEngine = new custom.CustomProviderEngine(recordingTransport);
  customEngine.setConfig(customConfig);
  assert.equal(await customEngine.chat([{ role: "user", content: "hello" }]), "OK");
  assert.equal((await custom.fetchCustomProviderModels(customConfig, recordingTransport)).length, 1);
  assert.equal((await custom.probeCustomProviderModels({ ...customConfig, credential: "synthetic-custom-slot1-draft" })).length, 1);
  assert.equal((await custom.probeCustomProviderChat(customConfig, recordingTransport)).ok, true);
  assert.equal(JSON.stringify(customEngine.getConfig()).includes(forbiddenTestCredential), false);

  const custom2Config = { ...customConfig, providerId: "custom.slot2" };
  const custom2Engine = new custom.CustomProviderEngine(recordingTransport);
  custom2Engine.setConfig(custom2Config);
  assert.equal(await custom2Engine.chat([{ role: "user", content: "hello" }]), "OK");
  assert.equal((await custom.fetchCustomProviderModels(custom2Config, recordingTransport)).length, 1);
  assert.equal((await custom.probeCustomProviderModels({ ...custom2Config, credential: "synthetic-custom-slot2-draft" })).length, 1);
  assert.equal((await custom.probeCustomProviderChat(custom2Config, recordingTransport)).ok, true);

  const openCodeConfig = {
    name: "OpenCode", baseUrl: "https://opencode.ai/zen/v1", providerId: "opencode",
    hasApiKey: true, modelId: "gpt-4o", chatPath: "/chat/completions",
  };
  assert.equal((await custom.fetchCustomProviderModels(openCodeConfig, recordingTransport)).length, 1);
  assert.equal((await custom.probeCustomProviderModels({ ...openCodeConfig, credential: "synthetic-opencode-draft" })).length, 1);
  assert.equal((await custom.probeCustomProviderChat(openCodeConfig, recordingTransport)).ok, true);

  assert.deepEqual(transientProbes.map(({ provider }) => provider), ["custom.slot1", "custom.slot2", "opencode"]);
  assert.ok(transientProbes.every((probe) => probe.baseUrl.startsWith("https://")));

  const expectedPairs = [
    ["openrouter", "chat/completions"], ["openrouter", "key"], ["openrouter", "chat/completions"],
["custom.slot1", "chat/completions"], ["custom.slot1", "models"], ["custom.slot1", "chat/completions"],
    ["custom.slot1", "models"],
    ["custom.slot2", "chat/completions"], ["custom.slot2", "models"], ["custom.slot2", "chat/completions"],
    ["custom.slot2", "models"],
    ["opencode", "models"], ["opencode", "chat/completions"], ["opencode", "models"],
  ];
  for (const [provider, requestPath] of expectedPairs) {
    assert.ok(recorded.some((call) => call.provider === provider && call.path.replace(/^\/+/, "") === requestPath), `missing secured call ${provider}:${requestPath}; saw ${JSON.stringify(recorded.map(({ provider: p, path: q }) => [p, q]))}`);
  }
  assert.equal(recorded.length, expectedPairs.length, "unexpected provider request/direct retry was issued");
  assert.ok(recorded.every((call) => call.route.baseUrl.startsWith("https://")), "all provider routes must be HTTPS");

  for (const rel of ["lib/online-model.ts", "lib/custom-provider.ts"]) {
    const source = fs.readFileSync(path.join(root, rel), "utf8");
    assert.doesNotMatch(source, /\baxios\s*\(|axios\.(?:get|post|request)\s*\(/i, `${rel} must not use direct axios`);
    assert.doesNotMatch(source, /\bfetch\s*\(/i, `${rel} must not use direct fetch`);
    assert.match(source, /securedProviderFetch/, `${rel} must use the single secured transport`);
  }
  const audio = fs.readFileSync(path.join(root, "lib/audio-transcribe.ts"), "utf8");
  assert.match(audio, /securedProviderFetch\(providerId, route, "audio\/transcriptions"/);
  assert.doesNotMatch(audio, /Authorization\s*:\s*`Bearer\s*\$\{.*apiKey/i);
  console.log(`AIB_PROVIDER_TRANSPORT_SELFTEST_OK calls=${recorded.length} providers=openrouter,custom.slot1,custom.slot2,opencode directProviderFetch=none credentialsInAppRequest=none`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
