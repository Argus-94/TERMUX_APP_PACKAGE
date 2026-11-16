import { loadBalanceDiagnostic } from './test-helpers/load-balance-diagnostic.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { typescript as ts } from "./test-helpers/load-typescript.mjs";

function compile(relative, mocks) {
  const filename = path.resolve(relative), mod = new Module(filename);
  mod.filename = filename;
  mod.require = name => { if (Object.hasOwn(mocks, name)) return mocks[name]; throw new Error("Unexpected test dependency: " + name); };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const envelope = (total = 31) => ({ ok: true, data: { total_credits: total, current_period_end: 1_900_000_000, next_refresh_time: 1_800_000_000, refresh_interval: "daily", private_unknown: "not-for-ui" } });
const parsed = compile("lib/manus-credits.ts", {});
const requests = [];
let handler = () => Promise.resolve(envelope());
const apiStub = { getManusAvailableCredits: signal => { requests.push({ signal }); return handler(); } };
function fixture() {
  const slots = []; let cursor = 0, effects = [], mounted = true;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], next => { if (mounted) slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { slots[i] = { deps, cleanup: slots[i]?.cleanup }; effects.push({ i, fn }); } },
  };
  const { useManusCredits } = compile("hooks/useManusCredits.ts", { react, "../lib/manus-api": apiStub, "../lib/manus-credits": parsed });
  let enabled = false, binding = "a";
  const render = (nextEnabled = enabled, nextBinding = binding) => { enabled = nextEnabled; binding = nextBinding; cursor = 0; return useManusCredits(enabled, binding, "en"); };
  const flush = () => { for (const { i, fn } of effects.splice(0)) { slots[i].cleanup?.(); slots[i].cleanup = fn(); } };
  return { render, flush, unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.(); } };
}
const r = fixture();
assert.equal(r.render().loading, false); r.flush(); assert.equal(requests.length, 0);
r.render(true); assert.equal(requests.length, 0, "render must not send requests");
r.flush(); assert.equal(requests.length, 1); assert.equal(r.render().loading, true);
await tick(); let state = r.render();
assert.equal(state.credits.total_credits, 31); assert.equal(typeof state.updatedAt, "number");
assert.equal(Object.hasOwn(state.credits, "private_unknown"), false);
const firstTimestamp = state.updatedAt;
for (let i = 0; i < 3; i++) { r.render(); r.flush(); await tick(); }
assert.equal(requests.length, 1, "no render re-probe, retries or polling");
for (const [failure, pattern] of [
  [new Error("MANUS_UNAUTHORIZED: private response"), /denied.*401\/403/i],
  [new Error("MANUS_FORBIDDEN: private response"), /denied.*401\/403/i],
  [new Error("MANUS_RATE_LIMITED: private response"), /rate limit/i],
  [new Error("MANUS_TIMEOUT: private response"), /timed out/i],
  [new Error("private response"), /connection/i],
  [{ ok: true, data: { total_credits: "private response" } }, /invalid balance/i],
]) {
  handler = () => failure instanceof Error ? Promise.reject(failure) : Promise.resolve(failure);
  const before = requests.length, pending = state.refresh();
  assert.equal(requests.length, before + 1); assert.equal(r.render().loading, true);
  await pending; state = r.render();
  assert.equal(state.loading, false); assert.equal(state.credits.total_credits, 31);
  assert.equal(state.updatedAt, firstTimestamp, "error retains the last successful timestamp");
  assert.match(state.error, pattern); assert.doesNotMatch(state.error, /private response/);
  r.flush(); await tick(); assert.equal(requests.length, before + 1, "failure is never retried automatically");
}
handler = () => Promise.resolve(envelope(-5));
await state.refresh(); state = r.render(); assert.equal(state.error, ""); assert.equal(state.credits.total_credits, -5);
// A single explicit refresh cannot spawn a second concurrent request.
let pendingReply = deferred(); handler = () => pendingReply.promise;
let pending = state.refresh(); const oldSignal = requests.at(-1).signal;
const beforeDuplicate = requests.length; await state.refresh(); assert.equal(requests.length, beforeDuplicate);
assert.equal(r.render(true, "b").credits, undefined, "old account snapshot is hidden immediately on render");
r.flush(); assert.equal(oldSignal.aborted, true);
// Resolve the old response after the new binding has started: token identity rejects it.
pendingReply.resolve(envelope(999)); await pending; await tick();
// The same fixture promise served both accounts; only the current account's result is accepted.
state = r.render(); assert.equal(state.credits.total_credits, 999);
// Separate promises prove an obsolete result cannot overwrite a newer successful account snapshot.
pendingReply = deferred(); handler = () => pendingReply.promise; pending = state.refresh();
const obsolete = pendingReply, obsoleteSignal = requests.at(-1).signal;
const next = deferred(); handler = () => next.promise;
r.render(true, "c"); r.flush(); assert.equal(obsoleteSignal.aborted, true);
next.resolve(envelope(52)); await tick(); assert.equal(r.render().credits.total_credits, 52);
obsolete.resolve(envelope(1000)); await pending; await tick(); state = r.render(); assert.equal(state.credits.total_credits, 52);
// Disable/unmount cancel and suppress late completion.
pendingReply = deferred(); handler = () => pendingReply.promise; pending = state.refresh();
const cancelled = requests.at(-1).signal;
assert.equal(r.render(false).credits, undefined); r.flush(); assert.equal(cancelled.aborted, true);
pendingReply.resolve(envelope(777)); await pending; await tick(); assert.equal(r.render().credits, undefined);
const other = fixture(), finalReply = deferred(); handler = () => finalReply.promise;
other.render(true); other.flush(); const finalSignal = requests.at(-1).signal;
other.unmount(); assert.equal(finalSignal.aborted, true); finalReply.resolve(envelope(888)); await tick();

// Exercise production HTTP mapping through the mocked secured transport, never a live service.
let response = Response.json(envelope()), captured, transportCalls = 0;
let transport = async (...args) => { transportCalls++; captured = args; return response; };
const api = compile("lib/manus-api.ts", { "./manus-balance-diagnostic": loadBalanceDiagnostic(), "./persistent-logger": { persistentLogger: { add() {} } }, "../core/enhancements/auth/productionProviderTransport": { probeManusCredential() {}, securedProviderFetch: (...args) => transport(...args) } });
await api.getManusAvailableCredits();
assert.equal(captured[0], "manus"); assert.equal(captured[1].baseUrl, "https://api.manus.ai");
assert.equal(captured[2], "v2/usage.availableCredits"); assert.equal(captured[3].method, "GET"); assert.equal(captured[3].body, undefined);
const preaborted = new AbortController(); preaborted.abort(); const beforeAbort = transportCalls;
await assert.rejects(api.getManusAvailableCredits(preaborted.signal), /MANUS_TIMEOUT:/); assert.equal(transportCalls, beforeAbort);
for (const [status, code] of [[401, "UNAUTHORIZED"], [403, "FORBIDDEN"], [429, "RATE_LIMITED"], [500, "REQUEST_FAILED"]]) {
  response = Response.json({ private: "not-for-ui" }, { status });
  await assert.rejects(api.getManusAvailableCredits(), e => e.message.startsWith(`MANUS_${code}:`) && !e.message.includes("not-for-ui"));
}
response = new Response("not-json"); await assert.rejects(api.getManusAvailableCredits(), /MANUS_INVALID_RESPONSE:/);
transport = async (...args) => { captured = args; return new Promise((resolve, reject) => args[3].signal.addEventListener("abort", () => reject(new Error("private abort")), { once: true })); };
const abort = new AbortController(), aborting = api.getManusAvailableCredits(abort.signal);
abort.abort(); await assert.rejects(aborting, /MANUS_TIMEOUT:/); assert.equal(captured[3].signal.aborted, true);
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 30000 ? 0 : ms, ...args);
try { await assert.rejects(api.getManusAvailableCredits(), /MANUS_TIMEOUT:/); } finally { globalThis.setTimeout = realTimeout; }
const native = fs.readFileSync("native/aib-credential-proxy/AibCredentialHttpProxyServer.java", "utf8");
assert.match(native, /parts\[0\]\.equals\("GET"\)[\s\S]*suffix\.equals\("v2\/usage\.availableCredits"\)/);
const hook = fs.readFileSync("hooks/useManusCredits.ts", "utf8");
assert.doesNotMatch(hook, /AsyncStorage|SecureStore|console\.(log|error)|\.setItem\(/);
console.log("AIB_V485_MANUS_BALANCE_LIFECYCLE_SELFTEST_OK runtime=mock-hooks+production-API gating=effect-only errors=401+403+429+timeout+malformed stale=explicit cancellation=binding+disable+unmount NO_LIVE_API");
