#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { classifyGithubToolEventUrl, classifyGithubToolMessage, createGithubToolMessageParser, createGithubToolOnMessage, createGithubToolReply, createGithubToolSessionSecretVault, routeGithubToolMessage } from "../lib/github-tool-bridge-host.ts";
import { isAllowedGithubToolHttpUrl } from "../lib/github-tool-security.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const appSource = read("app/github.tsx");
const githubAppSource = read("assets/github-tool/js/app.js");
const commonSource = read("assets/github-tool/js/common.js");
const reposSource = read("assets/github-tool/js/repos.js");
const hostSource = read("lib/github-tool-bridge-host.ts");
const pluginSource = read("plugins/withGithubTool.js");
const bridgeStart = appSource.indexOf("  const injected = `");
const bridgeEnd = appSource.indexOf("\n`;", bridgeStart);
assert.ok(bridgeStart >= 0 && bridgeEnd > bridgeStart, "test runs the injected production WebView bridge source");
const injectedBridge = appSource.slice(bridgeStart + "  const injected = `".length, bridgeEnd);
assert.match(appSource, /routeGithubToolMessage\(event,\s*\{/s, "React Native onMessage delegates into the exercised production router");
assert.match(appSource, /createGithubToolOnMessage\(\(\) => docUrlRef\.current, routeMessage/, "the screen uses the exact onMessage normalizer exercised by this source E2E test");
assert.match(appSource, /AIB_GITHUB_BRIDGE_FIX_V272_02[\s\S]*?source_marker_loaded/, "the next Builder log identifies the v272 main-frame source fix");
assert.match(appSource, /createGithubToolReply\(webRef\)/, "reply callback retains the live WebView ref instead of capturing its initial null value");
assert.match(appSource, /NativeModules\.AibGithubTool/, "production UI looks up the native module by its generated name");
assert.match(pluginSource, /override fun getName\(\)\s*=\s*"AibGithubTool"/, "the generated Android module exports the exact UI module name");
assert.match(pluginSource, /ReactMethod fun httpRequest/, "the generated Kotlin bridge exposes the production HTTP method");
assert.match(pluginSource, /ReactMethod fun secretSetResult/, "the generated Kotlin bridge returns secure-write result and failure stage atomically");
assert.match(injectedBridge, /correlationId = id/, "the WebView carries the secretSet request correlation id into its eventual reply diagnostic");
assert.match(injectedBridge, /\[a-z0-9\]\{1,16\}-\[a-z0-9\]\{8\}:c\[1-9\]\[0-9\]\{0,9\}/, "the WebView only echoes the generated opaque correlation-id shape");
assert.match(hostSource, /\[a-z0-9\]\{1,16\}-\[a-z0-9\]\{8\}:c\[1-9\]\[0-9\]\{0,9\}/, "the host drops arbitrary message ids that could contain account/repository text");
assert.match(hostSource, /settleBefore\(nativeWrite, writeDeadlineMs\)/, "secure storage writes have a bounded native deadline");
assert.match(hostSource, /Math\.min\(Number\(deps\.secretWriteTimeoutMs\), 15000\)/, "the test deadline cannot extend the production 15-second maximum");
assert.match(hostSource, /nativeSecretWritesInFlight/, "timed-out native storage remains serialized until its promise settles");
assert.match(hostSource, /secretSet\.native\.late_settled_success/, "late completion is diagnosed without activating the WebView cache");
assert.doesNotMatch(hostSource, /late_settled_success[\s\S]{0,180}notifySecretsUpdated/, "late timed-out write never triggers secret rehydration");
assert.match(hostSource, /legacyAuthFetch[\s\S]*?isAuthVerificationGet[\s\S]*?isNativeTransportErrorResponse/, "only safe /user transport errors can use the legacy fetch path");
assert.match(hostSource, /Math\.min\(requestedTimeoutMs, 8000\)/, "auth fallback has a bounded eight-second cap");
assert.match(hostSource, /Promise\.race\(\[requestAndRead\(\), deadline\]\)/, "host returns on the hard fallback deadline even if fetch ignores AbortSignal");
const rawDownloadStart = githubAppSource.indexOf("if (meta && meta.download_url)");
const apiContentsFallback = githubAppSource.indexOf("const rawRes = await fetchWithRetry(metaUrl", rawDownloadStart);
assert.ok(rawDownloadStart >= 0 && apiContentsFallback > rawDownloadStart, "raw download has a separate authenticated API fallback");
const rawDownloadBlock = githubAppSource.slice(rawDownloadStart, apiContentsFallback);
assert.match(rawDownloadBlock, /headers: \{ 'Accept': 'application\/octet-stream' \}/, "raw download_url requests send only a non-credential Accept header");
assert.doesNotMatch(rawDownloadBlock, /Authorization|Cookie|Proxy-Authorization/i, "PAT and ambient credentials are never attached to raw/download_url requests");
assert.match(githubAppSource.slice(apiContentsFallback, apiContentsFallback + 250), /authHeaders\(token, \{ 'Accept': 'application\/vnd\.github\.raw\+json' \}\)/, "private files retain an authenticated API contents endpoint fallback");
assert.match(appSource, /authCheck[\s\S]*?slackMs = authCheck \? 15000 : 5000[\s\S]*?authCheck \? 30000/, "the WebView callback deadline reserves auth-fallback slack");
assert.match(reposSource, /Проверка токена[\s\S]*?\}, 30000\)/, "connect UI outer deadline exceeds native plus fallback budget");
assert.doesNotMatch(appSource + commonSource + reposSource + hostSource, /console\.(?:log|error)\([^)]*(?:token|authorization|payload)/i, "token/authorization payloads are not logged by the production auth path");
assert.match(reposSource, /async function connect\(\)[\s\S]*?U\.gh\('GET', '\/user'[\s\S]*?await U\.ls\('unzipgit_token', t\)[\s\S]*?await load\(r\.v\)/, "production connect verifies identity, saves, then loads owner/repositories");
assert.match(commonSource, /sessionStorage\.getItem\(k\)/, "shared migration detects raw sessionStorage credential keys");
assert.match(read("assets/github-tool/js/files.js"), /sessionStorage\.getItem\(k\)/, "Files page migration detects raw sessionStorage credential keys");

const trustedAssetUrl = "file:///android_asset/github-tool/repos.html";
assert.equal(classifyGithubToolEventUrl(trustedAssetUrl), "trusted_asset", "canonical bundled asset metadata is classified without logging its URL");
assert.equal(classifyGithubToolEventUrl("file:///android_asset/github-tool/not-canonical"), "local_file_other");
assert.equal(classifyGithubToolEventUrl("https://untrusted.invalid/private?secret=query-value"), "http_other");
assert.equal(classifyGithubToolEventUrl("content://provider/private"), "other_scheme");
assert.equal(classifyGithubToolEventUrl(null), "missing");
assert.equal(classifyGithubToolEventUrl(`file:${"x".repeat(2049)}`), "oversize");
assert.equal(classifyGithubToolEventUrl("https://bad host.invalid/path"), "invalid");
assert.deepEqual(classifyGithubToolMessage(JSON.stringify({ type: "secretSet", id: "lqf8nv0p-a1b2c3d4:c4", value: "never-log-this" })), { messageType: "secretSet", correlationId: "lqf8nv0p-a1b2c3d4:c4" });
assert.deepEqual(classifyGithubToolMessage(JSON.stringify({ type: "httpRequest", id: "sensitive-owner:c1", payload: "never-log-this" })), { messageType: "httpRequest" }, "arbitrary ids and every payload field are discarded from diagnostic metadata");
assert.deepEqual(classifyGithubToolMessage("not-json"), { messageType: "unknown" });
assert.deepEqual(classifyGithubToolMessage("x".repeat(2_100_001)), { messageType: "unknown" }, "oversized data is not parsed merely for diagnostics");

const migrationStart = commonSource.indexOf("function secretGet(k)");
const migrationEnd = commonSource.indexOf("function lsJson(k, def)", migrationStart);
assert.ok(migrationStart >= 0 && migrationEnd > migrationStart, "shared token migration and ls helpers remain directly executable in tests");
async function exerciseLegacyMemoryMigration(saveResult) {
  const local = new Map();
  const session = new Map([["unzipgit_token", "synthetic-legacy-token"], ["aib_sec_unzipgit_token", "synthetic-prefixed-token"]]);
  const toasts = [];
  const window = {
    AndroidInterface: { secretSet: async () => saveResult, showToast: (message) => toasts.push(message) },
    dispatchEvent() {}, addEventListener() {},
  };
  const source = `${commonSource.slice(migrationStart, migrationEnd)}\nthis.api={ls,pendingSecret};`;
  const context = vm.createContext({ Promise, Object, String, window, localStorage: { getItem: (k) => local.get(k) ?? null, removeItem: (k) => local.delete(k), setItem: (k, v) => local.set(k, String(v)) }, sessionStorage: { getItem: (k) => session.get(k) ?? null, removeItem: (k) => session.delete(k), setItem: (k, v) => session.set(k, String(v)) }, Event: class {} });
  vm.runInContext(source, context);
  assert.equal(context.api.ls("unzipgit_token"), "", "raw legacy value is never synchronously returned as an active token");
  await new Promise((resolve) => setImmediate(resolve));
  return { local, session, toasts, pending: context.api.pendingSecret("unzipgit_token") };
}
const rejectedLegacyMigration = await exerciseLegacyMemoryMigration(false);
assert.equal(rejectedLegacyMigration.local.size, 0, "failed migration removes persistent plaintext rather than leaving an open-disk credential");
assert.equal(rejectedLegacyMigration.session.size, 0, "failed migration also removes every raw/prefixed sessionStorage copy");
assert.equal(rejectedLegacyMigration.pending, "synthetic-legacy-token", "failed migration retains the candidate in current-document RAM for safe retry");
assert.equal(rejectedLegacyMigration.toasts.length, 1, "failed legacy migration gives a user-visible re-entry/retry warning");
const confirmedLegacyMigration = await exerciseLegacyMemoryMigration(true);
assert.equal(confirmedLegacyMigration.local.size, 0, "confirmed secure or explicit session save clears local legacy values");
assert.equal(confirmedLegacyMigration.session.size, 0, "confirmed secure or explicit session save clears raw and prefixed session copies");
assert.equal(confirmedLegacyMigration.pending, "", "confirmed save clears the in-memory migration candidate");

class FakeElement {
  constructor(tag = "div", id = "") {
    this.tag = tag;
    this.id = id;
    this.className = "";
    this.children = [];
    this.style = {};
    this.value = "";
    this.checked = false;
    this.onclick = null;
    this.handlers = {};
    this.attributes = {};
    this._text = "";
    this._html = "";
    this.hidden = new Set(["hidden"]);
    this.classList = {
      add: (name) => this.hidden.add(name),
      remove: (name) => this.hidden.delete(name),
      contains: (name) => this.hidden.has(name),
      toggle: (name, force) => {
        const add = force === undefined ? !this.hidden.has(name) : Boolean(force);
        if (add) this.hidden.add(name); else this.hidden.delete(name);
        return add;
      },
    };
  }
  set textContent(value) { this._text = String(value ?? ""); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c?.textContent || "").join(""); }
  set innerHTML(value) { this._html = String(value ?? ""); }
  get innerHTML() { return this._html; }
  get firstChild() { return null; }
  appendChild(child) { if (child) this.children.push(child); return child; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  remove() {}
}

async function exerciseConnect({ userStatus = 200, timeout = false, nativeUserTransportError = false, fallbackUserStatus = 200, fallbackTransportFailure = false, fallbackNeverSettles = false, saveReadback = true, saveFailureStage = null, rollbackSucceeds = true, previousCredential = null, duplicateTap = false, holdNative = false, unmountBeforeNativeReply = false, eventUrlMode = "trusted", nativeWriterUnavailable = false, sessionOnlyChoice = false, secretWriteNeverSettles = false, secretWriteDelayMs = 0, secretWriteTimeoutMs = 15000 } = {}) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement("div", id));
    return elements.get(id);
  };
  for (const id of ["connect", "main", "fab", "cnErr", "modalWrap", "sheetWrap", "busy"]) getElement(id).classList.add("hidden");
  const documentListeners = new Map();
  const windowListeners = new Map();
  const storedSecrets = new Map();
  const sessionVault = createGithubToolSessionSecretVault();
  const local = new Map();
  const session = new Map();
  const messages = [];
  const requests = [];
  const fallbackRequests = [];
  const events = [];
  const diagnostics = [];
  const secretUpdateNotifications = [];
  const pendingRoutes = new Set();
  let releaseNative;
  const nativeGate = new Promise((resolve) => { releaseNative = resolve; });
  const unrefTimeout = (callback, ms, ...args) => {
    const timer = setTimeout(callback, ms, ...args);
    timer.unref?.();
    return timer;
  };
  const syntheticCandidate = "synthetic-github-candidate-not-a-real-token";
  const enteredToken = ` \t${syntheticCandidate} \n`;
  const fakeRepo = {
    id: 41,
    name: "demo-repo",
    full_name: "verified-owner/demo-repo",
    owner: { login: "verified-owner" },
    private: false,
    archived: false,
    fork: false,
    language: "TypeScript",
    pushed_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/verified-owner/demo-repo",
    clone_url: "https://github.com/verified-owner/demo-repo.git",
    default_branch: "main",
    permissions: { admin: false },
  };
  const context = vm.createContext({
    Promise,
    Date,
    Math,
    JSON,
    Object,
    String,
    Number,
    Array,
    RegExp,
    Error,
    Uint8Array,
    Event: class { constructor(type) { this.type = type; } },
    setTimeout: unrefTimeout,
    clearTimeout,
    console,
    document: {
      readyState: "loading",
      body: new FakeElement("body"),
      getElementById: getElement,
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (text) => { const el = new FakeElement("text"); el.textContent = text; return el; },
      createDocumentFragment: () => new FakeElement("fragment"),
      addEventListener(type, fn) { (documentListeners.get(type) || documentListeners.set(type, []).get(type)).push(fn); },
    },
    localStorage: {
      getItem: (key) => local.get(key) ?? null,
      setItem: (key, value) => local.set(key, String(value)),
      removeItem: (key) => local.delete(key),
    },
    sessionStorage: {
      getItem: (key) => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, String(value)),
      removeItem: (key) => session.delete(key),
    },
    location: { pathname: "/android_asset/github-tool/repos.html", href: "file:///android_asset/github-tool/repos.html" },
    navigator: { onLine: true },
    window: {
      location: { pathname: "/android_asset/github-tool/repos.html", href: "file:///android_asset/github-tool/repos.html" },
      MI: () => "",
      addEventListener(type, fn) { (windowListeners.get(type) || windowListeners.set(type, []).get(type)).push(fn); },
      dispatchEvent(event) { for (const fn of windowListeners.get(event.type) || []) fn(event); },
    },
  });
  const webRef = { current: null };
  const reply = createGithubToolReply(webRef);
  webRef.current = { injectJavaScript: (js) => vm.runInContext(js, context) };
  const mockNative = {
    async httpRequest(rawPayload) {
      const payload = JSON.parse(rawPayload);
      requests.push(payload);
      const url = new URL(payload.url);
      assert.equal(url.hostname, "api.github.com", "production UI routes only to the mock GitHub API host");
      const authorization = payload.headers?.Authorization || payload.headers?.authorization;
      if (url.pathname === "/user") {
        assert.equal(authorization, `token ${syntheticCandidate}`, "the UI candidate reaches the native bridge only in the mocked authorization header");
        if (holdNative) await nativeGate;
        if (timeout) return JSON.stringify({ ok: false, status: 0, statusText: "timeout:connect", body: "", headers: {}, error: "timeout:connect", phase: "connect" });
        if (nativeUserTransportError) return JSON.stringify({ ok: false, status: 0, statusText: "UnknownHostException", body: "", headers: {}, error: "UnknownHostException: synthetic DNS failure", phase: "dns" });
        if (userStatus !== 200) return JSON.stringify({ ok: false, status: userStatus, statusText: "Unauthorized", body: JSON.stringify({ message: "Bad credentials" }), headers: {}, isBase64: false });
        events.push(["http-success", "/user"]);
        return JSON.stringify({ ok: true, status: 200, statusText: "OK", body: JSON.stringify({ login: "verified-owner", name: "Verified Owner" }), headers: { "X-OAuth-Scopes": "repo" }, isBase64: false });
      }
      if (url.pathname === "/user/repos") {
        assert.equal(authorization, `token ${syntheticCandidate}`, "the saved active token is read back by the UI before repositories load");
        return JSON.stringify({ ok: true, status: 200, statusText: "OK", body: JSON.stringify([fakeRepo]), headers: {}, isBase64: false });
      }
      throw new Error(`Unexpected mocked endpoint ${url.pathname}`);
    },
    async secretGet(name) { events.push(["secure-read", name]); return storedSecrets.get(name) || ""; },
    async secretSetResult(name, value) {
      if (secretWriteNeverSettles) return await new Promise(() => {});
      if (secretWriteDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, secretWriteDelayMs));
      events.push(["secure-write", name]);
      const previous = storedSecrets.has(name) ? storedSecrets.get(name) : undefined;
      storedSecrets.set(name, value);
      const readBackMatches = saveReadback && storedSecrets.get(name) === value;
      events.push(["secure-read-back", name]);
      if (!readBackMatches) {
        if (rollbackSucceeds) {
          if (previous === undefined) storedSecrets.delete(name);
          else storedSecrets.set(name, previous);
        }
      }
      const saved = saveReadback && readBackMatches;
      return { saved, stage: saved ? "verified" : saveFailureStage || (rollbackSucceeds ? "readback_mismatch" : "rollback_failed") };
    },
    async secretSet(name, value) { return (await this.secretSetResult(name, value)).saved; },
    async secretSetLastStage() { return saveReadback ? "verified" : rollbackSucceeds ? "readback_mismatch" : "rollback_failed"; },
    async secretDelete(name) { storedSecrets.delete(name); return true; },
  };
  const nativeModule = { ...mockNative };
  if (nativeWriterUnavailable) {
    delete nativeModule.secretSetResult;
    delete nativeModule.secretSet;
  }
  const productionOnMessage = createGithubToolOnMessage(
    () => "file:///android_asset/github-tool/repos.html",
    (event) => routeGithubToolMessage(event, {
      native: nativeModule,
      sessionVault,
      secretWriteTimeoutMs,
      notifySecretsUpdated: (documentId) => secretUpdateNotifications.push(documentId),
      confirmSessionOnly: async (reason) => { events.push(["session-consent", reason]); return sessionOnlyChoice; },
      onSessionOnly: () => events.push(["session-mode-enabled"]),
      parseMessage: createGithubToolMessageParser((stage) => diagnostics.push(stage)),
      isAllowedHttpUrl: isAllowedGithubToolHttpUrl,
      reply,
      saveFile: async () => {},
      openUrl: async () => {},
      shareText: async () => {},
      stage: (stage) => diagnostics.push(stage),
      fetchRequest: async (url, init) => {
        fallbackRequests.push({ url, method: init.method, authorization: init.headers.Authorization || init.headers.authorization });
        assert.equal(new URL(url).hostname, "api.github.com", "legacy fallback remains restricted to the prevalidated HTTPS GitHub URL");
        assert.equal(init.method, "GET", "legacy retry is idempotent only");
        if (new URL(url).pathname === "/user") {
          if (fallbackNeverSettles) {
            return await new Promise((_resolve, _reject) => {
              init.signal.addEventListener("abort", () => events.push(["fallback-abort", "/user"]), { once: true });
            });
          }
          if (fallbackTransportFailure) throw new Error("UnknownHostException: synthetic fallback transport failure");
          events.push(["fallback-http", fallbackUserStatus]);
          if (fallbackUserStatus === 200) events.push(["http-success", "/user"]);
          return { ok: fallbackUserStatus === 200, status: fallbackUserStatus, statusText: fallbackUserStatus === 200 ? "OK" : "Service Unavailable", headers: { forEach: (cb) => cb("repo", "X-OAuth-Scopes") }, text: async () => JSON.stringify(fallbackUserStatus === 200 ? { login: "verified-owner", name: "Verified Owner" } : { message: "mock fallback unavailable" }), arrayBuffer: async () => new ArrayBuffer(0) };
        }
        throw new Error(`Unexpected mocked fetch endpoint ${new URL(url).pathname}`);
      },
    }),
    (stage) => diagnostics.push(stage),
  );
  context.window.ReactNativeWebView = {
    postMessage(raw) {
      const message = JSON.parse(raw);
      messages.push(message);
      const eventUrl = eventUrlMode === "null" ? null : eventUrlMode === "foreign" ? "https://untrusted.invalid/private?query=synthetic" : eventUrlMode === "local-alias" ? "file:///android_asset/github-tool/noncanonical-source" : "file:///android_asset/github-tool/repos.html";
      const task = productionOnMessage({ nativeEvent: { url: eventUrl, data: raw } }).finally(() => pendingRoutes.delete(task));
      pendingRoutes.add(task);
    },
  };
  context.window.alert = () => {};
  vm.runInContext(injectedBridge, context);
  vm.runInContext(commonSource, context);
  vm.runInContext(reposSource, context);

  async function drain() {
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      if (pendingRoutes.size) await Promise.all([...pendingRoutes]);
      else await new Promise((resolve) => setTimeout(resolve, 0));
      if (!pendingRoutes.size) {
        await Promise.resolve();
        if (!pendingRoutes.size) return;
      }
    }
    throw new Error("Mock postMessage queue did not drain");
  }
  await drain();
  context.document.readyState = "complete";
  for (const fn of documentListeners.get("DOMContentLoaded") || []) fn.call(context.document, { type: "DOMContentLoaded" });
  await drain();
  assert.equal(typeof getElement("cnOk").onclick, "function", "the actual packaged connect button handler was mounted");
  // Seed the existing encrypted value only after startup hydration, so this test isolates replacement rollback.
  if (previousCredential) storedSecrets.set("unzipgit_token", previousCredential);
  getElement("cnToken").value = enteredToken;
  const click = getElement("cnOk").onclick();
  if (duplicateTap) await getElement("cnOk").onclick();
  if (unmountBeforeNativeReply) {
    for (let i = 0; i < 40 && !requests.length; i += 1) await Promise.resolve();
    assert.equal(requests.length, 1, "the connect request reached the held synthetic native boundary before unmount");
    webRef.current = null;
    releaseNative();
    await drain();
    assert.equal(events.some((e) => e[0] === "secure-write"), false, "a reply after WebView unmount cannot continue the UI into secure persistence");
    assert.equal(storedSecrets.get("unzipgit_token"), previousCredential || undefined, "unmount preserves the previously active secure credential");
    return { elements, requests, fallbackRequests, messages, events, diagnostics, storedSecrets, secretUpdateNotifications, syntheticCandidate, enteredToken, fakeRepo, unmounted: true };
  }
  await click;
  await drain();

  return { elements, requests, fallbackRequests, messages, events, diagnostics, storedSecrets, secretUpdateNotifications, sessionVault, syntheticCandidate, enteredToken, fakeRepo };
}

const success = await exerciseConnect();
assert.deepEqual(success.requests.map((r) => new URL(r.url).pathname), ["/user", "/user/repos"], "real UI handler must verify /user then load repositories through the native module");
assert.ok(success.messages.some((m) => m.type === "httpRequest" && JSON.parse(m.payload).url === "https://api.github.com/user"), "/user request crosses the actual WebView postMessage protocol");
assert.ok(success.messages.some((m) => m.type === "secretSet" && m.name === "unzipgit_token"), "active credential write crosses postMessage to mocked Kotlin module contract");
assert.equal(success.storedSecrets.get("unzipgit_token"), success.syntheticCandidate);
const savedTokens = JSON.parse(success.storedSecrets.get("unzipgit_tokens"));
assert.ok(savedTokens.some((entry) => entry.value === success.syntheticCandidate && entry.login === "verified-owner"), "the verified candidate is also retained in the encrypted token list");
assert.match(success.elements.get("acct").textContent, /Аккаунт: verified-owner · репозиториев: 1/, "verified owner and repository count reach the visible owner/repositories UI");
assert.match(success.elements.get("list").textContent, /verified-owner\/demo-repo/, "the verified repository card is rendered");
assert.ok(success.events.findIndex((e) => e[0] === "secure-write" && e[1] === "unzipgit_token") > success.events.findIndex((e) => e[0] === "http-success" && e[1] === "/user"), "SecureStore write follows successful /user verification");
assert.ok(success.events.some((e) => e[0] === "secure-read-back" && e[1] === "unzipgit_token"), "secure storage reports success only after its read-back check");
const secretSetRequest = success.messages.find((m) => m.type === "secretSet");
assert.ok(secretSetRequest && /^[a-z0-9]{1,16}-[a-z0-9]{8}:c[1-9][0-9]{0,9}$/.test(secretSetRequest.id), "production WebView emits a bounded generated opaque request correlation id");
const secretSetCorrelation = secretSetRequest.id;
const correlated = (stage) => `${stage} correlation=${secretSetCorrelation}`;
assert.ok(success.diagnostics.some((stage) => stage.startsWith("rn.onMessage.received eventUrlKind=trusted_asset trackedDocumentTrusted=true eventMatchesTrackedDocument=true messageType=secretSet correlation=")), "the production callback requires and classifies the exact full current document URL without logging URL/payload");
assert.equal(success.elements.get("busy").classList.contains("hidden"), true, "successful connect clears the progress spinner");
for (const stage of ["message.parse.accepted messageType=secretSet", "host.message.accepted type=secretSet", "secretSet.native.begin", "secretSet.native.result=success", "secretSet.native.stage=verified", "secretSet.response.sent", "webview.secretSet_reply_success"]) {
  assert.ok(success.diagnostics.includes(correlated(stage)), `production stage trace includes correlated ${stage}`);
}
const successOrder = ["secretSet.native.begin", "secretSet.native.result=success", "secretSet.native.stage=verified", "secretSet.response.begin result=success", "secretSet.response.sent", "webview.secretSet_reply_success"].map((stage) => success.diagnostics.indexOf(correlated(stage)));
assert.ok(successOrder.every((index, i) => index >= 0 && (i === 0 || index > successOrder[i - 1])), "native write/read-back, host response, and WebView receipt are ordered");
const successDiagnosticText = success.diagnostics.join("\n");
for (const forbidden of [success.syntheticCandidate, "api.github.com", "/user", "verified-owner", "demo-repo", "Authorization", "Cookie", "?query="]) {
  assert.equal(successDiagnosticText.includes(forbidden), false, `stage diagnostics never include secret, URL/path, username, or authorization material (${forbidden})`);
}
const rejectedSourceCases = [
  { label: "missing", url: null, kind: "missing" },
  { label: "noncanonical local file", url: "file:///android_asset/github-tool/noncanonical-source", kind: "local_file_other" },
  { label: "stale but allowlisted other page", url: "file:///android_asset/github-tool/tokens.html", kind: "trusted_asset" },
  { label: "foreign page", url: "https://untrusted.invalid/private?query=synthetic", kind: "http_other" },
];
for (const [index, testCase] of rejectedSourceCases.entries()) {
  const caseDiagnostics = [];
  let caseWrites = 0;
  const caseOnMessage = createGithubToolOnMessage(
    () => "file:///android_asset/github-tool/repos.html",
    (event) => routeGithubToolMessage(event, {
      native: { async secretSetResult() { caseWrites += 1; return { saved: true, stage: "verified" }; } },
      parseMessage: createGithubToolMessageParser((stage) => caseDiagnostics.push(stage)),
      isAllowedHttpUrl: isAllowedGithubToolHttpUrl,
      reply: () => {}, saveFile: async () => {}, openUrl: async () => {}, shareText: async () => {},
      stage: (stage) => caseDiagnostics.push(stage),
    }),
    (stage) => caseDiagnostics.push(stage),
  );
  await caseOnMessage({ nativeEvent: { url: testCase.url, data: JSON.stringify({ type: "secretSet", id: `lqf8nv0p-a1b2c3d4:c${index + 2}`, name: "unzipgit_token", value: "synthetic-secret-never-log" }) } });
  const correlation = `lqf8nv0p-a1b2c3d4:c${index + 2}`;
  assert.ok(caseDiagnostics.some((stage) => stage.startsWith(`rn.onMessage.received eventUrlKind=${testCase.kind} trackedDocumentTrusted=true eventMatchesTrackedDocument=false messageType=secretSet correlation=${correlation}`)), `${testCase.label} is enum-classified and not substituted with the tracked URL`);
  assert.ok(caseDiagnostics.includes(`message.parse.rejected trust=denied messageType=secretSet correlation=${correlation}`), `${testCase.label} is denied by the production parser`);
  assert.equal(caseWrites, 0, `${testCase.label} cannot reach native secure save`);
  assert.equal(caseDiagnostics.join("\n").includes("synthetic-secret-never-log"), false, `${testCase.label} payload is not logged`);
}

const fallbackHeaderCases = [];
for (const target of [
  { url: "https://raw.githubusercontent.com/owner/repo/main/file.txt", expectedAuthorization: false },
  { url: "https://objects.githubusercontent.com/file", expectedAuthorization: false },
  { url: "https://api.github.com/user", expectedAuthorization: true },
]) {
  await routeGithubToolMessage({ nativeEvent: { url: "file:///android_asset/github-tool/files.html", data: JSON.stringify({
    type: "httpRequest", id: `header:${fallbackHeaderCases.length}`, documentId: "header-test",
    payload: JSON.stringify({ url: target.url, method: "GET", timeoutMs: 1000, headers: {
      Authorization: "token synthetic-never-real", Cookie: "synthetic-cookie", "X-Test": "safe",
    } }),
  }) } }, {
    native: undefined,
    parseMessage: createGithubToolMessageParser(() => {}),
    isAllowedHttpUrl: isAllowedGithubToolHttpUrl,
    reply: () => {},
    saveFile: async () => {}, openUrl: async () => {}, shareText: async () => {},
    fetchRequest: async (url, init) => {
      fallbackHeaderCases.push({ url, authorization: init.headers.Authorization, cookie: init.headers.Cookie, safe: init.headers["X-Test"] });
      return { ok: true, status: 200, statusText: "OK", headers: { forEach() {} }, text: async () => "ok", arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
}
assert.equal(fallbackHeaderCases.length, 3);
for (const i of [0, 1]) {
  assert.equal(fallbackHeaderCases[i].authorization, undefined, "fallback never forwards Authorization to raw/CDN origins");
  assert.equal(fallbackHeaderCases[i].cookie, undefined, "fallback never forwards Cookie to raw/CDN origins");
}
assert.equal(fallbackHeaderCases[2].authorization, "token synthetic-never-real", "the exact GitHub API origin retains its required Authorization header");
assert.equal(fallbackHeaderCases[2].cookie, undefined, "even the API fallback never forwards caller Cookie values");
assert.ok(fallbackHeaderCases.every((item) => item.safe === "safe"), "non-sensitive headers are preserved");

const unauthorized = await exerciseConnect({ userStatus: 401 });
assert.deepEqual(unauthorized.requests.map((r) => new URL(r.url).pathname), ["/user"], "401 stops before any persistence or repository request");
assert.equal(unauthorized.events.some((e) => e[0] === "secure-write"), false, "401 candidate is never written to secure storage");
assert.equal(unauthorized.storedSecrets.has("unzipgit_token"), false);
assert.equal(unauthorized.fallbackRequests.length, 0, "HTTP 401 is final and never retried through RN fetch");
assert.equal(unauthorized.elements.get("cnToken").value, unauthorized.enteredToken, "401 retains the candidate in the input for retry");
assert.equal(unauthorized.elements.get("connect").classList.contains("hidden"), false, "401 leaves the connect screen ready for retry");

for (const userStatus of [403, 429]) {
  const rejected = await exerciseConnect({ userStatus });
  assert.deepEqual(rejected.requests.map((r) => new URL(r.url).pathname), ["/user"], `HTTP ${userStatus} stops before persistence and repository loading`);
  assert.equal(rejected.fallbackRequests.length, 0, `HTTP ${userStatus} is never retried through RN fetch`);
  assert.equal(rejected.events.some((e) => e[0] === "secure-write"), false, `HTTP ${userStatus} candidate is never persisted`);
  assert.equal(rejected.elements.get("cnToken").value, rejected.enteredToken, `HTTP ${userStatus} preserves the input candidate`);
}

const timedOut = await exerciseConnect({ timeout: true, fallbackUserStatus: 503 });
assert.deepEqual(timedOut.requests.map((r) => new URL(r.url).pathname), ["/user"], "native timeout stops before save and repository loading");
assert.equal(timedOut.events.some((e) => e[0] === "secure-write"), false, "timeout is not mistaken for bad credentials or saved state");
assert.equal(timedOut.storedSecrets.has("unzipgit_token"), false);
assert.deepEqual(timedOut.fallbackRequests.map((r) => new URL(r.url).pathname), ["/user"], "a native timeout gets only one bounded, idempotent verification fallback");
assert.equal(timedOut.elements.get("cnToken").value, timedOut.enteredToken, "timeout retains the candidate for retry");
assert.equal(timedOut.elements.get("connect").classList.contains("hidden"), false, "if both transports fail, connect remains ready for retry");

const timeoutRecovered = await exerciseConnect({ timeout: true });
assert.deepEqual(timeoutRecovered.fallbackRequests.map((r) => new URL(r.url).pathname), ["/user"], "native timeout reaches the one allowed RN /user fallback");
assert.equal(timeoutRecovered.storedSecrets.get("unzipgit_token"), timeoutRecovered.syntheticCandidate, "a successful RN fallback after native timeout restores login and saves only after HTTP success");
assert.match(timeoutRecovered.elements.get("acct").textContent, /Аккаунт: verified-owner · репозиториев: 1/, "timeout recovery reaches the ordinary owner/repositories UI");

const bothTimedOut = await exerciseConnect({ timeout: true, fallbackNeverSettles: true });
assert.deepEqual(bothTimedOut.fallbackRequests.map((r) => new URL(r.url).pathname), ["/user"], "native timeout is followed by exactly one fallback attempt");
assert.ok(bothTimedOut.events.some((e) => e[0] === "fallback-abort"), "fallback deadline aborts the stalled synthetic RN request");
assert.equal(bothTimedOut.events.some((e) => e[0] === "secure-write"), false, "two transport timeouts do not reach secure storage");
assert.equal(bothTimedOut.elements.get("cnToken").value, bothTimedOut.enteredToken, "both timeouts preserve the candidate for retry");
assert.equal(bothTimedOut.elements.get("connect").classList.contains("hidden"), false, "both timeouts return to the connect form");

const legacyFallback = await exerciseConnect({ nativeUserTransportError: true });
assert.deepEqual(legacyFallback.requests.map((r) => new URL(r.url).pathname), ["/user", "/user/repos"], "the new native bridge is still attempted first");
assert.deepEqual(legacyFallback.fallbackRequests.map((r) => new URL(r.url).pathname), ["/user"], "only v255's supported /user verification request falls back to RN fetch");
assert.equal(legacyFallback.fallbackRequests[0].authorization, `token ${legacyFallback.syntheticCandidate}`, "candidate token and prefix are preserved without logging");
assert.equal(legacyFallback.storedSecrets.get("unzipgit_token"), legacyFallback.syntheticCandidate, "successful fallback validates and securely saves the explicit candidate");
assert.match(legacyFallback.elements.get("acct").textContent, /Аккаунт: verified-owner · репозиториев: 1/, "fallback success completes the ordinary owner/repository UX without an extra confirmation");
assert.ok(legacyFallback.messages.some((m) => m.type === "secretSet" && m.name === "unzipgit_token"), "fallback does not bypass SecureStore or the postMessage storage bridge");

const transportFailed = await exerciseConnect({ nativeUserTransportError: true, fallbackTransportFailure: true, previousCredential: "previous-synthetic-credential" });
assert.equal(transportFailed.fallbackRequests.length, 1, "a native DNS error gets only one bounded fallback");
assert.equal(transportFailed.events.some((e) => e[0] === "secure-write"), false, "DNS/transport failure does not reach secure storage");
assert.equal(transportFailed.storedSecrets.get("unzipgit_token"), "previous-synthetic-credential", "DNS/transport failure leaves the previous credential unchanged");
assert.equal(transportFailed.elements.get("cnToken").value, transportFailed.enteredToken, "DNS/transport failure preserves the entered candidate");

const failedReadback = await exerciseConnect({ saveReadback: false, previousCredential: "previous-synthetic-credential" });
assert.deepEqual(failedReadback.requests.map((r) => new URL(r.url).pathname), ["/user"], "failed secure-store read-back blocks owner/repository transition");
assert.match(failedReadback.elements.get("cnErr").textContent, /защищённом хранилище/i, "UI shows the secure persistence failure instead of claiming login succeeded");
assert.equal(failedReadback.elements.get("main").classList.contains("hidden"), true);
assert.equal(failedReadback.elements.get("connect").classList.contains("hidden"), false, "failed storage verification leaves the connect form ready for retry");
assert.equal(failedReadback.elements.get("busy").classList.contains("hidden"), true, "read-back failure clears the progress spinner");
assert.equal(failedReadback.elements.get("cnToken").value, failedReadback.enteredToken, "failed storage verification preserves the entered candidate");
assert.equal(failedReadback.storedSecrets.get("unzipgit_token"), "previous-synthetic-credential", "mock vault rollback preserves the previous credential when read-back fails");
const failedReadbackRequest = failedReadback.messages.find((m) => m.type === "secretSet");
const failedReadbackCorrelation = failedReadbackRequest.id;
assert.ok(failedReadback.diagnostics.includes(`secretSet.native.stage=readback_mismatch correlation=${failedReadbackCorrelation}`), "mock storage failure is correlated to the native read-back stage");
assert.ok(failedReadback.diagnostics.includes(`secretSet.response.begin result=failure correlation=${failedReadbackCorrelation}`), "the host reports a correlated negative storage response after failed read-back");
assert.ok(failedReadback.diagnostics.includes(`webview.secretSet_reply_failure correlation=${failedReadbackCorrelation}`), "the WebView acknowledges the correlated negative host response");

const providerFailure = await exerciseConnect({ saveReadback: false, saveFailureStage: "provider_error", sessionOnlyChoice: true });
assert.ok(providerFailure.events.some((e) => e[0] === "session-consent" && e[1] === "keystore_unavailable"), "ProviderException is mapped to a useful Keystore/session-only reason without exposing its message");
assert.deepEqual(providerFailure.requests.map((r) => new URL(r.url).pathname), ["/user", "/user/repos"], "explicit session-only consent recovers login after a provider error");
assert.equal(providerFailure.sessionVault.get("unzipgit_token"), providerFailure.syntheticCandidate, "provider failure fallback remains in memory only");
assert.equal(providerFailure.storedSecrets.get("unzipgit_token"), undefined, "provider error does not falsely claim that the native vault persisted the token");
const keystoreFailure = await exerciseConnect({ saveReadback: false, saveFailureStage: "keystore_error", previousCredential: "previous-synthetic-credential" });
assert.deepEqual(keystoreFailure.requests.map((r) => new URL(r.url).pathname), ["/user"], "a native Keystore failure blocks account/repository activation");
const keystoreFailureRequest = keystoreFailure.messages.find((m) => m.type === "secretSet");
assert.ok(keystoreFailure.diagnostics.includes(`secretSet.native.stage=keystore_error correlation=${keystoreFailureRequest.id}`), "native Keystore failure is classified at a correlated fixed safe stage");
assert.ok(keystoreFailure.events.some((e) => e[0] === "session-consent" && e[1] === "keystore_unavailable"), "Keystore failure is mapped to a user-readable cause without exception text");
assert.equal(keystoreFailure.storedSecrets.get("unzipgit_token"), "previous-synthetic-credential", "Keystore failure preserves the previous active token");
assert.equal(keystoreFailure.elements.get("busy").classList.contains("hidden"), true, "Keystore failure clears the progress spinner");

const rollbackFailed = await exerciseConnect({ saveReadback: false, rollbackSucceeds: false, previousCredential: "previous-synthetic-credential" });
assert.equal(rollbackFailed.requests.length, 1, "an unverified rollback still stops before repository loading");
const rollbackRequest = rollbackFailed.messages.find((m) => m.type === "secretSet");
assert.ok(rollbackFailed.diagnostics.includes(`secretSet.native.stage=rollback_failed correlation=${rollbackRequest.id}`), "the fixed native stage records a correlated unverified rollback");
assert.ok(rollbackFailed.diagnostics.includes(`secretSet.response.begin result=failure correlation=${rollbackRequest.id}`), "the host keeps a correlated negative storage response when rollback fails");
assert.match(rollbackFailed.elements.get("cnErr").textContent, /не подтвердило восстановление предыдущего значения/i, "the connect UI warns that old-token restoration is unverified");
assert.doesNotMatch(rollbackFailed.elements.get("cnErr").textContent, /активный токен не изменён/i, "the UI does not falsely claim the previous persisted token is intact");
assert.equal(rollbackFailed.storedSecrets.get("unzipgit_token"), rollbackFailed.syntheticCandidate, "the synthetic failed rollback is explicitly modeled as uncertain persisted state, not successful restoration");

const foreignDiagnostics = [];
let foreignSecretWrites = 0;
let foreignReplies = 0;
const foreignOnMessage = createGithubToolOnMessage(
  () => "file:///android_asset/github-tool/repos.html",
  (event) => routeGithubToolMessage(event, {
    native: { async secretSet() { foreignSecretWrites += 1; return true; } },
    parseMessage: createGithubToolMessageParser((stage) => foreignDiagnostics.push(stage)),
    isAllowedHttpUrl: isAllowedGithubToolHttpUrl,
    reply: () => { foreignReplies += 1; },
    saveFile: async () => {}, openUrl: async () => {}, shareText: async () => {},
    stage: (stage) => foreignDiagnostics.push(stage),
  }),
  (stage) => foreignDiagnostics.push(stage),
);
await foreignOnMessage({
  nativeEvent: {
    url: "https://untrusted.invalid/private?query=synthetic-private-value",
    data: JSON.stringify({ type: "secretSet", id: "lqf8nv0p-a1b2c3d4:c7", name: "unzipgit_token", value: "synthetic-credential-value", repo: "private-repo-marker" }),
  },
});
assert.ok(foreignDiagnostics.includes("rn.onMessage.received eventUrlKind=http_other trackedDocumentTrusted=true eventMatchesTrackedDocument=false messageType=secretSet correlation=lqf8nv0p-a1b2c3d4:c7"), "the callback identifies a foreign HTTP event against the tracked trusted page using enums and a safe correlation id");
assert.ok(foreignDiagnostics.includes("message.parse.rejected trust=denied messageType=secretSet correlation=lqf8nv0p-a1b2c3d4:c7"), "the unchanged production trust filter rejects and correlates a foreign document");
assert.equal(foreignSecretWrites, 0, "foreign-origin messages cannot reach native secretSet");
assert.equal(foreignReplies, 0, "foreign-origin messages receive no host response");
assert.equal(foreignDiagnostics.some((stage) => stage.startsWith("host.message.accepted type=secretSet")), false, "rejected content is not dispatched");
for (const forbidden of ["untrusted.invalid", "private", "synthetic-private-value", "synthetic-credential-value", "private-repo-marker", "Authorization"]) {
  assert.equal(foreignDiagnostics.join("\n").includes(forbidden), false, `foreign-message diagnostics exclude URL and payload data (${forbidden})`);
}

const duplicateTap = await exerciseConnect({ duplicateTap: true });
assert.deepEqual(duplicateTap.requests.map((r) => new URL(r.url).pathname), ["/user", "/user/repos"], "duplicate taps are coalesced by the production connect guard");
assert.equal(duplicateTap.events.filter((e) => e[0] === "secure-write" && e[1] === "unzipgit_token").length, 1, "duplicate taps write the active credential once");

const unmounted = await exerciseConnect({ holdNative: true, unmountBeforeNativeReply: true, previousCredential: "previous-synthetic-credential" });
assert.equal(unmounted.unmounted, true, "scenario drops the production WebView ref before the held native reply");
assert.equal(unmounted.events.some((e) => e[0] === "secure-write"), false, "late response after unmount cannot trigger secure write");
assert.equal(unmounted.storedSecrets.get("unzipgit_token"), "previous-synthetic-credential", "unmount preserves the previous credential");

const sessionDeclined = await exerciseConnect({ saveReadback: false, previousCredential: "previous-synthetic-credential", sessionOnlyChoice: false });
assert.deepEqual(sessionDeclined.requests.map((r) => new URL(r.url).pathname), ["/user"], "declining the session-only option blocks account activation and repository loading");
assert.equal(sessionDeclined.storedSecrets.get("unzipgit_token"), "previous-synthetic-credential", "declining fallback preserves the last secure credential");
assert.equal(sessionDeclined.sessionVault.isSessionOnly(), false, "declining fallback never enables session-only mode");
assert.equal(sessionDeclined.sessionVault.get("unzipgit_token"), "", "declining fallback never activates the candidate in RAM");
assert.ok(sessionDeclined.events.some((e) => e[0] === "session-consent" && e[1] === "storage_unavailable"), "secure-write failure asks the user before RAM-only storage");

const sessionAccepted = await exerciseConnect({ nativeWriterUnavailable: true, sessionOnlyChoice: true });
assert.deepEqual(sessionAccepted.requests.map((r) => new URL(r.url).pathname), ["/user", "/user/repos"], "explicitly accepted session-only mode completes the verified login flow");
assert.equal(sessionAccepted.sessionVault.isSessionOnly(), true, "the host records explicit session-only consent");
assert.equal(sessionAccepted.sessionVault.get("unzipgit_token"), sessionAccepted.syntheticCandidate, "the candidate exists only in the process-memory vault");
assert.equal(sessionAccepted.storedSecrets.has("unzipgit_token"), false, "session-only mode never writes the candidate to the native secure store");
assert.equal(sessionAccepted.events.some((e) => e[0] === "secure-write"), false, "no native write is attempted when the secure module is unavailable");
assert.ok(sessionAccepted.diagnostics.some((stage) => stage.startsWith("secretSet.native.unavailable correlation=")), "native store unavailability has a distinct correlated fixed host diagnostic");
assert.equal(sessionAccepted.elements.get("busy").classList.contains("hidden"), true, "accepted session-only fallback clears the progress spinner");
let sessionReadReply = "";
await routeGithubToolMessage({ nativeEvent: { url: "file:///android_asset/github-tool/tokens.html", data: JSON.stringify({ type: "secretGet", id: "next-document:1", documentId: "next-document", name: "unzipgit_token" }) } }, {
  native: { async secretGet() { return "persisted-old-token"; } },
  sessionVault: sessionAccepted.sessionVault,
  parseMessage: createGithubToolMessageParser(() => {}),
  isAllowedHttpUrl: isAllowedGithubToolHttpUrl,
  reply: (_id, value) => { sessionReadReply = value; },
  saveFile: async () => {}, openUrl: async () => {}, shareText: async () => {},
});
assert.equal(sessionReadReply, sessionAccepted.syntheticCandidate, "session vault takes precedence over any older persisted value across packaged document loads");

const migrationVault = createGithubToolSessionSecretVault();
let migrationWriteCount = 0;
let migrationReply = "";
const migrationNative = {
  async secretGet() { return ""; },
  async secretSetResult(_name, value) {
    migrationWriteCount += 1;
    return migrationWriteCount === 1
      ? { saved: false, stage: "readback_mismatch" }
      : { saved: value === "synthetic-legacy-candidate", stage: "verified" };
  },
};
const migrationDeps = (reply) => ({
  native: migrationNative,
  sessionVault: migrationVault,
  confirmSessionOnly: async () => false,
  parseMessage: createGithubToolMessageParser(() => {}),
  isAllowedHttpUrl: isAllowedGithubToolHttpUrl,
  reply: (_id, value) => { reply(value); },
  saveFile: async () => {}, openUrl: async () => {}, shareText: async () => {},
});
await routeGithubToolMessage({ nativeEvent: { url: "file:///android_asset/github-tool/repos.html", data: JSON.stringify({
  type: "secretSet", id: "legacy-doc-a:1", documentId: "legacy-doc-a", name: "unzipgit_token", value: "synthetic-legacy-candidate", migration: true,
}) } }, migrationDeps((value) => { migrationReply = value; }));
assert.equal(migrationReply, "0:storage_unavailable", "declined migration does not activate or persist an unverified candidate");
assert.equal(migrationVault.getPending("unzipgit_token"), "synthetic-legacy-candidate", "unverified migration data remains only in the process-memory pending vault");
assert.equal(migrationVault.get("unzipgit_token"), "", "a declined migration candidate is not exposed as an active token");
let migrationReadReply = "";
await routeGithubToolMessage({ nativeEvent: { url: "file:///android_asset/github-tool/tokens.html", data: JSON.stringify({
  type: "secretGet", id: "legacy-doc-b:1", documentId: "legacy-doc-b", name: "unzipgit_token",
}) } }, migrationDeps((value) => { migrationReadReply = value; }));
assert.equal(migrationWriteCount, 2, "a new packaged document retries secure migration once without reading any legacy plaintext copy");
assert.equal(migrationReadReply, "synthetic-legacy-candidate", "successful re-migration hydrates the next page");
assert.equal(migrationVault.hasPending("unzipgit_token"), false, "pending RAM candidate is cleared after confirmed secure save");

const lateSuccess = await exerciseConnect({ secretWriteDelayMs: 35, secretWriteTimeoutMs: 5, sessionOnlyChoice: true });
await new Promise((resolve) => setTimeout(resolve, 50));
assert.deepEqual(lateSuccess.requests.map((r) => new URL(r.url).pathname), ["/user"], "late native success cannot complete the previously failed connect flow");
const lateRequest = lateSuccess.messages.find((m) => m.type === "secretSet");
assert.ok(lateSuccess.diagnostics.includes(`secretSet.native.late_settled_success correlation=${lateRequest.id}`), `late success is recorded with the same safe correlation id; stages=${lateSuccess.diagnostics.join(",")}`);
assert.equal(lateSuccess.secretUpdateNotifications.length, 0, "late success cannot activate or hydrate an unverified document");
assert.equal(lateSuccess.sessionVault.get("unzipgit_token"), "", "no session-only value is created when timeout is ambiguous");

const timedOutSecretWrite = await exerciseConnect({ secretWriteNeverSettles: true, secretWriteTimeoutMs: 5, sessionOnlyChoice: true });
assert.deepEqual(timedOutSecretWrite.requests.map((r) => new URL(r.url).pathname), ["/user"], "a timed-out native write fails closed and does not activate the account");
const timedOutRequest = timedOutSecretWrite.messages.find((m) => m.type === "secretSet");
assert.ok(timedOutSecretWrite.diagnostics.includes(`secretSet.native.timeout correlation=${timedOutRequest.id}`), "native write timeout is visible at the fixed correlated diagnostic phase");
assert.equal(timedOutSecretWrite.sessionVault.get("unzipgit_token"), "", "an ambiguous in-flight write cannot be labeled session-only");
assert.equal(timedOutSecretWrite.events.some((e) => e[0] === "session-consent" || e[0] === "session-mode-enabled"), false, "session-only consent is not requested while native commit state is ambiguous");
assert.equal(timedOutSecretWrite.secretUpdateNotifications.length, 0, "timed-out write does not silently rehydrate a WebView");
assert.equal(timedOutSecretWrite.elements.get("busy").classList.contains("hidden"), true, "native write timeout clears the progress spinner");

// Use the injected production bridge but scale its timer only in the fixture.
// This isolates WebView waiting behavior from the real 90-second product timeout.
const fastBridge = injectedBridge.replaceAll("90000", "5").replace("Math.max(1000, Math.min(Number(timeoutMs)", "Math.max(1, Math.min(Number(timeoutMs)");
const bridgeMissingContext = vm.createContext({ Promise, Date, Math, JSON, Object, String, Number, Array, RegExp, Error, setTimeout, clearTimeout, window: {} });
vm.runInContext(fastBridge, bridgeMissingContext);
const bridgeMissingResult = await vm.runInContext("window.AndroidInterface.secretSet('unzipgit_token','synthetic-bridge-missing-value')", bridgeMissingContext);
assert.equal(bridgeMissingResult, false, "a missing ReactNativeWebView bridge fails closed without activating the candidate");

const bridgeFailureDiagnostics = [];
let rejectedBridgeNativeWrites = 0;
const bridgeTimeoutContext = vm.createContext({ Promise, Date, Math, JSON, Object, String, Number, Array, RegExp, Error, setTimeout, clearTimeout, window: {} });
const bridgeTimeoutOnMessage = createGithubToolOnMessage(
  () => "file:///android_asset/github-tool/repos.html",
  (event) => routeGithubToolMessage(event, {
    native: { async secretSetResult() { rejectedBridgeNativeWrites += 1; return { saved: true, stage: "verified" }; } },
    parseMessage: createGithubToolMessageParser((stage) => bridgeFailureDiagnostics.push(stage)),
    isAllowedHttpUrl: isAllowedGithubToolHttpUrl,
    reply: () => {}, saveFile: async () => {}, openUrl: async () => {}, shareText: async () => {},
    stage: (stage) => bridgeFailureDiagnostics.push(stage),
  }),
  (stage) => bridgeFailureDiagnostics.push(stage),
);
bridgeTimeoutContext.window.ReactNativeWebView = {
  postMessage(raw) {
    void bridgeTimeoutOnMessage({ nativeEvent: { url: "https://untrusted.invalid/private", data: raw } });
  },
};
vm.runInContext(fastBridge, bridgeTimeoutContext);
const bridgeTimeoutResult = await vm.runInContext("window.AndroidInterface.secretSet('unzipgit_token','synthetic-bridge-timeout-value')", bridgeTimeoutContext);
assert.equal(bridgeTimeoutResult, false, "a callback rejected before host response expires as a WebView bridge timeout and fails closed");
assert.ok(bridgeFailureDiagnostics.some((stage) => stage.startsWith("message.parse.rejected trust=denied messageType=secretSet correlation=")), "bridge timeout is distinguished from native storage by safe parser enums and correlation");
assert.equal(bridgeFailureDiagnostics.some((stage) => stage.startsWith("secretSet.native.begin")), false, "a rejected callback never enters native secretSet");
assert.equal(rejectedBridgeNativeWrites, 0, "an untrusted event cannot reach the native store");

console.log("PASS: production GitHub connect UI → injected WebView postMessage → production host router → mocked AibGithubTool Kotlin-module contract; synthetic success/read-back, bridge missing/timeout, native store unavailable, Keystore/read-back/rollback, late response/cancel, spinner and diagnostics; no live HTTP or real credentials");
