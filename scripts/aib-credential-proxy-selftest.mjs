#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const require = createRequire(import.meta.url);
const ts = typescript;
const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "aib-auth-"));
const files = [
  "core/enhancements/auth/types.ts",
  "core/enhancements/auth/AgentAuthProxyAccess.ts",
  "core/enhancements/auth/AgentAuthStore.ts",
  "core/enhancements/auth/CredentialProxy.ts",
  "core/enhancements/isolation/HardenedProotOptions.ts",
  "core/container/ProotCommandBuilder.ts",
];
const secureAdapter = fs.readFileSync(path.join(root, "core/enhancements/auth/SecureStoreAdapter.ts"), "utf8");
const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(secureAdapter, /SecureStore\.getItemAsync/);
assert.match(secureAdapter, /SecureStore\.setItemAsync/);
assert.match(secureAdapter, /deleteItemAsync/);
assert.doesNotMatch(secureAdapter, /AsyncStorage|workspace|backup/i);
assert.doesNotMatch(secureAdapter, /fallback/i);
assert.match(facade, /agentAuthStore:\s*Pick<AgentAuthStore,/);
assert.match(facade, /#agentAuthStore:\s*AgentAuthStore/);
assert.match(facade, /this\.agentAuthStore = Object\.freeze\(/);
assert.doesNotMatch(facade, /this\.agentAuthStore\.createProxyResolver/);
assert.match(facade, /credentialProxy:\s*CredentialProxy/);
try {
  for (const rel of files) {
    const target = path.join(temp, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ts.transpile(fs.readFileSync(path.join(root, rel), "utf8"), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }));
  }
  const { AgentAuthStore } = require(path.join(temp, "core/enhancements/auth/AgentAuthStore.js"));
  const { CredentialProxy, DUMMY_PROXY_API_KEY } = require(path.join(temp, "core/enhancements/auth/CredentialProxy.js"));
  const { buildProxySafeEnvironment } = require(path.join(temp, "core/container/ProotCommandBuilder.js"));
  const db = new Map();
  const store = new AgentAuthStore({ get: async (k) => db.get(k) ?? null, set: async (k, v) => { db.set(k, v); }, delete: async (k) => { db.delete(k); } });
  const secret = "sk-SYNTHETICTESTFIXTURE01Xcape";
  await store.setProviderKey("openrouter", secret);
  assert.equal((await store.getProviderKey("openrouter")).masked.endsWith("cape"), true);
  assert.equal(await store.hasKey("openrouter"), true);
  let seenHeaders;
  let seenUrl;
  let seenBody;
  let logged;
  let sessionCounter = 0;
  const startedSessions = [];
  const stoppedSessions = [];
  const nativeTransport = { start: async (provider, key) => { assert.equal(provider, "openrouter"); assert.equal(key, secret); const sessionId = `test-session-${++sessionCounter}`; startedSessions.push(sessionId); return { sessionId, baseUrl: `http://127.0.0.1:32123/v1/session/${sessionId}`, apiKey: DUMMY_PROXY_API_KEY }; }, stop: async (id) => { stoppedSessions.push(id); return true; } };
  const proxy = new CredentialProxy(store, { openrouter: { baseUrl: "https://example.invalid/v1" } }, {
    fetcher: async (_url, init) => { seenUrl = String(_url); seenHeaders = new Headers(init.headers); seenBody = String(init.body ?? ""); return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: test\\n\\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } }); },
    logMetadata: (m) => { logged = m; },
    nativeTransport,
  });
  const cfg = await proxy.start("openrouter");
  assert.equal(cfg.apiKey, DUMMY_PROXY_API_KEY);
  assert.equal(JSON.stringify(cfg).includes(secret), false);
  const response = await proxy.forward({ provider: "openrouter", path: "chat/completions", model: "test-model", headers: { authorization: "attacker-value", "content-type": "application/json" }, body: "{}" });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.match(seenUrl, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(seenHeaders.get("authorization"), `Bearer ${DUMMY_PROXY_API_KEY}`);
  assert.equal(seenUrl.includes(secret), false);
  assert.equal(seenHeaders.get("authorization").includes(secret), false);
  assert.equal(seenBody.includes(secret), false);
  assert.equal(logged.streaming, true);
  assert.equal(JSON.stringify(logged).includes(secret), false);
  const safeEnv = buildProxySafeEnvironment({ NODE_ENV: "test", OPENROUTER_API_KEY: secret, OPENROUTER_KEY: secret, ACCESS_TOKEN: secret, SERVICE_TOKEN: secret, CUSTOM_API_KEY: secret, customApiKey: secret, SAFE_WORKSPACE: "kept" }, cfg);
  assert.equal(JSON.stringify(safeEnv).includes(secret), false);
  assert.equal(safeEnv.OPENROUTER_API_KEY, DUMMY_PROXY_API_KEY);
  assert.equal(safeEnv.OPENROUTER_KEY, undefined, "provider aliases without _API_ must be scrubbed, not forwarded as credentials");
  assert.equal(safeEnv.SERVICE_TOKEN, undefined);
  assert.equal(safeEnv.customApiKey, undefined);
  assert.equal(safeEnv.SAFE_WORKSPACE, "kept");
  assert.equal(safeEnv.OPENROUTER_BASE_URL, cfg.baseUrl);
  assert.equal(safeEnv.NODE_ENV, "test");
  const noSessionEnv = buildProxySafeEnvironment({ OPENROUTER_API_KEY: secret, OPENROUTER_KEY: secret, customApiKey: secret, OPENROUTER_BASE_URL: "https://attacker.invalid/v1", PATH: "/bin" });
  assert.equal(noSessionEnv.OPENROUTER_API_KEY, undefined);
  assert.equal(noSessionEnv.OPENROUTER_KEY, undefined);
  assert.equal(noSessionEnv.customApiKey, undefined);
  assert.equal(noSessionEnv.OPENROUTER_BASE_URL, undefined);
  assert.equal(noSessionEnv.PATH, "/bin");
  assert.throws(() => buildProxySafeEnvironment({}, { ...cfg, baseUrl: "https://attacker.invalid/v1" }), /PROXY_CLIENT_CONFIGURATION_INVALID/);
  const missing = new CredentialProxy(new AgentAuthStore({ get: async () => null, set: async () => {}, delete: async () => {} }), { openrouter: { baseUrl: "https://example.invalid/v1" } }, { nativeTransport: { start: async () => { throw new Error("must not start without credential"); }, stop: async () => true } });
  await assert.rejects(() => missing.forward({ provider: "openrouter", path: "chat/completions" }), (e) => e.code === "CREDENTIAL_MISSING");
  const missingNative = new CredentialProxy(store, { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } });
  await assert.rejects(() => missingNative.forward({ provider: "openrouter", path: "chat/completions" }), (e) => e.code === "NATIVE_TRANSPORT_UNAVAILABLE");
  const second = await proxy.start("openrouter");
  assert.notEqual(second.sessionId, cfg.sessionId);
  assert.equal(proxy.getClientConfig("openrouter").sessionId, second.sessionId);
  await store.deleteKey("openrouter");
  assert.equal(await store.hasKey("openrouter"), false);
  assert.equal(await proxy.stopSession(cfg.sessionId), true);
  assert.deepEqual(stoppedSessions, [cfg.sessionId]);
  assert.equal(proxy.getClientConfig("openrouter").sessionId, second.sessionId);
  assert.equal(await proxy.stop("openrouter"), true);
  assert.deepEqual(stoppedSessions, [cfg.sessionId, startedSessions[1], second.sessionId]);
  assert.equal(await proxy.stop("openrouter"), false);
  console.log("AIB_CREDENTIAL_PROXY_SELFTEST_OK assertions=20 concurrent_sessions=verified");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
