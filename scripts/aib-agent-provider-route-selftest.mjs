#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveTaskProviderRoute } from "../core/enhancements/auth/AgentProviderRoutes.ts";

const values = new Map();
const requested = [];
const storage = {
  async getItem(key) {
    requested.push(key);
    return values.get(key) ?? null;
  },
};

const retiredProvider = ["deep", "seek"].join("");
const beforeRetiredLookup = requested.length;
assert.equal(await resolveTaskProviderRoute(retiredProvider, storage), undefined);
assert.equal(requested.length, beforeRetiredLookup, "retired provider ID is rejected before settings reads");
values.set("aibuilder.custom.provider.v1", JSON.stringify({
  name: "Anthropic-compatible custom gateway",
  baseUrl: "https://api.anthropic.example/v1",
  modelId: "claude-test",
  apiKey: "synthetic-secret-must-not-be-returned",
}));
const slot1 = await resolveTaskProviderRoute("custom.slot1", storage);
assert.deepEqual(slot1, { baseUrl: "https://api.anthropic.example/v1", authHeader: "x-api-key", authScheme: "raw" });
assert.equal(JSON.stringify(slot1).includes("synthetic-secret"), false, "route metadata never contains credential fields");

values.set("aibuilder.custom.provider2.v1", JSON.stringify({
  name: "Distinct slot two",
  baseUrl: "https://slot-two.example/v1",
  modelId: "slot-two-model",
}));
const slot2Dedicated = await resolveTaskProviderRoute("custom.slot2", storage);
assert.deepEqual(slot2Dedicated, { baseUrl: "https://slot-two.example/v1", authHeader: "authorization", authScheme: "Bearer" },
  "slot 2 resolves its own dedicated route even when slot 1 is also configured");
assert.deepEqual(await resolveTaskProviderRoute("custom.slot1", storage), slot1,
  "resolving slot 2 never changes slot 1 destination");

values.set("aibuilder.settings.v1", JSON.stringify({
  customProvider2: { baseUrl: "https://gateway.example/v1", apiKey: "legacy-secret-must-not-be-returned" },
}));
values.delete("aibuilder.custom.provider2.v1");
const slot2 = await resolveTaskProviderRoute("custom.slot2", storage);
assert.deepEqual(slot2, { baseUrl: "https://gateway.example/v1", authHeader: "authorization", authScheme: "Bearer" });
assert.equal(JSON.stringify(slot2).includes("legacy-secret"), false);

values.set("aibuilder.opencode.config.v1", JSON.stringify({ baseUrl: "https://opencode.example/zen/v1", modelId: "model", apiKey: "not-read" }));
assert.deepEqual(await resolveTaskProviderRoute("opencode", storage), { baseUrl: "https://opencode.example/zen/v1", authHeader: "authorization", authScheme: "Bearer" });
values.delete("aibuilder.opencode.config.v1");
values.delete("aibuilder.settings.v1");
assert.deepEqual(await resolveTaskProviderRoute("opencode", storage), { baseUrl: "https://opencode.ai/zen/v1" }, "unconfigured OpenCode uses the documented default route");

assert.deepEqual(await resolveTaskProviderRoute("openrouter", storage), { baseUrl: "https://openrouter.ai/api/v1" });
assert.equal(await resolveTaskProviderRoute("unsupported-provider", storage), undefined);

values.set("aibuilder.custom.provider.v1", JSON.stringify({ baseUrl: "http://attacker.example/v1" }));
assert.equal(await resolveTaskProviderRoute("custom.slot1", storage), undefined, "non-loopback HTTP routes fail closed");
values.set("aibuilder.custom.provider.v1", JSON.stringify({ baseUrl: "https://user:password@provider.example/v1" }));
assert.equal(await resolveTaskProviderRoute("custom.slot1", storage), undefined, "embedded URL credentials fail closed");
values.set("aibuilder.custom.provider.v1", JSON.stringify({ baseUrl: "https://provider.example/v1?token=inline" }));
assert.equal(await resolveTaskProviderRoute("custom.slot1", storage), undefined, "query-string routes fail closed");
assert.equal(await resolveTaskProviderRoute("custom.slot1", { getItem: async () => { throw new Error("storage unavailable"); } }), undefined, "storage errors do not fall back to unsafe destinations");
assert.ok(requested.every((key) => !/secure|credential|api.?key/i.test(key)), "route resolution reads only non-secret settings keys");

const settingsHook = fs.readFileSync(new URL("../hooks/useAppSettings.ts", import.meta.url), "utf8");
assert.match(settingsHook, /const CUSTOM2_PROVIDER_STORAGE_KEY = "aibuilder\.custom\.provider2\.v1"/);
const slot1WriteStart = settingsHook.indexOf("persistAsyncStorageItem(CUSTOM_PROVIDER_STORAGE_KEY, JSON.stringify({");
const slot2WriteStart = settingsHook.indexOf("persistAsyncStorageItem(CUSTOM2_PROVIDER_STORAGE_KEY, JSON.stringify({", slot1WriteStart);
assert.ok(slot1WriteStart >= 0 && slot2WriteStart > slot1WriteStart, "each dedicated slot config is written independently");
const slot1Write = settingsHook.slice(slot1WriteStart, slot2WriteStart);
const opencodeWrite = settingsHook.indexOf('persistAsyncStorageItem("aibuilder.opencode.config.v1"', slot2WriteStart);
assert.ok(opencodeWrite > slot2WriteStart, "slot 2 write is bounded before unrelated provider persistence");
const slot2Write = settingsHook.slice(slot2WriteStart, opencodeWrite);
assert.match(slot1Write, /name: customProvider1\.name[\s\S]*baseUrl: customProvider1\.baseUrl[\s\S]*modelId: customProvider1\.modelId/);
assert.doesNotMatch(slot1Write, /customProvider\./, "slot 1 dedicated route never uses the active-slot alias");
assert.match(slot2Write, /name: customProvider2\.name[\s\S]*baseUrl: customProvider2\.baseUrl[\s\S]*modelId: customProvider2\.modelId/);
assert.doesNotMatch(slot2Write, /customProvider\./, "slot 2 dedicated route never uses the active-slot alias");

const facade = fs.readFileSync(new URL("../core/RuntimeFacade.ts", import.meta.url), "utf8");
assert.match(facade, /resolveAgentProviderRoute\(provider\)/, "agent task startup uses configured provider routing");
assert.match(facade, /credentialProxy\.start\(provider, route\)/, "resolved route is passed through CredentialProxy validation");
console.log("AIB_AGENT_PROVIDER_ROUTE_SELFTEST_OK providers=4 unsafe=blocked secret_values=not_read fallback=legacy-safe slot-routes=independent retired=unavailable");
