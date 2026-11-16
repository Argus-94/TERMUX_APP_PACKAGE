import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { typescript as ts } from "./test-helpers/load-typescript.mjs";

const db = new Map();
let secureKey = "synthetic-existing-key";
let saveFails = false;
let readFails = false;
const secureCalls = [];
const storage = {
  getItem: async key => { if (readFails) throw new Error("fixture-storage-failure"); return db.get(key) ?? null; },
  setItem: async (key, value) => { db.set(key, value); },
};
const auth = {
  hasProviderCredential: async provider => { assert.equal(provider, "manus"); return Boolean(secureKey); },
  saveProviderCredential: async (provider, value) => {
    assert.equal(provider, "manus"); secureCalls.push({ provider, removed: value === "" });
    if (saveFails) return false;
    secureKey = value; return true;
  },
};
function compile(relative, mocks) {
  const filename = path.resolve(relative);
  const mod = new Module(filename); mod.filename = filename;
  mod.require = name => { if (name in mocks) return mocks[name]; throw new Error("Unexpected test dependency: " + name); };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
// Minimal hook scheduler: runtime-tests this hook's state/ref/effect/queue logic,
// not a React Native render, device SecureStore or the real React renderer.
function renderer() {
  const slots = []; let cursor = 0; const effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef: initial => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (fn, deps) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { slots[i] = { deps }; effects.push(fn); } },
  };
  const { useManusSettings } = compile("hooks/useManusSettings.ts", {
    react,
    "@react-native-async-storage/async-storage": { __esModule: true, default: storage },
    "../core/enhancements/auth/productionProviderTransport": auth,
  });
  return { render: () => { cursor = 0; const result = useManusSettings(); while (effects.length) effects.shift()(); return result; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
let render = renderer();
assert.equal(render.render().manus.loaded, false);
await settle();
let settings = render.render();
assert.equal(settings.manus.loaded, true); assert.equal(settings.manus.hasApiKey, true);
const firstBinding = settings.manus.binding;
assert.equal(JSON.parse(db.get("aibuilder.manus.settings.v1")).binding, firstBinding, "first-load binding is persisted before enabling provider");
assert.equal(await settings.setManusProfile("max"), true);
settings = render.render(); assert.equal(settings.manus.binding, firstBinding);
assert.equal(settings.manus.profile, "max");
assert.equal(await settings.saveManusKey("synthetic-replacement-key"), true);
settings = render.render(); const newBinding = settings.manus.binding;
assert.notEqual(newBinding, firstBinding); assert.equal(settings.manus.hasApiKey, true);
assert.equal(JSON.stringify([...db.entries()]).includes("synthetic-"), false, "keys never enter ordinary metadata storage");
// Methods captured before queued mutations must still use the authoritative current ref.
assert.deepEqual(await Promise.all([settings.setManusProfile("max-high"), settings.saveManusKey("synthetic-next-key"), settings.setManusProfile("lite")]), [true, true, true]);
settings = render.render(); assert.equal(settings.manus.profile, "lite");
assert.notEqual(settings.manus.binding, newBinding);
assert.equal(JSON.parse(db.get("aibuilder.manus.settings.v1")).binding, settings.manus.binding);
const beforeFailure = settings.manus.binding;
saveFails = true;
assert.equal(await settings.saveManusKey("synthetic-failing-key"), false);
settings = render.render(); assert.equal(settings.manus.hasApiKey, false); assert.notEqual(settings.manus.binding, beforeFailure);
saveFails = false;
assert.equal(await settings.removeManusKey(), true);
settings = render.render(); assert.equal(settings.manus.hasApiKey, false); assert.equal(secureKey, "");
assert.equal(secureCalls.at(-1).removed, true);
// Restart preserves the namespace; it does not invent a new account binding.
const restartBinding = settings.manus.binding;
render = renderer(); render.render(); await settle(); settings = render.render();
assert.equal(settings.manus.binding, restartBinding);
readFails = true;
const broken = renderer(); broken.render(); await settle(); assert.equal(broken.render().manus.loaded, false);
readFails = false;

const taskStore = compile("lib/manus-task-store.ts", { "@react-native-async-storage/async-storage": { __esModule: true, default: storage } });
const key = taskStore.manusTaskStorageKey("binding", "chat", 123, "epoch");
assert.notEqual(key, taskStore.manusTaskStorageKey("another-binding", "chat", 123, "epoch"));
await taskStore.saveManusTask(key, { taskId: "task", pending: true, lastEventId: "e1" });
assert.deepEqual(await taskStore.loadManusTask(key), { taskId: "task", pending: true, lastEventId: "e1" });
assert.equal(await taskStore.loadManusTask(key + ".missing"), undefined);
readFails = true; await assert.rejects(taskStore.loadManusTask(key), /fixture-storage-failure/); readFails = false;
db.set(key, '{"taskId":42}'); await assert.rejects(taskStore.loadManusTask(key), /CLOUD_TASK_STATE_INVALID/);
console.log("AIB_V482_MANUS_SETTINGS_SELFTEST_OK runtime=mock-hook-scheduler startup=durable binding=rotate+restart concurrency=serialized removal=verified storage-failures=closed NO_DEVICE_PROOF");
