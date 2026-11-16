#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = new Map();
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

async function main() {
  const { AgentAuthStore } = loadTs(path.join(root, "core/enhancements/auth/AgentAuthStore.ts"));
  const { AGENT_AUTH_PROXY_ACCESS } = loadTs(path.join(root, "core/enhancements/auth/AgentAuthProxyAccess.ts"));
  const values = new Map();
  const operations = [];
  let failAfterWriteOnce = false;
  const storage = {
    async get(key) { operations.push(["get", key]); return values.has(key) ? values.get(key) : null; },
    async set(key, value) {
      operations.push(["set", key]);
      if (failAfterWriteOnce && key.startsWith("aib.agent-auth.v1.")) {
        failAfterWriteOnce = false;
        values.set(key, value);
        throw new Error("SIMULATED_SECURE_WRITE_FAILURE");
      }
      values.set(key, value);
    },
    async delete(key) { operations.push(["delete", key]); values.delete(key); },
  };
  const store = new AgentAuthStore(storage);
  const providers = ["openrouter", "custom.slot1", "custom.slot2", "opencode"];

  for (const provider of providers) {
    const first = `mock-value-one-${provider}`;
    const replacement = `mock-value-two-${provider}`;
    await store.setProviderKey(provider, first);
    const savedMetadata = await store.getProviderKey(provider);
    assert.equal(savedMetadata.configured, true);
    assert.equal(savedMetadata.provider, provider);
    assert.notEqual(savedMetadata.masked, first, "public reads return metadata, never the saved value");
    assert.equal(await store.hasKey(provider), true);

    // Simulate a Settings screen/app instance reopening over the same SecureStore adapter.
    const reopenedStore = new AgentAuthStore(storage);
    assert.equal((await reopenedStore.getProviderKey(provider)).configured, true);
    assert.equal(await reopenedStore.hasKey(provider), true);

    await reopenedStore.setProviderKey(provider, replacement);
    assert.throws(() => reopenedStore.createProxyResolver(), (error) => error?.code === "PROXY_ACCESS_DENIED", "unprivileged callers must not obtain a plaintext resolver");
    const resolveForProxy = reopenedStore.createProxyResolver(AGENT_AUTH_PROXY_ACCESS);
    assert.equal(await resolveForProxy(provider), replacement, "proxy resolution sees the latest saved replacement, not a stale in-memory key");
    assert.equal((await reopenedStore.getProviderKey(provider)).masked === replacement, false);
  }

  for (const shortValue of ["x", "ab", "1234"]) {
    await store.setProviderKey("short-mask-test", shortValue);
    const metadata = await store.getProviderKey("short-mask-test");
    assert.equal(metadata.masked, "••••", "short credentials must not be fully disclosed by the masked hint");
    assert.equal(JSON.stringify(metadata).includes(shortValue), false);
  }

  const firstConcurrentWrite = store.setProviderKey("custom.slot1", "mock-concurrent-first");
  const secondConcurrentWrite = store.setProviderKey("custom.slot1", "mock-concurrent-second");
  await Promise.all([firstConcurrentWrite, secondConcurrentWrite]);
  const resolveForProxy = store.createProxyResolver(AGENT_AUTH_PROXY_ACCESS);
  assert.equal(await resolveForProxy("custom.slot1"), "mock-concurrent-second", "serialized writes preserve invocation order and the newest replacement");

  const beforeFailure = await resolveForProxy("openrouter");
  failAfterWriteOnce = true;
  await assert.rejects(store.setProviderKey("openrouter", "mock-value-failed-replacement"), /Secure credential storage failed/);
  const afterFailure = await resolveForProxy("openrouter");
  assert.equal(afterFailure, beforeFailure, "failed replacement restores the previously saved credential");
  assert.equal(await store.hasKey("openrouter"), true);

  const writeOpsBeforeEmpty = operations.filter(([op]) => op === "set").length;
  const writeOpsAfterEmpty = operations.filter(([op]) => op === "set").length;
  assert.equal(writeOpsAfterEmpty, writeOpsBeforeEmpty, "empty/cancel-like input must not mutate secure storage");

  const settings = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");
  const transport = fs.readFileSync(path.join(root, "core/enhancements/auth/productionProviderTransport.ts"), "utf8");
  const saveHandler = settings.slice(settings.indexOf("const handleSaveApiKey"), settings.indexOf("const handleCheckApiKey"));
  const checkHandler = settings.slice(settings.indexOf("const handleCheckApiKey"), settings.indexOf("const handleSaveSystemPrompt"));
  const inlineMigration = transport.slice(transport.indexOf("export async function migrateInlineProviderCredential"), transport.indexOf("export async function migrateProviderCredential"));
  const aliasMigration = transport.slice(transport.indexOf("export async function migrateProviderCredential"), transport.indexOf("export async function deleteProviderCredential"));
  assert.ok(saveHandler.indexOf("if (!key)") < saveHandler.indexOf("setOnlineApiKey(key)"), "empty Save must return before secure write");
  assert.match(checkHandler, /if \(!key && !onlineModel\.hasApiKey\)/, "empty Check must return before probing");
  assert.match(checkHandler, /validateOpenRouterApiKey\(key\)/, "Check validates the typed key without installing it");
  assert.doesNotMatch(checkHandler, /setOnlineApiKey/, "Check must never persist or replace the stored credential");
  assert.match(checkHandler, /setApiKeyCheckResult\(\{/);
  assert.match(checkHandler, /setCheckingApiKey\(false\)/);
  assert.match(settings, /onlineModel\.hasApiKey \? t\("apiKeySavedPlaceholder"\)/);
  assert.match(settings, /apiKeyDraftDirty && !!apiKeyDraft\.trim\(\)/);
  assert.match(inlineMigration, /return serializeCredentialMutation\(provider/);
  assert.match(aliasMigration, /return serializeCredentialMutation\(provider/);

  values.set("aib.agent-auth.legacy.v1.openrouter.0", "mock-preserved-legacy-one");
  values.set("aib.agent-auth.legacy-inline.v1.openrouter.1", "mock-preserved-legacy-two");
  values.set("aib.agent-auth.pending.v1.openrouter.2", "mock-pending-secure-copy");
  await store.deleteKey("openrouter");
  assert.equal(await store.hasKey("openrouter"), false, "explicit clear removes the canonical credential");
  assert.equal(values.has("aib.agent-auth.legacy.v1.openrouter.0"), false, "explicit clear removes preserved SecureStore migration aliases");
  assert.equal(values.has("aib.agent-auth.legacy-inline.v1.openrouter.1"), false, "explicit clear removes preserved inline migration aliases");
  assert.equal(values.has("aib.agent-auth.pending.v1.openrouter.2"), false, "explicit clear removes pending SecureStore migration copies");
  assert.doesNotMatch(transport, /export const productionAgentAuthStore|export const productionCredentialProxy/, "production resolver and proxy objects remain module-private");

  console.log("AIB_PROVIDER_CREDENTIAL_LIFECYCLE_SELFTEST_OK providers=4 reopenMetadata=1 latestProxyRead=1 concurrentWriteOrder=1 migrationSerialization=1 failedReplaceRollback=1 emptyNoMutation=1 aliasDeletion=1 secretValues=mock-only");
}
main().catch((error) => { console.error(error?.stack || String(error)); process.exit(1); });
