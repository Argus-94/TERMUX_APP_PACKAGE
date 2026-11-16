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
const logEntries = [];
const transientProbeCalls = [];
const logger = {
  add(level, tag, message) { logEntries.push({ level, tag, message }); },
  markModelRequest() {},
  markModelResponse() {},
};

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
    if (request.endsWith("/productionProviderTransport")) return {
      securedProviderFetch: async () => { throw new Error("TEST_TRANSPORT_NOT_INJECTED"); },
      probeOpenRouterCredential: async (credential, signal) => {
        transientProbeCalls.push({ credential, signal });
        return response(200, JSON.stringify({ data: { ok: true } }));
      },
    };
    if (request === "./persistent-logger") return { persistentLogger: logger };
    if (request === "./log-redaction") return { redactSecrets: (value) => String(value) };
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
const response = (status, body = "", headers = {}) => new Response(body, { status, headers });

async function main() {
  const statusApi = loadTs(path.join(root, "lib/provider-probe-status.ts"));
  const online = loadTs(path.join(root, "lib/online-model.ts"));
  const customProvider = loadTs(path.join(root, "lib/custom-provider.ts"));
  const providerUtils = loadTs(path.join(root, "lib/provider-utils.ts"));
  const useLlmSource = fs.readFileSync(path.join(root, "hooks/useLLM.ts"), "utf8");
  const settingsHook = fs.readFileSync(path.join(root, "hooks/useAppSettings.ts"), "utf8");
  const fallbackModels = [{ id: "working-first" }, { id: "working-second" }];
  assert.equal(online.selectOpenRouterFallbackModelId("selected", { "working-first": "working", selected: "unknown" }, fallbackModels), null, "a previously broken selected model omitted from this round cannot trigger a stale fallback");
  assert.equal(online.selectOpenRouterFallbackModelId("selected", { "working-first": "working", selected: "rate_limited" }, fallbackModels), null, "quota/rate-limit evidence does not auto-switch");
  assert.equal(online.selectOpenRouterFallbackModelId("selected", { "working-first": "working", selected: "unavailable" }, fallbackModels), "working-first");
  assert.equal(online.selectOpenRouterFallbackModelId("selected", { selected: "broken" }, fallbackModels), null, "a broken model without a proven working fallback remains selected");
  assert.match(settingsHook, /selectOpenRouterFallbackModelId\(currentId, roundStatus, FREE_OPENROUTER_MODELS\)/);
  assert.doesNotMatch(settingsHook, /mergedStatus\[currentId\]/);
  assert.equal(providerUtils.formatModelIdForLog(""), "(empty)");
  assert.equal(providerUtils.formatModelIdForLog("   "), "(empty)");
  assert.equal(providerUtils.formatModelIdForLog("google/gemma-chat"), "google/gemma-chat");
  assert.ok(
    useLlmSource.includes('persistentLogger.add("warn", "Chat", `Unsupported model blocked: ${formatModelIdForLog(mid)}`)'),
    "unsupported-model guard diagnostics must mark a missing Model ID explicitly",
  );
  const outcomes = [
    [200, response(200, JSON.stringify({ data: { ok: true } })), "key_valid", true],
    [401, response(401, "Unauthorized"), "key_invalid", false],
    [403, response(403, "Forbidden"), "key_invalid", false],
    [429, response(429, JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day" } }), { "content-type": "application/json", "retry-after": "30" }), "daily_quota", null],
    [429, response(429, "Too many requests"), "rate_limited", null],
    [404, response(404, "Not found"), "endpoint_unavailable", null],
    [503, response(503, "Service unavailable"), "upstream_error", null],
  ];
  for (const [code, reply, expectedStatus, expectedValidity] of outcomes) {
    const result = await online.validateOpenRouterApiKey(async (provider, route, requestPath, init) => {
      assert.equal(provider, "openrouter");
      assert.equal(requestPath, "key");
      assert.equal(init.method, "GET");
      assert.ok(init.signal instanceof AbortSignal);
      return reply;
    });
    assert.equal(result.status, expectedStatus, `HTTP ${code} status classification`);
    assert.equal(result.valid, expectedValidity, `HTTP ${code} key verdict`);
    assert.equal(Object.hasOwn(result, "modelId"), false, "key-only probe must not mark a model available or selected");
    if (code === 429 && expectedStatus === "daily_quota") assert.equal(result.retryAfterMs, 30_000);
  }

  const candidateResult = await online.validateOpenRouterApiKey("test-only-draft-key");
  assert.equal(candidateResult.status, "key_valid");
  assert.equal(transientProbeCalls.length, 1, "candidate-key validation must use the transient proxy entry point");
  assert.equal(transientProbeCalls[0].credential, "test-only-draft-key");
  assert.ok(transientProbeCalls[0].signal instanceof AbortSignal);

  const network = await online.validateOpenRouterApiKey(async () => { throw new TypeError("Failed to fetch"); });
  assert.equal(network.status, "network_error");
  assert.equal(network.valid, null, "no HTTP response must not be called an invalid key");
  const timedOut = await online.validateOpenRouterApiKey(async (_provider, _route, _path, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "AbortError" })), { once: true });
  }), 5);
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.valid, null);
  const nonCooperativeKeyStarted = Date.now();
  const nonCooperativeKey = await online.validateOpenRouterApiKey(async () => new Promise(() => {}), 15);
  assert.equal(nonCooperativeKey.status, "timeout", "a transport that ignores AbortSignal still reaches a bounded timeout");
  assert.ok(Date.now() - nonCooperativeKeyStarted < 500, "key validation must not wait for a non-cooperative transport forever");
  const stalledKeyBody = await online.validateOpenRouterApiKey(async () => ({
    status: 429,
    headers: new Headers(),
    json: () => new Promise(() => {}),
  }), 15);
  assert.equal(stalledKeyBody.status, "timeout", "provider error-body parsing is inside the hard key-probe deadline");
  const cancelledKeyController = new AbortController();
  let keyStartedResolve;
  const keyStarted = new Promise((resolve) => { keyStartedResolve = resolve; });
  const cancelledKeyProbe = online.validateOpenRouterApiKey(async () => {
    keyStartedResolve();
    return new Promise(() => {});
  }, 1_000, cancelledKeyController.signal);
  await keyStarted;
  cancelledKeyController.abort();
  await assert.rejects(cancelledKeyProbe, /ABORTED/, "caller cancellation is not reported as a bad key or network failure");

  assert.equal(statusApi.classifyProviderHttpStatus(404, "model"), "model_unavailable");
  assert.equal(statusApi.classifyProviderHttpStatus(404, "endpoint"), "endpoint_unavailable");
  assert.equal(statusApi.classifyProviderHttpStatus(401, "model"), "key_invalid");
  assert.equal(statusApi.classifyProviderHttpStatus(403, "key"), "key_invalid", "an explicit auth-check 403 may reject the credential");
  assert.equal(statusApi.classifyProviderHttpStatus(403, "endpoint"), "access_denied", "a model-list 403 must not be called an invalid key");
  assert.equal(statusApi.classifyProviderHttpStatus(403, "model"), "access_denied", "model entitlement denial remains separate from key validity");
  assert.equal(statusApi.classifyProviderHttpStatus(503, "model"), "upstream_error");
  assert.equal(statusApi.classifyProviderHttpStatus(401, "request"), "key_invalid");
  assert.equal(statusApi.classifyProviderHttpStatus(403, "request"), "access_denied");
  assert.equal(statusApi.classifyProviderHttpStatus(429, "request"), "rate_limited");
  assert.equal(statusApi.classifyProviderHttpStatus(503, "request"), "upstream_error");
  assert.equal(statusApi.providerKeyValidity("daily_quota"), null);
  assert.equal(statusApi.providerKeyValidity("network_error"), null);
  assert.equal(statusApi.providerProbeTone("key_invalid"), "danger");
  assert.equal(statusApi.providerProbeTone("daily_quota"), "warning");
  assert.equal(statusApi.providerProbeTone("upstream_error"), "warning");
  assert.equal(statusApi.providerProbeTone("key_valid"), "success");
  assert.equal(statusApi.providerProbeTone("access_denied"), "danger");
  const engineErrors = loadTs(path.join(root, "lib/engine-errors.ts"));
  const translationKey = (key) => key;
  assert.equal(engineErrors.translateEngineError(translationKey, "HTTP:429:DAILY_FREE_QUOTA"), "providerCheckDailyQuota");
  assert.equal(engineErrors.translateEngineError(translationKey, "HTTP:429:REQUEST_REJECTED"), "providerCheckRateLimited");
  assert.equal(engineErrors.translateEngineError(translationKey, "HTTP:403:MODEL_ACCESS_DENIED"), "providerCheckAccessDenied");
  assert.equal(engineErrors.translateEngineError(translationKey, "HTTP:404:MODEL_UNAVAILABLE"), "providerCheckModelUnavailable");
  assert.equal(engineErrors.translateEngineError(translationKey, "HTTP:503:UPSTREAM_ERROR"), "providerCheckUpstreamError");
  assert.equal(engineErrors.translateEngineError(translationKey, "NETWORK:transport"), "providerCheckNetworkError");
  assert.equal(engineErrors.translateEngineError(translationKey, "TIMEOUT"), "providerCheckTimeout");
  assert.equal(engineErrors.translateEngineError(translationKey, "HTTP:401:AUTH_REJECTED"), "apiKeyInvalid");
  for (const [message, expected] of [
    ["STT_AUTH_REJECTED: HTTP 401", "apiKeyInvalid"],
    ["STT_ACCESS_DENIED: HTTP 403", "providerCheckAccessDenied"],
    ["STT_RATE_LIMIT: HTTP 429", "providerCheckRateLimited"],
    ["STT_MODEL_OR_ENDPOINT_UNAVAILABLE: HTTP 404", "providerCheckSttUnavailable"],
    ["STT_UPSTREAM_ERROR: HTTP 503", "providerCheckUpstreamError"],
    ["STT_TIMEOUT", "providerCheckTimeout"],
    ["STT_NETWORK_ERROR", "providerCheckNetworkError"],
    ["STT_FAILED: STT_NETWORK_ERROR", "providerCheckNetworkError"],
  ]) assert.equal(engineErrors.translateEngineError(translationKey, message), expected, `${message} localized status`);

  const model403 = await online.checkOpenRouterModels(
    [{ id: "synthetic/model", name: "Synthetic", vision: false, contextLength: 1024 }],
    undefined,
    { maxRetries: 0, staggerMs: 0 },
    async () => response(403, "SYNTHETIC_PROVIDER_ERROR_BODY"),
  );
  assert.equal(model403["synthetic/model"].status, "access_denied", "model-specific 403 is not a bad-key result");
  const model401 = await online.checkOpenRouterModels(
    [{ id: "synthetic/model", name: "Synthetic", vision: false, contextLength: 1024 }],
    undefined,
    { maxRetries: 0, staggerMs: 0 },
    async () => response(401, "SYNTHETIC_PROVIDER_ERROR_BODY"),
  );
  assert.equal(model401["synthetic/model"].status, "auth_error", "actual 401 remains an auth failure");
  const stalledModel = await online.checkOpenRouterModels(
    [{ id: "synthetic/stalled", name: "Synthetic stalled", vision: false, contextLength: 1024 }],
    undefined,
    { maxRetries: 0, staggerMs: 0, requestTimeoutMs: 15 },
    async () => new Promise(() => {}),
  );
  assert.equal(stalledModel["synthetic/stalled"].status, "timeout", "a non-cooperative model transport is race-bounded");
  const stalledModelBody = await online.checkOpenRouterModels(
    [{ id: "synthetic/stalled-body", name: "Synthetic stalled body", vision: false, contextLength: 1024 }],
    undefined,
    { maxRetries: 0, staggerMs: 0, requestTimeoutMs: 15 },
    async () => ({ status: 200, ok: true, json: () => new Promise(() => {}), headers: new Headers() }),
  );
  assert.equal(stalledModelBody["synthetic/stalled-body"].status, "timeout", "model response-body parsing is bounded too");
  const bodySentinel = "SYNTHETIC_PROVIDER_ERROR_BODY";
  const failingEngine = new online.OnlineModelEngine(async () => response(500, bodySentinel));
  await assert.rejects(() => failingEngine.chat([], undefined, "en", undefined, "synthetic/model"), /HTTP:500:UPSTREAM_ERROR/);
  const replySentinel = "SYNTHETIC_PRIVATE_REPLY_SENTINEL";
  const successEngine = new online.OnlineModelEngine(async () => response(200, JSON.stringify({ choices: [{ message: { content: replySentinel } }] })));
  assert.equal(await successEngine.chat([], undefined, "en", undefined, "synthetic/model"), replySentinel);
  assert.equal(logEntries.some((entry) => entry.message.includes(bodySentinel) || entry.message.includes(replySentinel)), false, "provider error bodies and model replies are not persisted in app logs");

  let customQuotaAttempts = 0;
  const dailyQuotaEngine = new customProvider.CustomProviderEngine(async () => {
    customQuotaAttempts++;
    return response(429, JSON.stringify({ error: { message: "free-models-per-day synthetic quota fixture" } }), { "retry-after": "120" });
  });
  dailyQuotaEngine.setConfig({ baseUrl: "https://provider.invalid/v1", hasApiKey: true, modelId: "synthetic/chat-free:free" });
  await assert.rejects(
    () => dailyQuotaEngine.chat([{ role: "user", content: "synthetic" }]),
    (error) => error.message === "HTTP:429:DAILY_QUOTA",
    "daily account quota is reported distinctly from retryable rate limits",
  );
  assert.equal(customQuotaAttempts, 1, "account-wide daily quota is never retried");
  assert.match(useLlmSource, /free-models-per-day\|1000 free model requests\|HTTP:429:DAILY_FREE_QUOTA/i, "the normalized transport error for an account-wide daily free quota must enter the no-failover branch");
  assert.match(useLlmSource, /if \(!localModelEngine\.isLoaded\(\)\) throw new Error\("HTTP:429:DAILY_FREE_QUOTA"\)/, "a daily free-model quota cannot trigger another free-provider attempt when local recovery is unavailable");

  const persistentLoggerSource = fs.readFileSync(path.join(root, "lib/persistent-logger.ts"), "utf8");
  assert.doesNotMatch(persistentLoggerSource, /ModelPrompt|fullPayload/, "model prompts must not be stored in persistent logs");
  assert.doesNotMatch(persistentLoggerSource, /chars=\$\{text\.length\}\\n\$\{text\}/, "model response content must not be stored in persistent logs");
  const sttSource = fs.readFileSync(path.join(root, "lib/audio-transcribe.ts"), "utf8");
  assert.match(sttSource, /STT_AUTH_REJECTED: HTTP 401/);
  assert.match(sttSource, /STT_ACCESS_DENIED: HTTP 403/);
  assert.match(sttSource, /STT_RATE_LIMIT: HTTP 429/);
  assert.doesNotMatch(sttSource, /redactSecrets\(textBody\)/, "STT provider error bodies are not surfaced");

  const providerIds = ["openrouter", "custom.slot1", "custom.slot2", "opencode"];
  const providerOutcomes = [
    [401, "key_invalid"], [403, "access_denied"], [429, "rate_limited"],
    [404, "endpoint_unavailable"], [503, "upstream_error"],
  ];
  for (const providerId of providerIds.slice(2)) {
    for (const [code, expected] of providerOutcomes) {
      await assert.rejects(
        () => customProvider.fetchCustomProviderModels(
          { baseUrl: "https://provider.invalid/v1", providerId },
          async (actualProvider) => {
            assert.equal(actualProvider, providerId);
            return response(code, "SYNTHETIC_PROVIDER_ERROR_BODY", code === 429 ? { "retry-after": "7" } : {});
          },
        ),
        (error) => error.probeStatus === expected && (code !== 429 || error.retryAfterMs === 7_000),
        `${providerId} HTTP ${code} classification`,
      );
    }
    const models = await customProvider.fetchCustomProviderModels(
      { baseUrl: "https://provider.invalid/v1", providerId },
      async (actualProvider) => {
        assert.equal(actualProvider, providerId);
        return response(200, JSON.stringify({ data: [{ id: "chat-model" }] }));
      },
    );
    assert.equal(models[0].id, "chat-model");
  }

  const chat403 = await customProvider.probeCustomProviderChat(
    { baseUrl: "https://provider.invalid/v1", providerId: "custom.slot2", modelId: "chat-model" },
    async () => response(403, "SYNTHETIC_PROVIDER_ERROR_BODY"),
  );
  assert.equal(chat403.status, "access_denied");
  const chat404 = await customProvider.probeCustomProviderChat(
    { baseUrl: "https://provider.invalid/v1", providerId: "opencode", modelId: "chat-model" },
    async () => response(404, "SYNTHETIC_PROVIDER_ERROR_BODY"),
  );
  assert.equal(chat404.status, "model_unavailable");
  const stalledChat = await customProvider.probeCustomProviderChat(
    { baseUrl: "https://provider.invalid/v1", providerId: "custom.slot2", modelId: "chat-model" },
    async () => new Promise(() => {}),
    15,
  );
  assert.equal(stalledChat.status, "timeout", "Custom2 chat checks do not hang when transport ignores AbortSignal");
  const chatController = new AbortController();
  let chatStartedResolve;
  const chatStarted = new Promise((resolve) => { chatStartedResolve = resolve; });
  const cancelledChat = customProvider.probeCustomProviderChat(
    { baseUrl: "https://provider.invalid/v1", providerId: "opencode", modelId: "chat-model", signal: chatController.signal },
    async (_provider, _route, _path, init) => {
      chatStartedResolve();
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
    1_000,
  );
  await chatStarted;
  chatController.abort();
  await assert.rejects(cancelledChat, /ABORTED/, "explicit custom chat probe cancellation is distinguishable");
  assert.equal((await customProvider.probeCustomProviderChat(
    { baseUrl: "https://provider.invalid/v1", providerId: "custom.slot1", modelId: "chat-model" },
    async () => response(200, ""),
  )).status, "request_success");
  await assert.rejects(
    () => customProvider.fetchCustomProviderModels({ baseUrl: "https://provider.invalid/v1", providerId: "custom.slot1" }, async () => { throw new TypeError("Failed to fetch"); }),
    (error) => error.probeStatus === "network_error",
  );
  await assert.rejects(
    () => customProvider.fetchCustomProviderModels({ baseUrl: "https://provider.invalid/v1", providerId: "custom.slot1" }, async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }),
    (error) => error.probeStatus === "timeout",
  );

  const locales = fs.readFileSync(path.join(root, "lib/i18n.ts"), "utf8");
  for (const key of ["providerCheckCredentialAccepted", "providerCheckAccessDenied", "providerCheckNoChatModels", "providerCheckRateLimited", "providerCheckDailyQuota", "providerCheckModelUnavailable", "providerCheckEndpointUnavailable", "providerCheckSttUnavailable", "providerCheckUpstreamError", "providerCheckNetworkError", "providerCheckTimeout", "providerCheckRequestSuccess", "providerCheckRequestError", "apiKeySavedPlaceholder", "apiKeyDraftNotSaved"]) {
    const definitions = locales.match(new RegExp(`^\\s+${key}:`, "gm")) || [];
    assert.equal(definitions.length, 3, `${key} must be localized in Ukrainian, Russian and English`);
  }

  const settings = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");
  assert.match(settings, /status: ProviderProbeStatus; valid: boolean \| null/);
  assert.match(settings, /providerProbeMessageKey\(result\.status\)/);
  assert.match(settings, /providerProbeTone\(apiKeyCheckResult\.status\)/);
  assert.doesNotMatch(settings, /result\.valid \? t\("apiKeyValid"\) : t\("apiKeyInvalid"\)/);
  const handler = settings.slice(settings.indexOf("const handleCheckApiKey"), settings.indexOf("const handleSaveSystemPrompt"));
  assert.match(handler, /const key = apiKeyDraft\.trim\(\)/, "the validator must use the current typed draft");
  assert.match(handler, /key \? await validateOpenRouterApiKey\(key\) : await validateOpenRouterApiKey\(\)/, "the typed draft must be validated through the transient candidate-key path");
  assert.doesNotMatch(handler, /setOnlineApiKey|setApiKeyDraft\(\s*["']\s*["']\s*\)/, "checking must neither install a key nor clear the user's draft");
  assert.match(settings, /savingApiKey/);
  assert.match(handler, /setCheckingApiKey\(true\)/, "provider validation busy state begins before the network probe");

  const customDialog = fs.readFileSync(path.join(root, "components/CustomProviderDialog.tsx"), "utf8");
  const openCodeDialog = fs.readFileSync(path.join(root, "components/OpenCodeModelsDialog.tsx"), "utf8");
  for (const [name, ui] of [["Custom", customDialog], ["OpenCode", openCodeDialog]]) {
    assert.match(ui, /classifyProviderProbeError/);
    assert.match(ui, /providerCheckCredentialAccepted/);
    assert.match(ui, /providerProbeTone\(keyCheckResult\.status\)/);
    assert.doesNotMatch(ui, /apiKeyInvalid[^\n]*redactSecrets|redactSecrets\([^\n]*e\.message/, `${name} status UI must not surface raw provider response details`);
    assert.match(ui, /operationLock/);
  }
  assert.match(customDialog, /providerProbeMessageKey\(probe\.status\)/, "key acceptance is separate from selected chat-model access");
  const useLlm = fs.readFileSync(path.join(root, "hooks/useLLM.ts"), "utf8");

  assert.ok(logEntries.some((entry) => entry.message.includes("daily_quota")));
  assert.ok(logEntries.every((entry) => !/free-models-per-day|Unauthorized|Forbidden|Service unavailable/i.test(entry.message)), "logs contain status metadata only, not response bodies");
  assert.ok(logEntries.every((entry) => !entry.message.includes("SYNTHETIC_PROVIDER_ERROR_BODY")), "provider bodies must not enter status logs");
  console.log("AIB_PROVIDER_PROBE_STATUS_SELFTEST_OK providers=4 custom_slots=2 statuses=200,401,403-access,429,404,5xx,network,timeout dailyQuotaRetries=0 retry_after=7s i18n=3 savedKeyMutation=none");
}

main().catch((error) => { console.error(error?.stack || String(error)); process.exit(1); });
