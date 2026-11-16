#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const cache = new Map();
const secure = new Map();
const startCalls = [];
const stopCalls = [];
const proxyFetchCalls = [];
const failNextCanonicalWrite = new Set();
let proxy;

function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
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
    if (request === "./persistent-logger") return { persistentLogger: { add() {}, markModelRequest() {}, markModelResponse() {} } };
    if (request.endsWith("/productionProviderTransport")) {
      return {
        securedProviderFetch: async (provider, route, requestPath, init = {}, metadata) => proxy.forward({
          provider, path: requestPath, method: init.method, headers: init.headers, body: init.body, signal: init.signal, model: metadata?.model,
        }, route),
        probeProviderModelsCredential: async (provider, route, credential, signal) => proxy.probeWithCredential({ provider, path: "models", method: "GET", signal }, credential, route),
      };
    }
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
  const { AgentAuthStore } = loadTs(path.join(root, "core/enhancements/auth/AgentAuthStore.ts"));
  const { CredentialProxy, DUMMY_PROXY_API_KEY } = loadTs(path.join(root, "core/enhancements/auth/CredentialProxy.ts"));
  const secureStorage = {
    async get(key) { return secure.get(key) ?? null; },
    async set(key, value) {
      if (failNextCanonicalWrite.has(key)) { failNextCanonicalWrite.delete(key); throw new Error("synthetic secure-store write failure"); }
      secure.set(key, value);
    },
    async delete(key) { secure.delete(key); },
  };
  const store = new AgentAuthStore(secureStorage);
  let sessionNo = 0;
  const nativeTransport = {
    async start(provider, credential, route) {
      const sessionId = `two-slot-${++sessionNo}`;
      startCalls.push({ sessionId, provider, credential, route: { ...route } });
      return { sessionId, baseUrl: `http://127.0.0.1:32123/v1/session/${sessionId}`, apiKey: DUMMY_PROXY_API_KEY };
    },
    async stop(sessionId) { stopCalls.push(sessionId); return true; },
  };
  const routes = {
    "custom.slot1": { baseUrl: "https://slot-one.example/v1" },
    "custom.slot2": { baseUrl: "https://api.anthropic-slot-two.example/v1", authHeader: "x-api-key", authScheme: "raw" },
  };
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    assert.equal(url.hostname, "127.0.0.1", "provider requests only reach the mock loopback proxy");
    assert.equal(headers.get("authorization"), `Bearer ${DUMMY_PROXY_API_KEY}`, "app-side proxy traffic uses only the dummy key");
    assert.equal(JSON.stringify([...headers.entries()]).includes("SLOT1-SECRET"), false);
    assert.equal(JSON.stringify([...headers.entries()]).includes("SLOT2-SECRET"), false);
    const call = { url: url.toString(), method: init.method || "POST", headers: Object.fromEntries(headers.entries()) };
    proxyFetchCalls.push(call);
    if (url.pathname.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "slot-specific-chat-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: `reply:${url.pathname}` } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  proxy = new CredentialProxy(store, routes, { nativeTransport, fetcher });
  const retiredProviderId = ["deep", "seek"].join("");
  await assert.rejects(
    () => proxy.start(retiredProviderId, { baseUrl: "https://api.deepseek.com/v1" }),
    (error) => error?.code === "PROVIDER_NOT_SUPPORTED",
    "retired provider ID cannot be re-enabled via a route override",
  );
  const custom = loadTs(path.join(root, "lib/custom-provider.ts"));
  const canonical = (slot) => `aib.agent-auth.v1.custom.slot${slot}`;
  const slot1 = {
    name: "Synthetic slot one", baseUrl: "https://slot-one.example/v1", providerId: "custom.slot1",
    hasApiKey: true, modelId: "slot-one-model", chatPath: "/slot-one/chat/completions",
  };
  const slot2 = {
    name: "Synthetic slot two", baseUrl: "https://api.anthropic-slot-two.example/v1", providerId: "custom.slot2",
    hasApiKey: true, modelId: "slot-two-model", chatPath: "/slot-two/custom-chat",
  };

  // SecureStore canonical credentials are independent and both read back as configured (the UI hydration signal).
  await store.setProviderKey("custom.slot1", "SLOT1-SECRET-OLD");
  await store.setProviderKey("custom.slot2", "SLOT2-SECRET");
  assert.equal(secure.get(canonical(1)), "SLOT1-SECRET-OLD");
  assert.equal(secure.get(canonical(2)), "SLOT2-SECRET");
  assert.equal(await store.hasKey("custom.slot1"), true);
  assert.equal(await store.hasKey("custom.slot2"), true);

  // A typed draft is probed through one isolated GET /models session: no canonical write or active-slot session.
  const beforeDraftSecure = [...secure.entries()].sort();
  const beforeDraftStarts = startCalls.length;
  const beforeDraftStops = stopCalls.length;
  const draftModels = await custom.probeCustomProviderModels({
    baseUrl: slot1.baseUrl, providerId: "custom.slot1", credential: "SLOT1-DRAFT-NOT-SAVED",
  });
  assert.deepEqual(draftModels.map((model) => model.id), ["slot-specific-chat-model"]);
  assert.deepEqual([...secure.entries()].sort(), beforeDraftSecure, "draft check never writes or replaces SecureStore credentials");
  assert.equal(startCalls.length, beforeDraftStarts + 1);
  assert.equal(startCalls.at(-1).credential, "SLOT1-DRAFT-NOT-SAVED");
  assert.equal(startCalls.at(-1).route.baseUrl, slot1.baseUrl);
  assert.equal(proxyFetchCalls.at(-1).method, "GET");
  assert.equal(proxyFetchCalls.at(-1).url.endsWith("/models"), true);
  assert.equal(stopCalls.length, beforeDraftStops + 1, "the transient draft session is cleaned up");

  // Saving/installing into slot 2 changes only its own canonical key; slot 1 remains untouched.
  await store.setProviderKey("custom.slot2", "SLOT2-SECRET-INSTALLED");
  assert.equal(secure.get(canonical(1)), "SLOT1-SECRET-OLD", "slot 2 install cannot overwrite slot 1");
  assert.equal(secure.get(canonical(2)), "SLOT2-SECRET-INSTALLED");
  await store.setProviderKey("custom.slot1", "SLOT1-SECRET-INSTALLED");
  assert.equal(secure.get(canonical(1)), "SLOT1-SECRET-INSTALLED");
  assert.equal(secure.get(canonical(2)), "SLOT2-SECRET-INSTALLED", "slot 1 install cannot overwrite slot 2");

  const engine = new custom.CustomProviderEngine(async (provider, route, requestPath, init, metadata) => proxy.forward({
    provider, path: requestPath, method: init.method, headers: init.headers, body: init.body, signal: init.signal, model: metadata?.model,
  }, route));

  // Direct model-list production route for slot 1: selected provider ID, base URL, /models, and its canonical key.
  const slot1Models = await custom.fetchCustomProviderModels({ baseUrl: slot1.baseUrl, providerId: slot1.providerId });
  assert.equal(slot1Models[0].id, "slot-specific-chat-model");
  const slot1ModelsStart = startCalls.at(-1);
  assert.equal(slot1ModelsStart.provider, "custom.slot1");
  assert.equal(slot1ModelsStart.credential, "SLOT1-SECRET-INSTALLED");
  assert.equal(slot1ModelsStart.route.baseUrl, slot1.baseUrl);
  assert.equal(proxyFetchCalls.at(-1).url.endsWith("/models"), true);

  // Direct model-list production route for slot 2 preserves its own destination and x-api-key/raw protocol.
  const slot2Models = await custom.fetchCustomProviderModels({ baseUrl: slot2.baseUrl, providerId: slot2.providerId });
  assert.equal(slot2Models[0].id, "slot-specific-chat-model");
  const slot2ModelsStart = startCalls.at(-1);
  assert.equal(slot2ModelsStart.provider, "custom.slot2");
  assert.equal(slot2ModelsStart.credential, "SLOT2-SECRET-INSTALLED");
  assert.deepEqual(slot2ModelsStart.route, { baseUrl: slot2.baseUrl, authHeader: "x-api-key", authScheme: "raw" });

  // Chat activation config is slot-scoped; slot 1 and slot 2 requests hit their own configured paths and routes.
  engine.setConfig(slot1);
  const slot1Reply = await engine.chat([{ role: "user", content: "hello slot one" }]);
  const slot1AppSession = startCalls.find((call) => call.provider === "custom.slot1" && call.credential === "SLOT1-SECRET-INSTALLED");
  assert.equal(slot1Reply, `reply:/v1/session/${slot1AppSession.sessionId}/slot-one/chat/completions`);
  assert.equal(slot1AppSession.credential, "SLOT1-SECRET-INSTALLED");
  assert.equal(slot1AppSession.route.baseUrl, slot1.baseUrl);
  assert.equal(proxyFetchCalls.at(-1).url.endsWith("/slot-one/chat/completions"), true);

  engine.setConfig(slot2);
  const slot2Reply = await engine.chat([{ role: "user", content: "hello slot two" }]);
  const slot2AppSession = startCalls.find((call) => call.provider === "custom.slot2");
  assert.equal(slot2Reply, `reply:/v1/session/${slot2AppSession.sessionId}/slot-two/custom-chat`);
  assert.equal(slot2AppSession.credential, "SLOT2-SECRET-INSTALLED");
  assert.deepEqual(slot2AppSession.route, { baseUrl: slot2.baseUrl, authHeader: "x-api-key", authScheme: "raw" });
  assert.equal(proxyFetchCalls.at(-1).url.endsWith("/slot-two/custom-chat"), true);

  // Independent engines can keep both slots active concurrently with distinct routes and SecureStore credentials.
  const concurrentEngine1 = new custom.CustomProviderEngine(async (provider, route, requestPath, init, metadata) => proxy.forward({
    provider, path: requestPath, method: init.method, headers: init.headers, body: init.body, signal: init.signal, model: metadata?.model,
  }, route));
  const concurrentEngine2 = new custom.CustomProviderEngine(async (provider, route, requestPath, init, metadata) => proxy.forward({
    provider, path: requestPath, method: init.method, headers: init.headers, body: init.body, signal: init.signal, model: metadata?.model,
  }, route));
  concurrentEngine1.setConfig(slot1);
  concurrentEngine2.setConfig(slot2);
  const [concurrentReply1, concurrentReply2] = await Promise.all([
    concurrentEngine1.chat([{ role: "user", content: "concurrent slot one" }]),
    concurrentEngine2.chat([{ role: "user", content: "concurrent slot two" }]),
  ]);
  assert.match(concurrentReply1, /\/slot-one\/chat\/completions$/);
  assert.match(concurrentReply2, /\/slot-two\/custom-chat$/);
  const concurrentCalls = proxyFetchCalls.slice(-2);
  const concurrentSlot1Call = concurrentCalls.find((call) => call.url.endsWith("/slot-one/chat/completions"));
  const concurrentSlot2Call = concurrentCalls.find((call) => call.url.endsWith("/slot-two/custom-chat"));
  assert.ok(concurrentSlot1Call && concurrentSlot2Call, "both selected slot routes complete concurrently");
  const sessionId = (call) => new URL(call.url).pathname.match(/\/session\/([^/]+)\//)?.[1];
  assert.notEqual(sessionId(concurrentSlot1Call), sessionId(concurrentSlot2Call), "concurrent slots use separate proxy sessions");

  // Draft cleanup for slot 1 cannot stop an active app session for slot 2.
  const slot2Active = startCalls.find((call) => call.provider === "custom.slot2").sessionId;
  const stoppedBeforeCrossCleanup = new Set(stopCalls);
  await custom.probeCustomProviderModels({ baseUrl: slot1.baseUrl, providerId: "custom.slot1", credential: "ANOTHER-DRAFT-KEY" });
  const newlyStopped = stopCalls.filter((id) => !stoppedBeforeCrossCleanup.has(id));
  assert.equal(newlyStopped.length, 1);
  assert.notEqual(newlyStopped[0], slot2Active, "slot 1 draft cleanup never stops slot 2's app session");
  await engine.chat([{ role: "user", content: "slot two survives" }]);
  assert.equal(startCalls.find((call) => call.provider === "custom.slot2").credential, "SLOT2-SECRET-INSTALLED");

  // Stopping slot 1's exact app-owned session does not stop or rotate slot 2's active session.
  const slot1Active = slot1AppSession.sessionId;
  const slot2SessionsBeforeSlot1Stop = new Set(startCalls.filter((call) => call.provider === "custom.slot2").map((call) => call.sessionId));
  assert.equal(await proxy.stopSession(slot1Active), true);
  assert.equal(stopCalls.includes(slot2Active), false);
  assert.ok([...slot2SessionsBeforeSlot1Stop].every((id) => !stopCalls.includes(id)), "slot 1 cleanup cannot stop any slot 2 session");

  // Failed replacement is rolled back/preserves the previous canonical credential.
  const oldSlot1 = secure.get(canonical(1));
  failNextCanonicalWrite.add(canonical(1));
  await assert.rejects(() => store.setProviderKey("custom.slot1", "SLOT1-FAILED-REPLACEMENT"), (error) => error?.code === "SECURE_STORAGE_FAILED");
  assert.equal(secure.get(canonical(1)), oldSlot1, "failed key replacement retains the previously saved key");
  assert.equal(secure.get(canonical(2)), "SLOT2-SECRET-INSTALLED");

  // Production selection/install bindings are checked in the app source as well as through the runtime engines.
  const settingsHook = fs.readFileSync(path.join(root, "hooks/useAppSettings.ts"), "utf8");
  assert.match(settingsHook, /const providerId = slot === 2 \? "custom\.slot2" : "custom\.slot1"/);
  assert.match(settingsHook, /const cfg = slot === 2 \? customProvider2 : customProvider1/);
  assert.match(settingsHook, /if \(activate\)[\s\S]*?setActiveCustomSlotState\(slot\)[\s\S]*?providerId: cfg\.providerId/);
  const settingsUi = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");
  assert.match(settingsUi, /providerId="custom\.slot1"[\s\S]*?setCustomProviderSlot\(1,/);
  assert.match(settingsUi, /providerId="custom\.slot2"[\s\S]*?setCustomProviderSlot\(2,/);
  const nativeProxySource = fs.readFileSync(path.join(root, "native/aib-credential-proxy/AibCredentialHttpProxyServer.java"), "utf8");
  assert.match(nativeProxySource, /authScheme\.equalsIgnoreCase\("raw"\) \|\| !authHeader\.equals\("authorization"\) \? secret : "Bearer " \+ secret/);
  assert.match(nativeProxySource, /connection\.setRequestProperty\(authHeader, authValue\)/, "native upstream uses the intended slot's configured auth header");
  assert.equal(startCalls.some((call) => call.provider.toLowerCase().includes("deepseek") || call.route.baseUrl.includes("deepseek")), false);
  assert.equal(proxyFetchCalls.every((call) => new URL(call.url).hostname === "127.0.0.1"), true);
  assert.ok(proxyFetchCalls.some((call) => call.url.endsWith("/slot-one/chat/completions")));
  assert.ok(proxyFetchCalls.some((call) => call.url.endsWith("/slot-two/custom-chat")));

  await proxy.stopAll();
  console.log("AIB_CUSTOM_PROVIDER_TWO_SLOT_PRODUCTION_SELFTEST_OK canonical=independent draft=read-only models=both chat=both endpoint-path-auth=slot-scoped failed-replacement=old-key-retained cleanup=isolated external-network=none");
} finally {
  secure.clear();
}
