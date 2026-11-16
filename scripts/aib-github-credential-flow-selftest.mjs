#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const common = read("assets/github-tool/js/common.js");
const tokensJs = read("assets/github-tool/js/tokens.js");
const reposJs = read("assets/github-tool/js/repos.js");
const filesJs = read("assets/github-tool/js/files.js");
const screen = read("app/github.tsx");
const bridgeHost = read("lib/github-tool-bridge-host.ts");
const githubPlugin = read("plugins/withGithubTool.js");

// Verify the timeout travels intact through the production JS wrapper and host,
// and that the native plugin has real connect/read/deadline enforcement.
const nativeCallStart = common.indexOf("async function nativeCall(");
const nativeCallEnd = common.indexOf("async function http(", nativeCallStart);
assert.ok(nativeCallStart >= 0 && nativeCallEnd > nativeCallStart, "production nativeCall must remain testable");
let bridgePayload;
let bridgeReply = JSON.stringify({ ok: true, status: 200, statusText: "OK", headers: {}, body: "{}" });
const bridgeWindow = {
  __aibHttp: async (payload) => { bridgePayload = JSON.parse(payload); return bridgeReply; },
};
const nativeHarness = `${common.slice(nativeCallStart, nativeCallEnd)}\nthis.nativeCall = nativeCall;`;
const nativeContext = vm.createContext({ Promise, JSON, Object, String, Error, RegExp, window: bridgeWindow, trace: () => {}, shortPath: (u) => String(u) });
vm.runInContext(nativeHarness, nativeContext);
const nativeOk = await nativeContext.nativeCall("https://api.github.com/user", "GET", {}, undefined, false, 12345);
assert.equal(bridgePayload.timeoutMs, 12345, "caller timeoutMs must be serialized to native bridge payload");
assert.equal(nativeOk.status, 200);
bridgeReply = JSON.stringify({ ok: false, status: 0, statusText: "timeout", error: "timeout" });
await assert.rejects(
  nativeContext.nativeCall("https://api.github.com/user", "GET", {}, undefined, false, 12345),
  /Токен не проверен/,
  "native timeout must remain a transport failure rather than invalid-token status",
);
assert.match(bridgeHost, /await mod\.httpRequest\(JSON\.stringify\(p\)\)/, "production host passes the complete payload including timeoutMs to NativeModules");
assert.match(bridgeHost, /p\.timeoutMs/, "production host enforces the request timeout from the received payload");
assert.match(githubPlugin, /optInt\("timeoutMs", 15000\)\.coerceIn\(1000,/, "generated Kotlin parses and bounds timeoutMs");
assert.match(githubPlugin, /c\.connectTimeout = minOf\(remainingMs, 10000\)/, "URLConnection uses bounded connect timeout");
assert.match(githubPlugin, /c\.readTimeout = remainingMs/, "URLConnection uses remaining deadline for body reads");
assert.match(githubPlugin, /githubHttpTimeouts\.schedule\(/, "native bridge applies end-to-end deadline and cancellation");

// Execute the exact shared run() implementation with an intentionally unresolved error dialog.
const runStart = common.indexOf("function safeRequestError(value)");
const runEnd = common.indexOf("// ---------------- сеть GitHub", runStart);
assert.ok(runStart >= 0 && runEnd > runStart, "production run helper must remain locatable for behavioral tests");
const runHarness = `
  let visibleDepth = 0;
  const dialogs = [];
  const toasts = [];
  function setBusy() { visibleDepth += 1; }
  function clearBusy() { visibleDepth = Math.max(0, visibleDepth - 1); }
  function showError(message) { dialogs.push(message); return new Promise(function () {}); }
  function toast(message) { toasts.push(message); }
  ${common.slice(runStart, runEnd)}
  this.testApi = { run, get visibleDepth() { return visibleDepth; }, dialogs, toasts };
`;
const runContext = vm.createContext({ Promise, setTimeout, clearTimeout, String, Math });
vm.runInContext(runHarness, runContext);
const api = runContext.testApi;
const success = await api.run("Checking credentials", async () => "ok", 1000);
assert.deepEqual(JSON.parse(JSON.stringify(success)), { ok: true, v: "ok" });
assert.equal(api.visibleDepth, 0, "success clears busy state");
const rejected = await api.run("Checking credentials", async () => { throw new Error("rejected candidate"); }, 1000);
assert.equal(rejected.ok, false);
assert.equal(api.visibleDepth, 0, "failure clears busy state before the error dialog is acknowledged");
assert.equal(api.dialogs.length, 1);
const timed = await api.run("Checking credentials", () => new Promise(() => {}), 1000);
assert.equal(timed.ok, false, "a never-settling request becomes a bounded failure");
assert.equal(api.visibleDepth, 0, "timeout clears the busy overlay");
assert.match(api.dialogs.at(-1), /слишком много времени/i);
const sanitized = await api.run("Checking credentials", async () => { throw new Error("Authorization: token candidate-placeholder"); }, 1000);
assert.equal(sanitized.ok, false);
assert.doesNotMatch(api.dialogs.at(-1), /candidate-placeholder/);

// Execute the production files.js setup helper: the candidate is checked first,
// persisted only after valid identity, and never replaces the old value on failure.
const setupStart = filesJs.indexOf("async function verifyThenSaveSetupToken(candidate, shouldSave)");
const setupEnd = filesJs.indexOf("// ======================================================================", setupStart);
assert.ok(setupStart >= 0 && setupEnd > setupStart, "files setup verify/save helper must remain testable");
let setupResponse;
let setupWriteResult = true;
const setupEvents = [];
async function gh(method, path, body, opt) {
  setupEvents.push(["verify", method, path, opt && opt.noRetry, opt && opt.timeoutMs]);
  if (setupResponse instanceof Error) throw setupResponse;
  return setupResponse;
}
function ls(key, value) {
  if (arguments.length > 1 && key === "unzipgit_token") {
    setupEvents.push(["save", key]);
    return setupWriteResult;
  }
  return "previous-secure-credential";
}
const setupHarness = `${filesJs.slice(setupStart, setupEnd)}\nthis.verify = verifyThenSaveSetupToken;`;
const setupContext = vm.createContext({ Promise, String, Error, gh, ls });
vm.runInContext(setupHarness, setupContext);
const verifySetup = setupContext.verify;
const candidateToken = "synthetic-files-setup-candidate";
setupResponse = { ok: true, status: 200, data: { login: "verified-user" } };
setupEvents.length = 0;
const setupSuccess = await verifySetup(candidateToken, true);
assert.equal(setupSuccess.login, "verified-user");
assert.deepEqual(setupEvents.map((event) => event[0]), ["verify", "save"], "candidate is verified before SecureStore write");
assert.deepEqual(setupEvents[0].slice(1), ["GET", "/user", true, 15000]);
setupEvents.length = 0;
const savedKeyCheck = await verifySetup("already-stored-credential", false);
assert.equal(savedKeyCheck.login, "verified-user");
assert.deepEqual(setupEvents.map((event) => event[0]), ["verify"], "existing credential is checked without rewriting it");
for (const failed of [
  { ok: false, status: 401, data: null },
  { ok: false, status: 403, data: null },
  { ok: false, status: 429, data: null },
  { ok: true, status: 200, data: null },
  { ok: true, status: 200, data: { login: "" } },
]) {
  setupResponse = failed;
  setupEvents.length = 0;
  await assert.rejects(verifySetup(candidateToken, true));
  assert.deepEqual(setupEvents.map((event) => event[0]), ["verify"], "rejected/malformed candidates are never persisted");
}
setupResponse = new Error("offline");
setupEvents.length = 0;
await assert.rejects(verifySetup(candidateToken, true), /offline/);
assert.deepEqual(setupEvents.map((event) => event[0]), ["verify"]);
setupResponse = { ok: true, status: 200, data: { login: "verified-user" } };
setupWriteResult = false;
setupEvents.length = 0;
await assert.rejects(verifySetup(candidateToken, true), /защищённом хранилище/);
assert.deepEqual(setupEvents.map((event) => event[0]), ["verify", "save"], "secure-storage failure prevents later setup activation");
setupWriteResult = true;

// Execute the exact shared GitHub response parser and status classifier against mocked responses.
const ghStart = common.indexOf("async function gh(method, path, body, tk, preferNative)");
const ghEnd = common.indexOf("// ---------------- прочее", ghStart);
assert.ok(ghStart >= 0 && ghEnd > ghStart, "production GitHub parser must remain locatable for behavior tests");
const ghHarness = `
  let nextResponse;
  async function http() { if (nextResponse instanceof Error) throw nextResponse; return nextResponse; }
  function token() { return ''; }
  ${common.slice(ghStart, ghEnd)}
  this.testApi = { gh, errMsg, setResponse: (r) => { nextResponse = r; } };
`;
const ghContext = vm.createContext({ Promise, String, Object, JSON, RegExp, Error });
vm.runInContext(ghHarness, ghContext);
const ghApi = ghContext.testApi;
const headers = (extra = {}) => ({ get: (name) => extra[name.toLowerCase()] || null });
ghApi.setResponse({ ok: true, status: 200, get: headers().get, text: '{"login":"verified-user"}' });
const ghSuccess = await ghApi.gh("GET", "/user", undefined, "synthetic-only-candidate", true);
assert.equal(ghSuccess.ok, true);
assert.equal(ghSuccess.data.login, "verified-user");
ghApi.setResponse({ ok: false, status: 401, get: headers().get, text: '{"message":"Bad credentials"}' });
assert.match(ghApi.errMsg(await ghApi.gh("GET", "/user", undefined, "synthetic-only-candidate", true)), /Неверный токен/);
ghApi.setResponse({ ok: false, status: 403, get: headers().get, text: '{"message":"Resource not accessible by integration"}' });
const forbiddenMessage = ghApi.errMsg(await ghApi.gh("GET", "/user", undefined, "synthetic-only-candidate", true));
assert.match(forbiddenMessage, /Resource not accessible/);
assert.doesNotMatch(forbiddenMessage, /Неверный токен/i, "403 permission failure is not mislabeled as invalid credentials");
ghApi.setResponse({ ok: false, status: 429, get: headers({ "retry-after": "30" }).get, text: '{"message":"secondary rate limit"}' });
assert.match(ghApi.errMsg(await ghApi.gh("GET", "/user", undefined, "synthetic-only-candidate", true)), /лимит GitHub API/);
ghApi.setResponse(new Error("offline"));
await assert.rejects(ghApi.gh("GET", "/user", undefined, "synthetic-only-candidate", true), /offline/);
ghApi.setResponse({ ok: true, status: 200, get: headers().get, text: "not-json" });
await assert.rejects(ghApi.gh("GET", "/user", undefined, "synthetic-only-candidate", true), /некорректный JSON/);
ghApi.setResponse({ ok: true, status: 200, get: headers().get, text: "" });
await assert.rejects(ghApi.gh("GET", "/user", undefined, "synthetic-only-candidate", true), /пустой ответ/);

// Execute the real token-page IIFE against a small DOM and deterministic fake transport/storage.
const elements = new Map();
function makeElement(tag = "div", className = "", text = "") {
  const element = {
    tag, className, textContent: text, innerHTML: "", children: [], onclick: null,
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); return child; },
  };
  return element;
}
for (const id of ["tabs", "note", "fab", "list", "sub", "btnRefresh"]) elements.set(id, makeElement("div"));
const candidate = "synthetic-only-candidate";
const priorCredential = "existing-secure-value";
let response = { ok: true, data: { login: "verified-user", name: "" }, scopes: "repo", res: { get: () => null } };
let gate = null;
let httpCalls = 0;
const secureWrites = [];
const activeWrites = [];
let formCalls = 0;
const record = [{ id: "existing", name: "Existing", value: priorCredential, kind: "github", login: "prior-user", created: 1 }];
const U = {
  $: (id) => elements.get(id) || (elements.set(id, makeElement()), elements.get(id)),
  el: (tag, cls, text) => makeElement(tag, cls, text),
  icon: () => makeElement("svg"),
  iconBtn: (_icon, _size, _label, onClick) => Object.assign(makeElement("button"), { onclick: onClick }),
  btn: (_cls, _icon, _label, onClick) => Object.assign(makeElement("button"), { onclick: onClick }),
  mask: () => "••••",
  fmtDate: () => "date",
  randomId: () => "generated-id",
  token: () => priorCredential,
  ls: function (key, value) {
    if (arguments.length > 1 && key === "unzipgit_token") activeWrites.push(value);
    if (key === "unzipgit_username") return "prior-user";
    if (key === "unzipgit_token") return priorCredential;
    return "";
  },
  secretJson: (key) => key === "unzipgit_tokens" ? record.map((x) => ({ ...x })) : [],
  lsJson: () => [],
  saveSecretJson: async (key, value) => { secureWrites.push({ key, value: JSON.parse(JSON.stringify(value)) }); return true; },
  async sheet() { return "paste"; },
  async form() { formCalls += 1; return { name: "Candidate", value: candidate, act: false }; },
  async gh() {
    httpCalls += 1;
    if (gate) await gate;
    if (response instanceof Error) throw response;
    return response;
  },
  errMsg: (r) => r.status === 429 ? "rate limited" : `HTTP ${r.status}`,
  async run(_label, fn, timeoutMs) {
    assert.equal(timeoutMs, 20000, "token verification uses a bounded UI operation timeout");
    try { return { ok: true, v: await fn() }; } catch (error) { return { ok: false, error }; }
  },
  toast() {},
  copyText() {},
  async modal() {},
  async confirmBox() { return false; },
  async sheetClose() {},
};
const document = {
  readyState: "complete",
  createTextNode: (text) => makeElement("text", "", text),
  addEventListener(event, fn) { if (event === "DOMContentLoaded") fn(); },
};
const window = { UG: U, addEventListener() {} };
vm.runInNewContext(tokensJs, { window, document, Promise, Date, String, Array, Math, RegExp, JSON });
const fab = elements.get("fab");
assert.equal(typeof fab.onclick, "function");

async function runAdd() {
  await fab.onclick();
  // Some async DOM handlers are not returned by React/DOM events; await a bounded microtask turn.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Invalid/expired credential: retain existing credential and never write candidate.
response = { ok: false, status: 401, data: { message: "Bad credentials" }, res: { get: () => null } };
await runAdd();
assert.equal(httpCalls, 1);
assert.equal(secureWrites.length, 0, "401 candidate is rejected before SecureStore/list writes");
assert.equal(activeWrites.length, 0, "rejected candidate does not replace active credential");
assert.equal(record[0].value, priorCredential, "prior credential remains present");

// A real 403 is an HTTP rejection, but must not be mislabeled as a transport timeout or overwrite the existing token.
response = { ok: false, status: 403, data: { message: "Resource not accessible" }, res: { get: () => null } };
await runAdd();
assert.equal(secureWrites.length, 0, "403 candidate is not persisted");
assert.equal(activeWrites.length, 0, "403 candidate does not replace the active token");
assert.equal(record[0].value, priorCredential, "403 response preserves the prior credential");

// Rate limit, network failure, timeout and malformed /user payload all fail closed without saving.
for (const failure of [
  { ok: false, status: 429, data: { message: "rate limit" }, res: { get: () => null } },
  new Error("offline"),
  new Error("request timeout"),
  { ok: true, data: null, res: { get: () => null } },
  { ok: true, data: { login: "" }, res: { get: () => null } },
]) {
  response = failure;
  await runAdd();
  assert.equal(secureWrites.length, 0, "failed or invalid response never persists the candidate");
  assert.equal(activeWrites.length, 0, "failed candidate never replaces the saved active credential");
}

// Valid token persists only after /user identity was verified; it does not auto-activate when unchecked.
response = { ok: true, data: { login: "verified-user", name: "" }, scopes: "repo", res: { get: () => null } };
await runAdd();
assert.equal(secureWrites.length, 1);
assert.equal(secureWrites[0].key, "unzipgit_tokens");
assert.equal(secureWrites[0].value.some((x) => x.value === candidate), true);
assert.equal(activeWrites.length, 0, "unchecked activation leaves the active credential unchanged");

// Two concurrent submits while the request is pending issue just one /user call.
secureWrites.length = 0;
httpCalls = 0;
let release;
gate = new Promise((resolve) => { release = resolve; });
const beforeForms = formCalls;
const first = fab.onclick();
const second = fab.onclick();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(formCalls, beforeForms + 2, "two synthetic form submissions reached the shared handler");
assert.equal(httpCalls, 1, "the verification lock permits only one in-flight GitHub request");
release();
await Promise.all([first, second]);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(httpCalls, 1);
gate = null;

// Subsequent repository and file operations use the shared authenticated GitHub helper.
assert.match(common, /headers\.Authorization\s*=\s*'token '\s*\+\s*\(tk\s*\|\|\s*token\(\)\)/);
assert.ok(common.includes(String.raw`if (/^https:\/\/api\.github\.com(?::443)?(?:[/?#]|$)/i.test(url)) headers.Authorization`), "Authorization remains limited to the exact GitHub API origin");
assert.match(reposJs, /U\.gh\('GET',\s*path\)/);
assert.match(filesJs, /async function gh\(method, path, body, opt\)/);
assert.match(filesJs, /headers\.Authorization\s*=\s*'token '\s*\+\s*\(opt\.token\s*\|\|\s*cfg\.token\)/);
assert.match(filesJs, /timeoutMs:\s*opt\.timeoutMs\s*\|\|\s*15000/);
assert.match(filesJs, /AbortController/);
assert.match(filesJs, /setupSubmitting\s*=\s*true/);
assert.match(filesJs, /verifyThenSaveSetupToken\(candidate,\s*!!t\)/);
assert.match(filesJs, /await init\(false\)/, "setup waits for the subsequent authenticated repository load");
assert.doesNotMatch(filesJs, /ls\('unzipgit_token',\s*t\)[^\n]*;\s*\n\s*ls\('unzipgit_username'/, "credentials cannot be stored before candidate verification");
assert.match(common, /timeoutMs:\s*timeoutMs\s*\|\|\s*15000/);
assert.match(common, /Токен не проверен/);
assert.match(common, /phaseLabels\s*=\s*\{[^}]*dns:[^}]*connect:[^}]*response-body/s, "native timeout can report a safe network phase without including request headers");
assert.match(common, /if \(r\.status === 401\)/, "invalid-token wording is tied to an explicit HTTP 401 response");
assert.doesNotMatch(common, /if \(!r\.status\) return 'Неверный токен/);
assert.match(bridgeHost, /p\.timeoutMs/);
assert.match(bridgeHost, /ctrl\.abort\(\)/);
assert.match(bridgeHost, /github host not allowed/);
assert.match(bridgeHost, /Number\(p\.timeoutMs\)\s*\|\|\s*\(p\.binary\s*\?\s*120000\s*:\s*15000\)/, "active Expo host defaults GitHub API HTTP to 15 seconds");
assert.match(bridgeHost, /legacyAuthFetch[\s\S]*?Math\.min\(requestedTimeoutMs, 8000\)[\s\S]*?Promise\.race\(\[requestAndRead\(\), deadline\]\)/, "only the /user auth fallback has a hard deadline even if fetch ignores abort");
assert.match(bridgeHost, /timer = setTimeout\(\(\) => ctrl\.abort\(\), timeoutMs\)/, "non-auth and old-build RN fetch paths retain their bounded AbortController behavior");
assert.match(screen, /httpRequest: function\(\) \{ throw new Error\('use async __aibHttp'\); \}/, "active WebView route uses the async Expo host bridge, not an unbounded legacy sync call");
assert.match(githubPlugin, /val timeoutMs = o\.optInt\("timeoutMs", 15000\)\.coerceIn\(1000, if \(wantBinary\) 180000 else 30000\)/, "native plugin honors the request timeout with bounded binary/non-binary ceilings");
assert.match(githubPlugin, /c\.connectTimeout = minOf\(remainingMs, 10000\)/, "native connect timeout is bounded by the remaining end-to-end request budget");
assert.match(githubPlugin, /c\.readTimeout = remainingMs/, "native read timeout cannot exceed the remaining end-to-end request budget");
assert.doesNotMatch(tokensJs, /persistentLogger|console\.log|console\.error/);
assert.doesNotMatch(screen, /console\.(?:log|error)\([^\n]*(?:token|payload)/i, "request/token values must not be logged by the bridge");

console.log("AIB_GITHUB_CREDENTIAL_FLOW_SELFTEST_OK scenarios=200,401,403,429,offline,timeout,no-save-on-failure,retained-credential,duplicate-submit");
