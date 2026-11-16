import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTerminalSessionAppStore } from "../lib/terminal-session-app-store.ts";

const values = new Map();
const calls = [];
const storage = {
  async getItem(key) { calls.push(["get", key]); return values.get(key) ?? null; },
  async setItem(key, value) { calls.push(["set", key]); values.set(key, value); },
};
const store = createTerminalSessionAppStore(storage);
const key = "aib.terminal.sessions.v1";
assert.equal(await store.get(key), null);
const snapshot = JSON.stringify([{ id: "s1", projectId: "demo", projectRoot: "/storage/emulated/0/AIBuilderTermux/projects/demo-app-1700000000000-abc123", cwd: "/storage/emulated/0/AIBuilderTermux/projects/demo-app-1700000000000-abc123", env: {}, scrollback: "", state: "saved", updatedAt: 1 }]);
await store.set(key, snapshot);
assert.equal(await store.get(key), snapshot);
assert.deepEqual(calls, [["get", key], ["set", key], ["get", key]]);

const failing = createTerminalSessionAppStore({
  getItem: async () => null,
  setItem: async () => { throw new Error("APP_PRIVATE_STORAGE_DENIED"); },
});
await assert.rejects(failing.set(key, snapshot), /APP_PRIVATE_STORAGE_DENIED/);

const runtime = await readFile(new URL("../core/RuntimeFacade.ts", import.meta.url), "utf8");
const appFacade = await readFile(new URL("../lib/runtime-facade.ts", import.meta.url), "utf8");
const sessionManager = await readFile(new URL("../core/enhancements/terminal/TerminalSessionManager.ts", import.meta.url), "utf8");
assert.match(runtime, /terminalSessionStore\?: TerminalPreferenceStore/);
assert.match(runtime, /options\.terminalSessionStore \?\? createVolatileTerminalSessionStore\(\)/);
assert.doesNotMatch(runtime, /terminal-sessions\.json/, "session snapshots must not fall back to shared HOME metadata");
assert.match(appFacade, /createTerminalSessionAppStore\(/);
assert.match(appFacade, /getItem: \(key\) => AsyncStorage\.getItem\(key\)/);
assert.match(appFacade, /setItem: \(key, value\) => AsyncStorage\.setItem\(key, value\)/);
assert.match(appFacade, /terminalSessionStore,/);
assert.match(sessionManager, /const STORAGE_KEY = "aib\.terminal\.sessions\.v1"/);
console.log("aib-v499-private-terminal-session-store-selftest: PASS (app-private AsyncStorage; no shared-HOME fallback; write errors propagate)");
