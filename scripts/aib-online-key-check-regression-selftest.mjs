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
    if (request.startsWith(".")) {
      const resolved = resolveTs(file, request);
      if (resolved) return loadTs(resolved);
    }
    return createRequire(file)(request);
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
const settings = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");
const locales = fs.readFileSync(path.join(root, "lib/i18n.ts"), "utf8");
const customDialog = fs.readFileSync(path.join(root, "components/CustomProviderDialog.tsx"), "utf8");
const openCodeDialog = fs.readFileSync(path.join(root, "components/OpenCodeModelsDialog.tsx"), "utf8");
  const saveHandler = settings.slice(settings.indexOf("const handleSaveApiKey"), settings.indexOf("const handleCheckApiKey"));
  const checkHandler = settings.slice(settings.indexOf("const handleCheckApiKey"), settings.indexOf("const handleSaveSystemPrompt"));
  assert.match(saveHandler, /setOnlineApiKey\(key\)/, "only the explicit install handler persists a key");
  assert.match(checkHandler, /validateOpenRouterApiKey\(key\)/, "the check handler validates its draft key");
  assert.doesNotMatch(checkHandler, /setOnlineApiKey|setApiKeyDraft\(\s*["']\s*["']\s*\)/, "checking neither persists the key nor clears the draft");
  assert.match(settings, /onPress=\{handleSaveApiKey\}/, "the install action has its own control");
  assert.match(settings, /onPress=\{handleCheckApiKey\}/, "the check action has its own control");
  assert.match(settings, /\{t\("saveKey"\)\}/);
  assert.match(settings, /\{checkingApiKey \? t\("checkingApiKey"\) : t\("checkApiKey"\)\}/);
  for (const label of ["saveKey: \"Встановити ключ\"", "saveKey: \"Установить ключ\"", "saveKey: \"Install key\""]) {
    assert.equal((locales.match(new RegExp(`^\\s+${label},$`, "gm")) || []).length, 1, `${label} is localized exactly once`);
  }

  const { AgentAuthStore } = loadTs(path.join(root, "core/enhancements/auth/AgentAuthStore.ts"));
  const { CredentialProxy, DUMMY_PROXY_API_KEY } = loadTs(path.join(root, "core/enhancements/auth/CredentialProxy.ts"));
  const values = new Map();
  let secureWrites = 0;
  const storage = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { secureWrites += 1; values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
  const store = new AgentAuthStore(storage);
  await store.setProviderKey("openrouter", "installed-key-before-check");
  const writesBeforeCheck = secureWrites;
  const savedSnapshot = new Map(values);
  const startedCredentials = [];
  const stoppedSessions = [];
  const requestedUrls = [];
  const proxy = new CredentialProxy(store, {
    openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
    opencode: { baseUrl: "https://opencode.ai/zen/v1" },
    "custom.slot1": { baseUrl: "https://invalid.local" },
    "custom.slot2": { baseUrl: "https://invalid.local" },
  }, {
    nativeTransport: {
      async start(provider, credential, route) {
        startedCredentials.push({ provider, credential, baseUrl: route.baseUrl });
        const sessionId = `key-check-${startedCredentials.length}`;
        return {
          sessionId,
          baseUrl: `http://127.0.0.1:${44000 + startedCredentials.length}/v1/session/${sessionId}`,
          apiKey: DUMMY_PROXY_API_KEY,
        };
      },
      async stop(sessionId) { stoppedSessions.push(sessionId); return true; },
    },
    fetcher: async (input, init) => {
      requestedUrls.push(String(input));
      assert.equal(init.method, "GET");
      assert.equal(init.headers.get("Authorization"), `Bearer ${DUMMY_PROXY_API_KEY}`, "app request contains only the dummy proxy key");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await proxy.probeWithCredential(
    { provider: "openrouter", path: "key", method: "GET" },
    "candidate-key-only-for-check",
  );
  assert.equal(result.status, 200);
  assert.equal(startedCredentials[0].credential, "candidate-key-only-for-check", "native proxy receives the candidate only for its one-shot probe session");
  assert.equal(secureWrites, writesBeforeCheck, "checking must not write to secure storage");
  assert.deepEqual(new Map(values), savedSnapshot, "the installed credential and all secure-store values remain unchanged");
  assert.deepEqual(stoppedSessions, ["key-check-1"], "the transient proxy session is stopped after the check");
  assert.match(requestedUrls[0], /\/v1\/session\/key-check-1\/key$/);
  assert.doesNotMatch(requestedUrls[0], /candidate-key-only-for-check|installed-key-before-check/, "credentials are not placed in the app request URL");

  // Generic GET /models draft probes work for each configurable provider identity.
  for (const [provider, baseUrl] of [
    ["custom.slot1", "https://slot-one.example/v1"],
    ["custom.slot2", "https://slot-two.example/v1"],
    ["opencode", "https://opencode.ai/zen/v1"],
  ]) {
    const sessionId = `key-check-${startedCredentials.length + 1}`;
    const draftResult = await proxy.probeWithCredential(
      { provider, path: "models", method: "GET" },
      `draft-only-${provider}`,
      { baseUrl },
    );
    assert.equal(draftResult.status, 200);
    const started = startedCredentials.at(-1);
    assert.equal(started.provider, provider);
    assert.equal(started.credential, `draft-only-${provider}`);
    assert.equal(started.baseUrl, baseUrl, "draft session is bound to the exact configured slot destination");
    assert.ok(stoppedSessions.includes(sessionId), "every transient custom/OpenCode session is stopped");
    assert.equal(secureWrites, writesBeforeCheck, "all draft checks leave SecureStore unchanged");
    assert.deepEqual(new Map(values), savedSnapshot, "all installed credentials remain unchanged after draft checks");
  }
  const retiredProvider = ["deep", "seek"].join("");
  const beforeRetiredProbe = startedCredentials.length;
  await assert.rejects(
    () => proxy.probeWithCredential({ provider: retiredProvider, path: "models", method: "GET" }, "retired-draft-key", { baseUrl: "https://retired.example/v1" }),
    (error) => error?.code === "PROVIDER_NOT_SUPPORTED",
    "retired provider IDs are unavailable even for transient draft probes",
  );
  assert.equal(startedCredentials.length, beforeRetiredProbe, "retired provider rejection starts no proxy session");
  assert.equal(secureWrites, writesBeforeCheck, "retired provider checks also leave SecureStore unchanged");

  assert.match(customDialog, /probeCustomProviderModels/);
  assert.match(customDialog, /draftKey\s*\?\s*await probeCustomProviderModels/);
  assert.doesNotMatch(customDialog, /ensureCredential|onSaveCredential/, "custom verification does not call an install/save callback");
  assert.match(customDialog, /onPress=\{handleSave\}/, "custom credentials are persisted only by the explicit Install key button");
  assert.match(openCodeDialog, /probeCustomProviderModels/);
  assert.match(openCodeDialog, /draftKey\s*\?\s*await probeCustomProviderModels/);
  assert.doesNotMatch(openCodeDialog, /ensureCredential|onSaveCredential/, "OpenCode verification does not call an install/save callback");
  assert.match(openCodeDialog, /\{t\("saveKey"\)\}/, "OpenCode install action is explicitly labeled");
  assert.match(customDialog, /editable=\{!isLoading && !checkingKey && !modelsLoading && !savingSecure\}/, "custom endpoint/key fields are locked during in-flight probes");
  assert.match(openCodeDialog, /editable=\{!isLoading && !checkingKey && !modelsLoading && !savingSecure\}/, "OpenCode endpoint/key fields are locked during in-flight probes");
  assert.match(customDialog, /const saved = await onSave\(config\)/, "custom SecureStore persistence belongs to the explicit install action");
  assert.match(openCodeDialog, /const saved = await onSave\(config\)/, "OpenCode SecureStore persistence belongs to the explicit install action");
  assert.equal(fs.existsSync(path.join(root, "components/DeepSeekModelsDialog.tsx")), false, "retired credential dialog is unavailable");

  console.log("AIB_ONLINE_KEY_CHECK_REGRESSION_OK checks=ui-action-separation,draft-preserved,transient-probes=openrouter,custom.slot1,custom.slot2,opencode,retired-provider=unavailable,no-secure-store-mutation,session-cleanup,install-labels=3");
}

main().catch((error) => { console.error(error?.stack || String(error)); process.exit(1); });
