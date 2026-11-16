#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { typescript } from "./test-helpers/load-typescript.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const currentProductFiles = [
  "app/index.tsx", "app/settings.tsx", "hooks/useLLM.ts",
  "components/CustomProviderDialog.tsx", "components/OpenCodeModelsDialog.tsx", "components/ReadinessBar.tsx",
  "lib/audio-transcribe.ts", "lib/engine-errors.ts", "lib/model-mode.ts", "lib/provider-utils.ts", "lib/readiness.ts",
  "core/RuntimeFacade.ts", "core/container/ProotCommandBuilder.ts",
  "core/enhancements/auth/AgentProviderRoutes.ts", "core/enhancements/auth/productionProviderTransport.ts",
  "native/aib-credential-proxy/AibCredentialHttpProxyServer.java",
];
for (const rel of currentProductFiles) {
  assert.doesNotMatch(read(rel), /deepseek|api\.deepseek\.com|DEEPSEEK/i, `${rel} must not expose retired provider behavior`);
}
assert.ok(!fs.existsSync(path.join(root, "lib/deepseek-model.ts")), "retired model engine source is removed");
assert.ok(!fs.existsSync(path.join(root, "components/DeepSeekModelsDialog.tsx")), "retired settings dialog source is removed");

const locales = read("lib/i18n.ts");
for (const locale of ["uk", "ru", "en"]) {
  const start = locales.indexOf(`  ${locale}: {`);
  assert.ok(start >= 0, `missing ${locale} translation catalog`);
  const end = locales.indexOf("\n  },", start);
  assert.ok(end > start, `unterminated ${locale} translation catalog`);
  assert.doesNotMatch(locales.slice(start, end), /deepseek|api\.deepseek|platform\.deepseek/i, `${locale} locale must not offer retired provider copy`);
}
assert.match(locales, /vision\/images/);
assert.match(locales, /vision\/image support/);

const routes = read("core/enhancements/auth/AgentProviderRoutes.ts");
assert.match(routes, /openrouter: Object\.freeze/);
assert.doesNotMatch(routes, /deepseek|api\.deepseek\.com/i);
const transport = read("core/enhancements/auth/productionProviderTransport.ts");
assert.match(transport, /ACTIVE_PROVIDER_IDS/);
assert.match(transport, /PROVIDER_NOT_SUPPORTED/);
assert.match(transport, /if \(!isActiveProvider\(provider\)\) return false/);
const native = read("native/aib-credential-proxy/AibCredentialHttpProxyServer.java");
for (const id of ["openrouter", "opencode", "custom.slot1", "custom.slot2"]) assert.ok(native.includes(`equals("${id}")`), `native proxy must preserve ${id}`);
assert.doesNotMatch(native, /deepseek|api\.deepseek\.com|DEEPSEEK/i);
const facade = read("core/RuntimeFacade.ts");
assert.match(facade, /ACTIVE_AGENT_CREDENTIAL_PROVIDERS = new Set\(\["openrouter", "opencode", "custom\.slot1", "custom\.slot2"\]\)/);
assert.match(facade, /if \(!isActiveAgentCredentialProvider\(provider\)\) throw new Error\("PROVIDER_NOT_SUPPORTED"\)/, "public RuntimeFacade credential writes fail closed");
assert.match(facade, /isActiveAgentCredentialProvider\(provider\) \? authStore\.hasKey\(provider\) : Promise\.resolve\(false\)/, "unsupported provider credential reads do not access SecureStore");

const settings = read("hooks/useAppSettings.ts");
assert.doesNotMatch(settings, /deepseek|api\.deepseek\.com|DEEPSEEK/i, "app settings do not read or use the retired field");
assert.match(settings, /stripPersistedCredentialFields\(value, sanitizeProviderExtraHeadersJson\)/);
const scrubSource = read("lib/persisted-settings-scrub.ts");
assert.match(scrubSource, /key\.toLowerCase\(\) === "deepseek"\) continue/, "deprecated settings data is preserved opaque without inspecting its value");
const scrubModule = { exports: {} };
const scrubJs = typescript.transpileModule(scrubSource, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  fileName: "persisted-settings-scrub.ts",
}).outputText;
new Function("exports", "module", scrubJs)(scrubModule.exports, scrubModule);
const retiredLegacyValue = { apiKey: "synthetic-retired-legacy-key", nested: { authorization: "legacy-value-remains-opaque" } };
const scrubbedSettings = scrubModule.exports.stripPersistedCredentialFields({
  deepSeek: retiredLegacyValue,
  customProvider: { apiKey: "synthetic-active-plaintext-key" },
}, (raw) => raw);
assert.equal(scrubbedSettings.deepSeek, retiredLegacyValue, "retired field and object identity remain unchanged");
assert.equal(JSON.stringify(scrubbedSettings).includes("synthetic-retired-legacy-key"), true, "legacy saved value is preserved in settings storage");
assert.deepEqual(scrubbedSettings.customProvider, {}, "active legacy plaintext provider fields still get scrubbed");
const modeModule = { exports: {} };
const modeJs = typescript.transpileModule(read("lib/model-mode.ts"), {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  fileName: "model-mode.ts",
}).outputText;
new Function("exports", "module", modeJs)(modeModule.exports, modeModule);
for (const mode of ["local", "online", "custom", "opencode"]) assert.equal(modeModule.exports.normalizePersistedModelMode(mode), mode);
assert.equal(modeModule.exports.normalizePersistedModelMode(["deep", "seek"].join("")), "local", "a persisted retired mode cannot activate provider routing");
assert.match(settings, /normalizePersistedModelMode\(persisted\.mode\)/, "unknown retired persisted modes fail closed to Local");
assert.doesNotMatch(settings, /migrateProviderCredential\(\s*["']deepseek|migrateInlineProviderCredential\(\s*["']deepseek|saveProviderCredential\(\s*["']deepseek/i);
assert.match(settings, /legacyMigrated && legacyKeys\.length\) custom1Configured = await migrateProviderCredential\("custom\.slot1"\)/, "successor pending-to-canonical fix remains for slot 1");
assert.match(settings, /legacyMigrated && legacyKeys\.length\) custom2Configured = await migrateProviderCredential\("custom\.slot2"\)/, "successor pending-to-canonical fix remains for slot 2");
assert.match(settings, /legacyMigrated && parsed\.apiKey\?\.trim\(\)\) openCodeConfigured = await migrateProviderCredential\("opencode"\)/, "successor pending-to-canonical fix remains for OpenCode");

const text = read("lib/provider-utils.ts");
assert.doesNotMatch(text, /DeepSeek/i, "current model guidance does not suggest the retired provider");
assert.match(text, /Llama Instruct/);
console.log("AIB_PROVIDER_RETIREMENT_SELFTEST_OK active_routes=4 locales=uk,ru,en legacy_credentials=untouched mode=fail-closed");
