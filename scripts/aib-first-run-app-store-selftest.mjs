#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFirstRunAppStore, createFirstRunPromptDeferralStore } from "../lib/first-run-app-store.ts";
import { FirstRunOrchestrator } from "../core/enhancements/onboarding/FirstRunOrchestrator.ts";
import { BootstrapPipeline } from "../core/runtime/BootstrapPipeline.ts";
import { recommendSmartDefaults } from "../core/enhancements/onboarding/SmartDefaults.ts";

const sourceRoot = path.resolve(new URL("..", import.meta.url).pathname);
const startupUi = fs.readFileSync(path.join(sourceRoot, "app/_layout.tsx"), "utf8");
const runtimeUi = fs.readFileSync(path.join(sourceRoot, "app/runtime.tsx"), "utf8");
assert.match(startupUi, /Saved-state check/);
assert.match(startupUi, /const startAction = status\.error && status\.error\.code !== "STATE_CORRUPT"/);
assert.match(startupUi, /status\.error\?\.code === "LEGACY_STATE_UNAVAILABLE"[\s\S]*?Open Android settings/);
assert.match(startupUi, /firstRunPromptDeferralStore\.isDeferred\(FIRST_RUN_PROMPT_VERSION\)/);
assert.match(startupUi, /firstRunPromptDeferralStore\.defer\(FIRST_RUN_PROMPT_VERSION\)/);
assert.match(startupUi, /firstRunPromptDeferralStore\.clear\(\)/);
assert.match(runtimeUi, /if \(check\.error && check\.error\.code !== "STATE_CORRUPT"\)[\s\S]*?return undefined;/);
assert.match(runtimeUi, /firstRunPromptDeferralStore\.clear\(\)[\s\S]{0,140}onFirstRunSetup\(\)/, "explicit Runtime retry clears a prior Later choice");
const permissionUi = fs.readFileSync(path.join(sourceRoot, "app/permissions-onboarding.tsx"), "utf8");
assert.match(permissionUi, /firstRunPromptDeferralStore\.defer\(FIRST_RUN_PROMPT_VERSION\)/, "continuing without optional access defers the startup prompt without editing setup state");

const KEY = "aibuilder.first-run-state.v1";
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async getItem(key) { return values.has(key) ? values.get(key) : null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  };
}
function makeOrchestrator(store, calls = { stages: 0 }) {
  const pipeline = new BootstrapPipeline({ async read() { return null; }, async write() {} }, async (id) => {
    calls.stages++;
    return { ok: true, fingerprint: `fixture:${id}` };
  });
  const defaults = recommendSmartDefaults({ backends: [{ id: "termux-native", healthy: true, capabilities: ["termux-native-execution"] }], online: true });
  return new FirstRunOrchestrator(store, pipeline, {
    async diagnostics() { return { overall: "ready", generatedAt: 1, entries: [], humanReadable: "ready", json: "{}" }; },
    async safeDefaults() { return defaults; },
  });
}

// A genuinely absent app and legacy marker is distinguishable from a failed read.
const freshStorage = memoryStorage();
const freshStore = createFirstRunAppStore(freshStorage, { async read() { return null; } });
assert.equal(await freshStore.read(), null);
const freshOrchestrator = makeOrchestrator(freshStore);
assert.equal((await freshOrchestrator.inspect("3.0.0")).kind, "first-run");
const first = await freshOrchestrator.run({ targetVersion: "3.0.0" });
assert.equal(first.error, undefined);
assert.equal((await freshOrchestrator.inspect("3.0.0")).required, false);

// Deferring the startup prompt is durable, version-scoped, and independent of completed setup state.
const promptStore = createFirstRunPromptDeferralStore(freshStorage);
assert.equal(await promptStore.isDeferred("3.0.0"), false);
const completedSetupRaw = await freshStorage.getItem(KEY);
await promptStore.defer("3.0.0");
const nextSessionPromptStore = createFirstRunPromptDeferralStore(freshStorage);
assert.equal(await nextSessionPromptStore.isDeferred("3.0.0"), true, "Later persists across store instances for the same app version");
assert.equal(await nextSessionPromptStore.isDeferred("3.0.1"), false, "a later app version may surface setup again");
assert.equal(await freshStorage.getItem(KEY), completedSetupRaw, "permission/prompt deferral never edits the setup marker");
await nextSessionPromptStore.clear();
assert.equal(await nextSessionPromptStore.isDeferred("3.0.0"), false, "explicit setup action clears the deferral");

const PROMPT_KEY = "aibuilder.first-run-prompt.v1";
const previousPrompt = JSON.stringify({ version: 1, targetVersion: "3.0.0", deferred: true, updatedAt: 1 });
const failingPromptStorage = memoryStorage({ [PROMPT_KEY]: previousPrompt });
const baseSetItem = failingPromptStorage.setItem;
let failPromptWrite = true;
failingPromptStorage.setItem = async (key, value) => {
  if (key === PROMPT_KEY && failPromptWrite) { failPromptWrite = false; throw new Error("synthetic prompt-store write failure"); }
  return baseSetItem(key, value);
};
const failingPromptStore = createFirstRunPromptDeferralStore(failingPromptStorage);
await assert.rejects(() => failingPromptStore.defer("3.0.1"), /synthetic prompt-store write failure/);
assert.equal(await failingPromptStorage.getItem(PROMPT_KEY), previousPrompt, "failed deferral write preserves the earlier verified marker");

// A second process/session reads the completed app-private marker without consulting Termux.
let legacyReads = 0;
const secondLaunchStore = createFirstRunAppStore(freshStorage, { async read() { legacyReads++; throw new Error("RUN_COMMAND_PERMISSION_MISSING"); } });
const secondLaunch = makeOrchestrator(secondLaunchStore);
assert.equal((await secondLaunch.inspect("3.0.0")).required, false);
assert.equal(legacyReads, 0, "a migrated/app-private marker does not depend on stale Termux permission");
assert.equal((await secondLaunch.run({ targetVersion: "3.0.0" })).error, undefined);

// With no app-private marker, denied legacy IPC is not misclassified as a first install or absence.
const inaccessibleStorage = memoryStorage();
const inaccessibleStore = createFirstRunAppStore(inaccessibleStorage, { async read() { throw new Error("RUN_COMMAND_PERMISSION_MISSING"); } });
const inaccessible = makeOrchestrator(inaccessibleStore);
const unavailable = await inaccessible.inspect("3.0.0");
assert.equal(unavailable.required, true);
assert.equal(unavailable.kind, "repair");
assert.equal(unavailable.error?.code, "LEGACY_STATE_UNAVAILABLE");
const blockedRun = await inaccessible.run({ targetVersion: "3.0.0" });
assert.equal(blockedRun.error?.code, "LEGACY_STATE_UNAVAILABLE");
assert.equal(inaccessibleStorage.values.has(KEY), false, "bridge denial neither initializes nor overwrites metadata");

// A legacy completed marker migrates with exact bytes and is verified on read-back.
const completedRaw = JSON.stringify({ version: 1, targetVersion: "3.0.0", kind: "first-run", stages: { diagnostics: "ok", bootstrap: "ok", "safe-defaults": "ok" }, updatedAt: 123 });
const migratedStorage = memoryStorage();
let migrationReads = 0;
const migratedStore = createFirstRunAppStore(migratedStorage, { async read() { migrationReads++; return completedRaw; } });
assert.equal(await migratedStore.read(), completedRaw);
assert.equal(await migratedStorage.getItem(KEY), completedRaw);
const nextStore = createFirstRunAppStore(migratedStorage, { async read() { migrationReads++; throw new Error("stale RUN_COMMAND"); } });
assert.equal(await nextStore.read(), completedRaw);
assert.equal(migrationReads, 1, "successful legacy migration is not repeated");

// Corrupt data is retained under a recovery key before a valid resumable marker replaces it.
const corruptRaw = "{not-json";
const corruptStorage = memoryStorage({ [KEY]: corruptRaw });
const corruptStore = createFirstRunAppStore(corruptStorage, { async read() { throw new Error("must not reach legacy"); } });
const corruptOrchestrator = makeOrchestrator(corruptStore);
assert.equal((await corruptOrchestrator.inspect("3.0.0")).error?.code, "STATE_CORRUPT");
const recovered = await corruptOrchestrator.run({ targetVersion: "3.0.0" });
assert.equal(recovered.error, undefined);
assert.equal([...corruptStorage.values.values()].includes(corruptRaw), true, "original malformed bytes remain available in recovery storage");
assert.equal(JSON.parse(await corruptStorage.getItem(KEY)).stages["safe-defaults"], "ok");

// A future schema is never overwritten by this older implementation.
const futureRaw = JSON.stringify({ version: 2, opaque: "keep-me" });
const futureStorage = memoryStorage({ [KEY]: futureRaw });
const futureStore = createFirstRunAppStore(futureStorage, { async read() { throw new Error("must not reach legacy"); } });
const futureOrchestrator = makeOrchestrator(futureStore);
assert.equal((await futureOrchestrator.inspect("3.0.0")).error?.code, "STATE_FUTURE_VERSION");
assert.equal((await futureOrchestrator.run({ targetVersion: "3.0.0" })).error?.code, "STATE_FUTURE_VERSION");
assert.equal(await futureStorage.getItem(KEY), futureRaw, "future-version data remains byte-for-byte unchanged");

console.log("AIB_FIRST_RUN_APP_STORE_SELFTEST_OK fresh=once=second-launch=legacy-migration=stale-RUN_COMMAND=missing-vs-unavailable=corrupt-quarantine=future-preserved");
