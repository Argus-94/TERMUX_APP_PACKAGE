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
const cache = new Map();
const secure = new Map();
const secureOperations = [];
const asyncStorage = new Map();
const logs = [];
let failSecureWrite = false;
let failSecureReadback = false;
const failSecureWriteKeys = new Set();
let proxyStops = 0;
const appSettingsSource = fs.readFileSync(new URL("../hooks/useAppSettings.ts", import.meta.url), "utf8");
const fakeSecureStore = {
  async getItemAsync(key) { secureOperations.push(["get", key]); if (failSecureReadback && key === "aib.agent-auth.v1.opencode") return null; return secure.get(key) ?? null; },
  async setItemAsync(key, value) {
    secureOperations.push(["set", key]);
    if (failSecureWrite || failSecureWriteKeys.has(key)) throw new Error("mock secure storage failure");
    secure.set(key, String(value));
  },
  async deleteItemAsync(key) { secureOperations.push(["delete", key]); secure.delete(key); },
};
const fakeAsyncStorage = {
  async getItem(key) { return asyncStorage.get(key) ?? null; },
  async setItem(key, value) { asyncStorage.set(key, String(value)); },
  async removeItem(key) { asyncStorage.delete(key); },
};
const fakeLogger = { add(level, tag, message) { logs.push(`${level}:${tag}:${message}`); } };

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
    if (request === "expo-secure-store") return fakeSecureStore;
    if (request === "@react-native-async-storage/async-storage") return fakeAsyncStorage;
    if (request.endsWith("/CredentialProxy")) return { CredentialProxy: class { async stop() { proxyStops++; return true; } async rotateProviderCredential(_provider, mutate) { await this.stop(); await mutate(); return true; } async forward() { throw new Error("NETWORK_NOT_USED"); } } };
    if (request.endsWith("/NativeProxyTransport")) return { NativeProxyTransportAdapter: class {} };
    if (request.endsWith("/lib/persistent-logger")) return { persistentLogger: fakeLogger };
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
function reset() { secure.clear(); secureOperations.length = 0; asyncStorage.clear(); logs.length = 0; failSecureWrite = false; failSecureReadback = false; failSecureWriteKeys.clear(); }
const canonical = (provider) => `aib.agent-auth.v1.${provider}`;

try {
  const transport = loadTs(path.join(root, "core/enhancements/auth/productionProviderTransport.ts"));

  // A SecureStore alias is copied and verified under the canonical AgentAuthStore name before deletion.
  reset();
  const secureAliasSecret = "legacy-secure-alias-key";
  secure.set("aibuilder.openrouter.apikey", secureAliasSecret);
  assert.equal(await transport.migrateProviderCredential("openrouter", ["aibuilder.openrouter.apikey"]), true);
  assert.equal(secure.get(canonical("openrouter")), secureAliasSecret);
  assert.equal(secure.has("aibuilder.openrouter.apikey"), false);
  assert.equal(await transport.hasProviderCredential("openrouter"), true);

  // A retired legacy provider credential is retained byte-for-byte and is never read, migrated, routed, or deleted.
  reset();
  const current = "canonical-current-key";
  const old = "legacy-distinct-key";
  const retiredProvider = ["deep", "seek"].join("");
  const retiredCanonical = canonical(retiredProvider);
  const retiredLegacyField = `aibuilder.${retiredProvider}.apikey`;
  secure.set(retiredCanonical, current);
  secure.set(retiredLegacyField, old);
  assert.equal(await transport.hasProviderCredential(retiredProvider), false);
  assert.equal(await transport.migrateProviderCredential(retiredProvider, [retiredLegacyField]), false);
  assert.equal(await transport.migrateInlineProviderCredential(retiredProvider, old), false);
  assert.equal(await transport.saveProviderCredential(retiredProvider, "replacement-key"), false);
  assert.equal(await transport.resolveAgentProviderRoute(retiredProvider), undefined);
  await assert.rejects(() => transport.securedProviderFetch(retiredProvider, { baseUrl: "https://api.deepseek.com/v1" }, "chat/completions"), /PROVIDER_NOT_SUPPORTED/);
  assert.deepEqual(secureOperations.filter(([, key]) => key === retiredCanonical || key === retiredLegacyField), [], "no read/write/delete operation may touch retired credential keys");
  assert.equal(secure.get(retiredCanonical), current);
  assert.equal(secure.get(retiredLegacyField), old);

  // A legacy plaintext fallback is removed only after a verified SecureStore copy exists.
  reset();
  const fallbackSecret = "legacy-async-fallback-key";
  asyncStorage.set("aibuilder.custom.apikey.fallback", fallbackSecret);
  assert.equal(await transport.migrateProviderCredential("custom.slot1", [], ["aibuilder.custom.apikey.fallback"]), true);
  assert.equal(secure.get(canonical("custom.slot1")), fallbackSecret);
  assert.equal(asyncStorage.has("aibuilder.custom.apikey.fallback"), false);

  // Conflicting plaintext fallback values are preserved securely without replacing a canonical credential.
  reset();
  secure.set(canonical("custom.slot2"), current);
  asyncStorage.set("aibuilder.custom.provider2.apikey.fallback", old);
  assert.equal(await transport.migrateProviderCredential("custom.slot2", [], ["aibuilder.custom.provider2.apikey.fallback"]), true);
  assert.equal(secure.get(canonical("custom.slot2")), current);
  assert.ok([...secure.entries()].some(([key, value]) => key.startsWith("aib.agent-auth.legacy.v1.custom.slot2.") && value === old));
  assert.equal(asyncStorage.has("aibuilder.custom.provider2.apikey.fallback"), false);

  // A SecureStore write failure preserves the legacy source and reports not-configured.
  reset();
  asyncStorage.set("legacy.key", fallbackSecret);
  failSecureWrite = true;
  assert.equal(await transport.migrateProviderCredential("opencode", [], ["legacy.key"]), false);
  assert.equal(asyncStorage.get("legacy.key"), fallbackSecret);
  assert.equal(secure.has(canonical("opencode")), false);

  // A write that appears to succeed but cannot be read back is unverified: retain the source, but never expose/use it as a credential.
  reset();
  asyncStorage.set("legacy.readback", fallbackSecret);
  failSecureReadback = true;
  assert.equal(await transport.migrateProviderCredential("opencode", [], ["legacy.readback"]), false);
  failSecureReadback = false;
  assert.equal(asyncStorage.has("legacy.readback"), false, "a verified pending SecureStore copy permits removing the plaintext source");
  assert.equal(secure.get("aib.agent-auth.pending.v1.opencode.0"), fallbackSecret, "the exact source remains recoverable only in verified SecureStore");
  assert.equal(secure.has(canonical("opencode")), false, "failed readback must roll back the uncertain secure write");
  assert.equal(await transport.hasProviderCredential("opencode"), false, "unverified legacy source is never treated as configured");
  const { AgentAuthStore } = loadTs(path.join(root, "core/enhancements/auth/AgentAuthStore.ts"));
  const { CredentialProxy } = loadTs(path.join(root, "core/enhancements/auth/CredentialProxy.ts"));
  let nativeStarts = 0;
  const secureOnlyStore = new AgentAuthStore({ get: async (key) => secure.get(key) ?? null, set: async (key, value) => { secure.set(key, value); }, delete: async (key) => { secure.delete(key); } });
  const blockedProxy = new CredentialProxy(secureOnlyStore, { opencode: { baseUrl: "https://example.invalid/v1" } }, { nativeTransport: { start: async () => { nativeStarts += 1; return { sessionId: "must-not-start", baseUrl: "http://127.0.0.1:32123/v1/session/must-not-start", apiKey: "dummy-aib-proxy-key" }; }, stop: async () => true } });
  await assert.rejects(blockedProxy.start("opencode"), (error) => error?.code === "CREDENTIAL_MISSING");
  assert.equal(nativeStarts, 0, "the proxy must not read legacy AsyncStorage values or start with them");
  assert.equal(logs.some((message) => message.includes(fallbackSecret)), false, "migration failure logs never contain preserved source values");

  // If the canonical key alone fails but a pending SecureStore key verifies, remove plaintext source but keep the provider disabled until canonical promotion succeeds.
  reset();
  const pendingSecret = "partial-secure-failure-secret";
  const pendingCanonical = canonical("custom.slot1");
  asyncStorage.set("aibuilder.custom.apikey.fallback", pendingSecret);
  failSecureWriteKeys.add(pendingCanonical);
  assert.equal(await transport.migrateProviderCredential("custom.slot1", [], ["aibuilder.custom.apikey.fallback"]), false);
  assert.equal(asyncStorage.has("aibuilder.custom.apikey.fallback"), false, "a verified SecureStore quarantine permits removing the plaintext fallback");
  assert.equal(secure.get("aib.agent-auth.pending.v1.custom.slot1.0"), pendingSecret);
  assert.equal(await transport.hasProviderCredential("custom.slot1"), false, "pending encrypted values are not active credentials");
  failSecureWriteKeys.clear();
  assert.equal(await transport.migrateProviderCredential("custom.slot1"), true, "a later retry promotes the pending value after canonical storage recovers");
  assert.equal(secure.get(pendingCanonical), pendingSecret);
  assert.equal(secure.has("aib.agent-auth.pending.v1.custom.slot1.0"), false);

  // Inline legacy values use the same protected pending path; no plaintext settings payload must be kept when SecureStore quarantine verifies.
  reset();
  failSecureWriteKeys.add(canonical("openrouter"));
  assert.equal(await transport.migrateInlineProviderCredential("openrouter", pendingSecret), true);
  assert.equal(secure.get("aib.agent-auth.pending.v1.openrouter.0"), pendingSecret);
  assert.equal(await transport.hasProviderCredential("openrouter"), false);
  assert.match(appSettingsSource, /legacyMigrated && legacyKeys\.length\) custom1Configured = await migrateProviderCredential\("custom\.slot1"\)/, "slot 1 only becomes active after pending credential promotion");
  assert.match(appSettingsSource, /legacyMigrated && legacyKeys\.length\) custom2Configured = await migrateProviderCredential\("custom\.slot2"\)/, "slot 2 only becomes active after pending credential promotion");
  assert.match(appSettingsSource, /legacyMigrated && parsed\.apiKey\?\.trim\(\)\) openCodeConfigured = await migrateProviderCredential\("opencode"\)/, "OpenCode only becomes active after pending credential promotion");
  failSecureWriteKeys.clear();
  assert.equal(await transport.migrateProviderCredential("openrouter"), true);
  assert.equal(secure.get(canonical("openrouter")), pendingSecret);

  // Inline settings conflicts migrate into a SecureStore-only legacy alias, never overwrite canonical.
  reset();
  secure.set(canonical("openrouter"), current);
  assert.equal(await transport.migrateInlineProviderCredential("openrouter", old), true);
  assert.equal(secure.get(canonical("openrouter")), current);
  assert.ok([...secure.entries()].some(([key, value]) => key.startsWith("aib.agent-auth.legacy-inline.v1.openrouter.") && value === old));

  // Normal credential save writes only the canonical SecureStore record and invalidates proxy sessions.
  reset();
  const newKey = "replacement-secure-key";
  const beforeStops = proxyStops;
  assert.equal(await transport.saveProviderCredential("opencode", newKey), true);
  assert.equal(secure.get(canonical("opencode")), newKey);
  assert.equal(asyncStorage.size, 0);
  assert.equal(proxyStops, beforeStops + 1);
  assert.equal(await transport.saveProviderCredential("opencode", ""), true);
  assert.equal(secure.has(canonical("opencode")), false);
  assert.equal(logs.some((message) => message.includes(secureAliasSecret) || message.includes(fallbackSecret) || message.includes(old) || message.includes(current) || message.includes(newKey) || message.includes(pendingSecret)), false);

  console.log("AIB_PROVIDER_CREDENTIAL_MIGRATION_SELFTEST_OK canonical=verified pending-secure-quarantine=verified retry=verified total-store-failure=source-preserved-provider-disabled");
} finally {
  // The maps contain only synthetic test values and do not leave the script process.
  reset();
}
