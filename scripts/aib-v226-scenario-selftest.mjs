#!/usr/bin/env node
/**
 * v226 repeat-audit behavioral scenarios.
 * Executes selected production TypeScript modules via TypeScript transpilation and
 * deterministic adapters/mocks. No Android, Termux service, provider API, or llama
 * native inference is exercised by this test.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const cache = new Map();
const fakeLogger = {
  add() {}, markModelRequest() {}, markModelResponse() {},
  subscribe() { return () => {}; }, getEntries() { return []; },
};
const fileStore = new Map();
const dirStore = new Set(["file:///aib-doc"]);
const llamaState = { initCalls: 0, releaseCalls: 0, stopCalls: 0, nextCompletion: null, pendingCompletionResolve: null };
const axiosState = { calls: [], responder: null };
const termuxState = { calls: [], responder: null };
let fixtureSharedRoot = "";
const storageState = { secure: new Map(), async: new Map(), getError: null, setErrors: 0, setCalls: 0 };
const evidenceState = { dirs: new Set(), files: new Map() };
const githubState = { module: null, requests: [], responder: null, token: "mock-github-token" };
const nativeAccelState = { module: null };
const fakeAsyncStorage = {
  async getItem(key) { return storageState.async.get(key) ?? null; },
  async setItem(key, value) { storageState.async.set(key, String(value)); },
};
const fakeSecureStore = {
  async getItemAsync(key) { if (storageState.getError) throw storageState.getError; return storageState.secure.get(key) ?? null; },
  async setItemAsync(key, value) {
    storageState.setCalls++;
    if (storageState.setErrors > 0) { storageState.setErrors--; throw new Error("mock SecureStore unavailable"); }
    storageState.secure.set(key, String(value));
  },
};

function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
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
    if (request === "./persistent-logger") return { persistentLogger: fakeLogger };
    if (request.endsWith("/lib/foreground-task")) return { startForegroundTask: () => "fg-test", endForegroundTask() {} };
    if (request === "axios") return axiosMock;
    if (request === "expo-file-system") return { File: FakeFile, Directory: FakeDirectory, Paths: { document: "file:///aib-doc" } };
    if (request === "expo-file-system/legacy") return fakeLegacyFS;
    if (request === "@react-native-async-storage/async-storage") return fakeAsyncStorage;
    if (request === "expo-secure-store") return fakeSecureStore;
    if (request === "llama.rn") return { initLlama: fakeInitLlama };
    if (request === "./termux-bridge") return { getTermuxNative: () => ({}) };
    if (request === "./writable-path-policy" && file.endsWith("/lib/active-project.ts")) {
      const sharedRoot = fixtureSharedRoot;
      return { AI_BUILDER_SHARED_ROOT: sharedRoot, isWithinSharedAppRoot(candidate) { const resolved = path.resolve(String(candidate || "")); return !!sharedRoot && resolved.startsWith(`${path.resolve(sharedRoot)}/`); } };
    }
    if (request.includes("productionProviderTransport")) {
      if (file.endsWith("/lib/custom-provider.ts")) {
        const securedProviderFetch = async (_provider, route, requestPath, init = {}) => {
          const url = `${String(route?.baseUrl || "")}${requestPath}`;
          const args = [url, init.body, { headers: init.headers, signal: init.signal }];
          axiosState.calls.push(args);
          if (!axiosState.responder) throw new Error("axios responder not set");
          const result = await axiosState.responder(...args);
          return new Response(JSON.stringify(result?.data ?? result ?? {}), { status: Number(result?.status ?? 200), headers: result?.headers ?? {} });
        };
        return { securedProviderFetch, probeProviderModelsCredential: async () => new Response("{}") };
      }
      const securedProviderFetch = async (_provider, _route, requestPath, init = {}) => globalThis.fetch(`https://openrouter.test/${requestPath}`, init);
      return {
        securedProviderFetch,
        probeOpenRouterCredential: async (_credential, signal) => globalThis.fetch("https://openrouter.test/key", { method: "GET", signal }),
      };
    }
    if (request === "react-native") {
      const nativeModules = { TermuxBridge: fakeTermuxNative };
      Object.defineProperty(nativeModules, "AibGithubTool", { get: () => githubState.module });
      Object.defineProperty(nativeModules, "AibNativeAccel", { get: () => nativeAccelState.module });
      return { Platform: { OS: "android" }, NativeModules: nativeModules, NativeEventEmitter: FakeNativeEventEmitter };
    }
    const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
    return resolved ? loadTs(resolved) : requireFrom(file, request);
  };
  const source = fs.readFileSync(file, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}
function requireFrom(file, request) {
  return createRequire(file)(request);
}

class FakeDirectory {
  constructor(parent, name) {
    const base = typeof parent === "string" ? parent : parent?.uri || String(parent);
    this.uri = `${String(base).replace(/\/$/, "")}/${name}`;
  }
  get exists() { return dirStore.has(this.uri); }
  create() { dirStore.add(this.uri); }
}
class FakeFile {
  constructor(parent, name) {
    const base = typeof parent === "string" ? parent : parent?.uri || String(parent);
    this.uri = name === undefined ? base : `${String(base).replace(/\/$/, "")}/${name}`;
    this.name = this.uri.split("/").pop();
  }
  get exists() { return fileStore.has(this.uri); }
  get size() { return fileStore.get(this.uri)?.size || 0; }
  create() { fileStore.set(this.uri, { size: 0, bytes: [0, 0, 0, 0], text: "" }); }
  delete() { fileStore.delete(this.uri); }
  move(dest) {
    fileStore.set(dest.uri, fileStore.get(this.uri));
    fileStore.delete(this.uri);
  }
  open() {
    const item = fileStore.get(this.uri);
    if (!item) throw new Error("ENOENT");
    return { readBytes: (n) => Uint8Array.from(item.bytes.slice(0, n)), close() {} };
  }
  textSync() { return fileStore.get(this.uri)?.text || ""; }
  write(text) {
    const prev = fileStore.get(this.uri) || { size: 0, bytes: [], text: "" };
    fileStore.set(this.uri, { ...prev, text: String(text) });
  }
  static async downloadFileAsync() { throw new Error("network disabled in deterministic test"); }
}
class FakeNativeEventEmitter {
  addListener() { return { remove() {} }; }
}
const fakeLegacyFS = {
  documentDirectory: "file:///evidence-doc/",
  EncodingType: { Base64: "base64", UTF8: "utf8" },
  async makeDirectoryAsync(uri) { evidenceState.dirs.add(uri); },
  async copyAsync({ from, to }) {
    const item = fileStore.get(from);
    if (!item) throw new Error("ENOENT");
    fileStore.set(to, { ...item });
  },
  async readAsStringAsync(uri) { return fileStore.get(uri)?.text || ""; },
  async writeAsStringAsync(uri, value, options = {}) {
    evidenceState.files.set(uri, { value: String(value), encoding: options.encoding });
    fileStore.set(uri, { size: 0, bytes: [], text: String(value) });
  },
};
function installGithubMock(responder, token = "mock-github-token") {
  githubState.requests = [];
  githubState.responder = responder;
  githubState.token = token;
  githubState.module = {
    async secretGet(key) { assert.equal(key, "unzipgit_token"); return githubState.token; },
    async httpRequest(payload) {
      const request = JSON.parse(payload);
      githubState.requests.push(request);
      const response = await githubState.responder(request);
      const status = response?.status ?? 200;
      return JSON.stringify({ ok: status >= 200 && status < 300, status, body: JSON.stringify(response?.body ?? null), error: response?.error });
    },
  };
}
async function fakeInitLlama() {
  llamaState.initCalls++;
  return {
    async completion() {
      if (llamaState.nextCompletion) return llamaState.nextCompletion();
      return { text: " local answer " };
    },
    async stopCompletion() {
      llamaState.stopCalls++;
      const settle = llamaState.pendingCompletionResolve;
      llamaState.pendingCompletionResolve = null;
      settle?.({ text: "" });
    },
    async initMultimodal() { return false; },
    async releaseMultimodal() {},
    async release() { llamaState.releaseCalls++; },
  };
}
const fakeTermuxNative = {
  async runCommand(command, workdir, timeoutMs) {
    termuxState.calls.push({ command, workdir, timeoutMs });
    if (termuxState.responder) return termuxState.responder(command, workdir, timeoutMs);
    return { commandId: "native-test-1", stdout: "tail-without-newline", stderr: "", exitCode: 0, timedOut: false, command, workdir, timeoutMs };
  },
  async isTermuxInstalled() { return true; },
  async hasRunCommandPermission() { return true; },
};
const axiosMock = {
  isAxiosError: (e) => !!e?.__axiosError,
  async post(...args) {
    axiosState.calls.push(args);
    if (!axiosState.responder) throw new Error("axios responder not set");
    return axiosState.responder(...args);
  },
};

let passed = 0;
const failed = [];
async function scenario(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed.push({ name, error: e instanceof Error ? e.stack || e.message : String(e) });
    console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const loggerModule = { persistentLogger: fakeLogger };
void loggerModule;
const identity = { appVersion: "1.8.45", runtimeVersion: "1", rootfsVersion: "1", toolchainVersion: "1", schemaVersion: 1 };
const { RuntimeTaskGate } = loadTs(path.join(root, "core/runtime/RuntimeTaskGate.ts"));
const { RuntimeJournal } = loadTs(path.join(root, "core/runtime/RuntimeJournal.ts"));
const { RuntimeTransaction } = loadTs(path.join(root, "core/runtime/RuntimeTransaction.ts"));
const { RestoreTransaction } = loadTs(path.join(root, "core/backup/RestoreTransaction.ts"));

await scenario("Restore rejects unsupported manifest format before mutation (actual adapter + transaction)", async () => {
  const manifestPath = "/backup/manifest.json";
  const calls = [];
  let manifestText = JSON.stringify({ format: 99, createdAt: 1, identity, scope: "projects", paths: ["/evil"], digest: "abc" });
  const env = {
    async exists(p) { return p === manifestPath; },
    async read() { return manifestText; },
    async mkdir() {}, async write() {},
    async exec(command) {
      calls.push(command);
      if (command.includes(">/dev/null && sha256sum")) return { exitCode: 0, stdout: "abc  archive.tar.gz\n", stderr: "" };
      if (command.startsWith("tar -tzf")) return { exitCode: 0, stdout: "projects/a.txt\n", stderr: "" };
      if (command.startsWith("wc -c")) return { exitCode: 0, stdout: "128\n", stderr: "" };
      return { exitCode: 0, stdout: "1\n", stderr: "" };
    },
  };
  const { TermuxBackupAdapter } = loadTs(path.join(root, "core/backup/TermuxBackupAdapter.ts"));
  const adapter = new TermuxBackupAdapter(env, { root: "/termux/home" });
  const store = { raw: null, async read() { return this.raw; }, async write(x) { this.raw = x; } };
  const tx = new RuntimeTransaction(new RuntimeTaskGate(), new RuntimeJournal(store), 0);
  const restore = new RestoreTransaction(tx, adapter, identity, () => ["/termux/home/projects"]);
  const result = await restore.inspect("/backup");
  assert.equal(result.ok, false, "format 99 manifest must fail closed");
  assert.match(result.error, /BACKUP_MANIFEST_INVALID/);
  const restoreResult = await restore.restore("/backup");
  assert.equal(restoreResult.ok, false, "restore must return a safe error rather than enter a transaction");
  manifestText = "{broken json";
  const malformed = await restore.inspect("/backup");
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /BACKUP_MANIFEST_INVALID/);
  manifestText = JSON.stringify({ format: 2, createdAt: 1, identity, scope: "projects", homeRoot: "/termux/home", paths: ["/termux/home/projects"], digest: "wrong" });
  const badDigest = await restore.inspect("/backup");
  assert.equal(badDigest.ok, false);
  assert.match(badDigest.error, /DIGEST_MISMATCH/);
  assert.equal(calls.some((c) => c.startsWith("tar -xzf")), false);
});

await scenario("Restore permits a verified legacy archive with genuinely absent manifest and uses canonical scope", async () => {
  const calls = [];
  const env = {
    async exists() { return false; }, async read() { throw new Error("not found"); }, async mkdir() {}, async write() {},
    async exec(command) {
      calls.push(command);
      if (command.includes(">/dev/null && sha256sum")) return { exitCode: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  archive.tar.gz\n", stderr: "" };
      if (command.includes("| wc -l")) return { exitCode: 0, stdout: "2\n", stderr: "" };
      if (command.includes("| wc -c")) return { exitCode: 0, stdout: "128\n", stderr: "" };
      if (command.startsWith("tar -tvzf")) return { exitCode: 0, stdout: "-rw-r--r-- user/group 1 2026-10-02 10:00 ./projects/a.txt\n-rw-r--r-- user/group 1 2026-10-02 10:00 ./workspace/readme.txt\n", stderr: "" };
      if (command.startsWith("tar -tzf")) return { exitCode: 0, stdout: "projects/a.txt\nworkspace/readme.txt\n", stderr: "" };
      if (command.startsWith("wc -c")) return { exitCode: 0, stdout: "128\n", stderr: "" };
      if (command.includes("grep")) return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "1\n", stderr: "" };
    },
  };
  const { TermuxBackupAdapter } = loadTs(path.join(root, "core/backup/TermuxBackupAdapter.ts"));
  const adapter = new TermuxBackupAdapter(env, { root: "/termux/home" });
  const store = { raw: null, async read() { return this.raw; }, async write(x) { this.raw = x; } };
  const restore = new RestoreTransaction(new RuntimeTransaction(new RuntimeTaskGate(), new RuntimeJournal(store), 0), adapter, identity, (s) => s === "projects" ? ["/termux/home/projects"] : ["/termux/home/projects", "/termux/home/workspace"]);
  const result = await restore.inspect("/backup");
  assert.ok("manifest" in result, JSON.stringify(result));
  assert.deepEqual(result.impactPaths, ["/termux/home/projects", "/termux/home/workspace"]);
  assert.deepEqual(result.manifest.paths, ["/termux/home/projects", "/termux/home/workspace"]);
});

await scenario("Restore sessions scope ignores archive-controlled paths and unknown scope is rejected", async () => {
  let manifestScope = "sessions";
  const adapter = {
    async inspect() { return { ok: true, bytes: 7, files: 1, digest: "workspace-digest" }; },
    async readManifest() { return { format: 2, createdAt: 1, identity, scope: manifestScope, homeRoot: "/attacker", paths: ["/etc"], digest: "workspace-digest", fileCount: 1, totalBytes: 7 }; },
  };
  const store = { raw: null, async read() { return this.raw; }, async write(x) { this.raw = x; } };
  const restore = new RestoreTransaction(new RuntimeTransaction(new RuntimeTaskGate(), new RuntimeJournal(store), 0), adapter, identity, (scope) => scope === "sessions" ? ["/home/aib/workspace"] : []);
  const workspace = await restore.inspect("/archive");
  assert.ok("manifest" in workspace, JSON.stringify(workspace));
  assert.deepEqual(workspace.impactPaths, ["/home/aib/workspace"]);
  assert.deepEqual(workspace.manifest.paths, ["/etc"], "archive paths are retained as metadata but excluded from mutation scope");
  manifestScope = "secrets";
  const unknown = await restore.inspect("/archive");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /INVALID_BACKUP_SCOPE/);
});

await scenario("BackupManager create verifies successful snapshot and rejects incomplete archive before manifest write", async () => {
  const { BackupManager } = loadTs(path.join(root, "core/backup/BackupManager.ts"));
  const store = { raw: null, async read() { return this.raw; }, async write(x) { this.raw = x; } };
  const gate = new RuntimeTaskGate();
  let inspection = { ok: true, bytes: 12, files: 2, digest: "digest-ok" };
  const writes = [];
  const adapter = {
    async ensureDir() {}, async snapshot(paths, destination) { this.lastSnapshot = { paths, destination }; },
    async inspect() { return inspection; }, async restore() {},
    async writeManifest(destination, manifest) { writes.push({ destination, manifest }); },
  };
  const home = { root: "/home/aib", metadata: "/home/aib/.ai-builder/metadata", projects: "/home/aib/projects", workspace: "/home/aib/workspace", containers: "/home/aib/containers", toolchains: "/home/aib/toolchains", sdk: "/home/aib/sdk", cache: "/home/aib/cache", logs: "/home/aib/logs", backups: "/home/aib/backups" };
  const manager = new BackupManager(home, identity, adapter, gate, new RuntimeJournal(store));
  const result = await manager.create("projects", "/backup/out");
  assert.equal(result.scope, "projects");
  assert.equal(result.digest, "digest-ok");
  assert.deepEqual(adapter.lastSnapshot.paths, [home.projects]);
  assert.equal(writes.length, 1);
  inspection = { ok: false, bytes: 0, files: 0, error: "ARCHIVE_TRUNCATED" };
  await assert.rejects(manager.create("projects", "/backup/bad"), /ARCHIVE_TRUNCATED/);
  assert.equal(writes.length, 1, "incomplete archive must not receive a valid manifest");
});

await scenario("Restore success and partial extraction failure preserve prior active files through actual rollback transaction", async () => {
  async function runRestore(shouldFail) {
    const state = { projects: "old-project-state" };
    const snapshots = new Map();
    let failOnce = shouldFail;
    const adapter = {
      async ensureDir() {},
      async inspect(source) { return source === "/incoming" || snapshots.has(source) ? { ok: true, bytes: 3, files: 1, digest: "archive-digest" } : { ok: false, bytes: 0, files: 0, error: "not found" }; },
      async readManifest() { return { format: 2, createdAt: 1, identity, scope: "projects", homeRoot: "/untrusted/archive-root", paths: ["/etc/shadow"], digest: "archive-digest", fileCount: 1, totalBytes: 3 }; },
      async snapshot(_paths, destination) { snapshots.set(destination, state.projects); },
      async clear() { state.projects = ""; },
      async restore(source) {
        if (snapshots.has(source)) { state.projects = snapshots.get(source); return; }
        state.projects = "partially-restored";
        if (failOnce) { failOnce = false; throw new Error("simulated partial extraction failure"); }
        state.projects = "new-project-state";
      },
    };
    const store = { raw: null, async read() { return this.raw; }, async write(x) { this.raw = x; } };
    const restore = new RestoreTransaction(new RuntimeTransaction(new RuntimeTaskGate(), new RuntimeJournal(store), 0), adapter, identity, () => ["/home/aib/projects"]);
    return { result: await restore.restore("/incoming", { preBackupDestination: "/recovery/pre-restore" }), state };
  }
  const good = await runRestore(false);
  assert.equal(good.result.ok, true);
  assert.equal(good.state.projects, "new-project-state");
  const failedRestore = await runRestore(true);
  assert.equal(failedRestore.result.ok, false);
  assert.equal(failedRestore.result.rolledBack, true);
  assert.equal(failedRestore.state.projects, "old-project-state", "active data must be restored after partial extraction failure");
});

await scenario("skipPreBackup restore failure never claims rollback it did not perform", async () => {
  const state = { projects: "old" };
  const store = { raw: null, async read() { return this.raw; }, async write(x) { this.raw = x; } };
  const adapter = {
    async inspect() { return { ok: true, bytes: 3, files: 1, digest: "incoming" }; },
    async readManifest() { return { format: 2, createdAt: 1, identity, scope: "projects", homeRoot: "/untrusted", paths: ["/etc/shadow"], digest: "incoming", fileCount: 1, totalBytes: 3 }; },
    async ensureDir() {}, async snapshot() {}, async clear() { state.projects = ""; },
    async restore(source) { if (source === "/incoming") { state.projects = "partial"; throw new Error("partial extraction"); } },
  };
  const restore = new RestoreTransaction(new RuntimeTransaction(new RuntimeTaskGate(), new RuntimeJournal(store), 0), adapter, identity, () => ["/home/aib/projects"]);
  const result = await restore.restore("/incoming", { skipPreBackup: true });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.equal(result.preBackupPath, undefined);
  assert.equal(state.projects, "partial", "without a pre-image the partial state is reported honestly");
});

await scenario("Crash recovery restores verified pre-backup and refuses corrupted pre-image without false rollback label", async () => {
  async function runRecovery(tamper) {
    const state = { projects: "partially-restored-state" };
    const store = { raw: null, async read() { return this.raw; }, async write(x) { this.raw = x; } };
    const journal = new RuntimeJournal(store);
    const adapter = {
      async inspect(source) {
        if (source === "/pre-restore") return { ok: true, bytes: 3, files: 1, digest: tamper ? "changed" : "verified" };
        return { ok: true, bytes: 3, files: 1, digest: "current" };
      },
      async readManifest() { return null; }, async ensureDir() {}, async snapshot() {},
      async clear() { state.projects = ""; },
      async restore(source) { if (source === "/pre-restore") state.projects = "original-state"; },
    };
    const transaction = new RuntimeTransaction(new RuntimeTaskGate(), journal, 0);
    const restore = new RestoreTransaction(transaction, adapter, identity, (scope) => scope === "projects" ? ["/home/aib/projects"] : []);
    await journal.begin("backup:restore", {
      phase: "mutate", scope: "projects", preBackupPath: "/pre-restore", preBackupReady: "true",
      preBackupDigest: "verified", preBackupFiles: "1", preBackupBytes: "3",
    });
    const result = await transaction.recoverPending((entry) => restore.recoverInterruptedRestore(entry));
    const entry = (await journal.list())[0];
    return { state, result, entry };
  }
  const recovered = await runRecovery(false);
  assert.equal(recovered.result.recovered, 1);
  assert.equal(recovered.result.failed, 0);
  assert.equal(recovered.state.projects, "original-state");
  assert.equal(recovered.entry.status, "rolled_back");
  const rejected = await runRecovery(true);
  assert.equal(rejected.result.recovered, 0);
  assert.equal(rejected.result.failed, 1);
  assert.equal(rejected.state.projects, "partially-restored-state", "invalid pre-image must not clear active data");
  assert.equal(rejected.entry.status, "failed", "unverified recovery must not be labeled rolled_back");
});

await scenario("Backup digest mismatch and malformed manifest do not become a synthetic valid archive", async () => {
  const { parseManifest, validateManifest } = loadTs(path.join(root, "core/backup/BackupIntegrity.ts"));
  assert.equal(parseManifest({ format: 88, identity, paths: ["/x"] }), null);
  const manifest = { format: 2, createdAt: 1, identity, scope: "projects", homeRoot: "/x", paths: ["/x/projects"], digest: "expected" };
  const check = validateManifest(manifest, identity, { ok: true, files: 1, bytes: 2, digest: "actual" });
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /DIGEST_MISMATCH/);
});

await scenario("Persistent workspace snapshot excludes secret and gitignored files from an actual local tar archive", async () => {
  const { PersistentAIWorkspace } = loadTs(path.join(root, "core/workspace/PersistentAIWorkspace.ts"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v226-workspace-"));
  const home = {
    root: `${temp}/home`, projects: `${temp}/home/projects`, workspace: `${temp}/home/workspace`,
    containers: `${temp}/home/containers`, toolchains: `${temp}/home/toolchains`, sdk: `${temp}/home/sdk`,
    cache: `${temp}/home/cache`, logs: `${temp}/home/logs`, backups: `${temp}/home/backups`, metadata: `${temp}/home/metadata`,
  };
  const project = `${home.projects}/demo`;
  fs.mkdirSync(project, { recursive: true });
  for (const [name, content] of [
    ["README.md", "normal source is included"], [".env", "SECRET=not-for-archive"],
    [".env.local", "TOKEN=not-for-archive"], ["private.pem", "private key"],
    ["api.key", "api key"], ["keystore.p12", "keystore"], ["signing.jks", "signing key"],
    ["local.properties", "sdk.dir=private"],
  ]) fs.writeFileSync(path.join(project, name), content);
  fs.mkdirSync(path.join(project, ".aib-memory"), { recursive: true });
  fs.writeFileSync(path.join(project, ".aib-memory", "notes.json"), "private memory");
  const env = {
    async mkdir(p) { fs.mkdirSync(p, { recursive: true }); },
    async exists(p) { return fs.existsSync(p); },
    async read(p) { return fs.readFileSync(p, "utf8"); },
    async write(p, value) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); },
    getHome() { return home.root; },
    async exec(command, options = {}) {
      const r = spawnSync("/bin/bash", ["-c", command], { cwd: options.cwd, encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
    },
    async spawn(command, options) { return this.exec(command, options); },
  };
  try {
    const workspace = new PersistentAIWorkspace(env, home, { maxSnapshots: 3 });
    const snapshot = await workspace.snapshot("demo", "secret-filter");
    const listing = spawnSync("tar", ["-tzf", snapshot.archivePath], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /README\.md/);
    for (const secret of [".env", ".env.local", "private.pem", "api.key", "keystore.p12", "signing.jks", "local.properties", ".aib-memory"]) {
      assert.doesNotMatch(listing.stdout, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `snapshot leaked ${secret}`);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

await scenario("Runtime task gate allows concurrent normal tasks but serializes maintenance", async () => {
  const gate = new RuntimeTaskGate({ drainTimeoutMs: 500 });
  let active = 0;
  let peak = 0;
  let releaseNormal;
  const normalLatch = new Promise((resolve) => { releaseNormal = resolve; });
  const normalA = gate.run("normal", "n1", async () => { active++; peak = Math.max(peak, active); await normalLatch; active--; });
  const normalB = gate.run("normal", "n2", async () => { active++; peak = Math.max(peak, active); await normalLatch; active--; });
  await new Promise((r) => setImmediate(r));
  const maintenance = gate.run("maintenance", "m1", async () => { assert.equal(active, 0); return "maintained"; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(peak, 2, "independent normal tasks may be concurrent");
  releaseNormal();
  await Promise.all([normalA, normalB]);
  assert.equal(await maintenance, "maintained");
  assert.equal(gate.snapshot().maintenance, null);
});

await scenario("AgentManager executes a multi-step task, reports failed tool, permits explicit retry and enforces capability boundary", async () => {
  const { AgentManager } = loadTs(path.join(root, "core/agent/AgentManager.ts"));
  let calls = 0;
  const env = {
    getHome: () => "/home/aib",
    async exists(p) { return p === "/home/aib/project/README.md"; },
    async mkdir() {}, async read() { return "readme"; }, async write() {}, async spawn() {},
    async exec(command) {
      calls++;
      if (calls === 1) throw new Error("simulated transient tool failure");
      return { exitCode: 0, stdout: `completed:${command}`, stderr: "" };
    },
  };
  const manager = new AgentManager(env);
  manager.setHostHooks({ runIsolatedShell: (command, options) => env.exec(command, options) });
  const agent = manager.create({ id: "scenario-agent", policy: { allowedCapabilities: ["filesystem", "terminal"], projectIsolation: false } });
  const denied = await manager.execute(agent.id, { tool: "shell.exec", args: { command: "pwd", cwd: "/outside" }, capability: "terminal" });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /HOME isolation/);
  const fail = await manager.execute(agent.id, { tool: "shell.exec", args: { command: "step-1", cwd: "/home/aib/project" }, capability: "terminal" });
  assert.equal(fail.ok, false);
  assert.match(fail.error, /simulated transient/);
  const retry = await manager.execute(agent.id, { tool: "shell.exec", args: { command: "step-1", cwd: "/home/aib/project" }, capability: "terminal" });
  assert.equal(retry.ok, true);
  assert.match(retry.output, /completed:step-1/);
  const next = await manager.execute(agent.id, { tool: "fs.read", args: { path: "/home/aib/project/README.md" }, capability: "filesystem" });
  assert.equal(next.output, "readme");
  assert.equal(manager.get(agent.id).status, "idle");
});

await scenario("AgentManager enforces canonical HOME boundaries, per-agent tool cap and cooperative Stop", async () => {
  const { AgentManager } = loadTs(path.join(root, "core/agent/AgentManager.ts"));
  let outsideReads = 0;
  let entered;
  const executionEntered = new Promise((resolve) => { entered = resolve; });
  const env = {
    getHome: () => "/home/aib",
    async exists() { outsideReads++; return true; },
    async mkdir() {}, async read() { outsideReads++; return "private"; }, async write() {}, async spawn() {},
    async exec(_command, options = {}) {
      entered();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("mock observed abort")), { once: true });
      });
    },
  };
  const manager = new AgentManager(env);
  manager.setHostHooks({ runIsolatedShell: (command, options) => env.exec(command, options) });
  const agent = manager.create({ id: "bounded-agent", policy: { allowedCapabilities: ["filesystem", "terminal"], projectIsolation: false, maxConcurrentTools: 1 } });
  const sibling = await manager.execute(agent.id, { tool: "fs.read", args: { path: "/home/aib-escape/secret" }, capability: "filesystem" });
  assert.equal(sibling.ok, false);
  assert.match(sibling.error, /HOME isolation/);
  const traversal = await manager.execute(agent.id, { tool: "fs.exists", args: { path: "/home/aib/.." }, capability: "filesystem" });
  assert.equal(traversal.ok, false);
  assert.equal(outsideReads, 0, "outside paths must never reach the fake filesystem");

  const active = manager.execute(agent.id, { tool: "shell.exec", args: { command: "long-task", cwd: "/home/aib" }, capability: "terminal" });
  await executionEntered;
  const excess = await manager.execute(agent.id, { tool: "shell.exec", args: { command: "over-limit", cwd: "/home/aib" }, capability: "terminal" });
  assert.equal(excess.ok, false);
  assert.match(excess.error, /AGENT_CONCURRENCY_LIMIT:1/);
  manager.stop(agent.id);
  const stopped = await active;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error, "ABORTED");
  assert.equal(manager.get(agent.id).status, "stopped");
  assert.equal((await manager.execute(agent.id, { tool: "env.home", args: {}, capability: "filesystem" })).error, "AGENT_STOPPED");
});

await scenario("OneClick factory derives a valid Expo package name for numeric-leading project ids", async () => {
  const { OneClickAppFactory } = loadTs(path.join(root, "core/workspace/OneClickAppFactory.ts"));
  const runtime = {
    home: { projects: "/home/aib/projects" },
    environment: { async mkdir() {} },
    async persistentWorkspaceStatus() { return {}; }, async projectMemoryGet() { return {}; },
    async projectMemoryRecordError() {},
    async containerCreate() { return { id: "mock-container" }; }, async containerStart() {},
    async containerExec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async generateAIProject() { return { ok: true, files: ["package.json"] }; },
    async persistentWorkspaceCheckpoint() {},
    async projectMemoryRecordBuild() { throw new Error("stop-after-scaffold"); },
  };
  const result = await new OneClickAppFactory(runtime).run({ name: "123", prompt: "small app", template: "expo", maxBuildAttempts: 1 });
  assert.equal(result.ok, false, "fixture intentionally stops after scaffold to inspect derived package name");
  assert.equal(result.projectId, "123");
  assert.equal(result.packageName, "com.aibuilder.app123");
  assert.match(result.error, /stop-after-scaffold/);
});

await scenario("ProjectLifecycle removes newly-created payload after metadata failure and rejects duplicate creates", async () => {
  const { ProjectLifecycle } = loadTs(path.join(root, "core/project-lifecycle.ts"));
  const layout = { root: "/home/aib", projects: "/home/aib/projects", metadata: "/home/aib/.ai-builder/metadata" };
  const dirs = new Set();
  const files = new Map();
  let failWrite = true;
  const fsPort = {
    ensureDirectory(p) { dirs.add(p); },
    listDirectories(parent) { return [...dirs].filter((p) => path.posix.dirname(p) === parent).map((p) => path.posix.basename(p)); },
    async readTextFile(p) { return files.get(p) || ""; },
    async writeTextFile(p, text) { if (failWrite) throw new Error("metadata disk full"); files.set(p, text); },
    async fileExists(p) { return files.has(p); },
    async removeDirectory(p) { dirs.delete(p); },
    async moveDirectory(from, to) { dirs.delete(from); dirs.add(to); },
    async removeFile(p) { files.delete(p); },
  };
  const lifecycle = new ProjectLifecycle(layout, fsPort);
  await assert.rejects(lifecycle.create("demo"), /metadata disk full/);
  assert.equal(dirs.has("/home/aib/projects/demo"), false, "failed metadata must not leave an orphan payload directory");
  failWrite = false;
  await lifecycle.create("demo");
  assert.equal(dirs.has("/home/aib/projects/demo"), true);
  await assert.rejects(lifecycle.create("demo"), /PROJECT_ALREADY_EXISTS/);
  assert.equal(dirs.has("/home/aib/projects/demo"), true, "duplicate create must preserve existing project");
});

await scenario("Project scaffold/build/export shell builders safely quote hostile paths and fail closed on missing export source", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v226-project-shell-"));
  fixtureSharedRoot = temp;
  cache.delete(path.resolve(path.join(root, "lib/active-project.ts")));
  const { buildScaffoldCommands, buildGradleAssembleCommands, exportZipCommand } = loadTs(path.join(root, "lib/active-project.ts"));
  const marker = path.join(temp, "SHELL_INJECTED");
  const projectPath = path.join(temp, "projects", `project"; touch SHELL_INJECTED; #`);
  const project = { id: "test", name: "Demo", packageName: "com.example.demo", path: projectPath, createdAt: 0, updatedAt: 0, gitInit: false, template: "compose", useCompose: true };
  const run = (command) => spawnSync("bash", ["-c", command], { encoding: "utf8", cwd: temp, env: { ...process.env, ANDROID_HOME: "", ANDROID_SDK_ROOT: "", PREFIX: "" } });
  try {
    for (const command of buildScaffoldCommands(project)) {
      const result = run(command);
      assert.equal(result.status, 0, `scaffold shell command failed: ${result.stderr}`);
    }
    const gradlePrep = run(buildGradleAssembleCommands(projectPath)[0]);
    assert.equal(gradlePrep.status, 0, gradlePrep.stderr);
    assert.equal(fs.existsSync(path.join(projectPath, "settings.gradle.kts")), true, `expected generated Gradle settings under project root; files=${JSON.stringify(fs.readdirSync(projectPath))}`);
    assert.equal(fs.existsSync(marker), false, "hostile project path must not execute injected shell text");

    const exportResult = run(exportZipCommand(projectPath));
    assert.equal(exportResult.status, 0, exportResult.stderr);
    const exportName = fs.readdirSync(path.join(temp, "projects")).find((name) => name.startsWith(`${path.basename(projectPath)}-export-`) && name.endsWith(".tar.gz"));
    assert.ok(exportName, "timestamped project export archive must be created beside the source directory");
    assert.equal(fs.existsSync(marker), false);

    const missingPath = path.join(temp, "projects", "missing-project");
    const failedExport = run(exportZipCommand(missingPath));
    assert.notEqual(failedExport.status, 0, "tar failure must not be hidden by a succeeding ls");
  } finally { fixtureSharedRoot = ""; fs.rmSync(temp, { recursive: true, force: true }); }
});

await scenario("Release artifact uses a real isolated shell/filesystem, records checksum/version and never reports false success", async () => {
  const { createReleaseArtifact } = loadTs(path.join(root, "lib/release-artifact-manager.ts"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v226-release-"));
  const marker = path.join(temp, "RELEASE_INJECTED");
  const projectPath = path.join(temp, `project'; touch RELEASE_INJECTED; #`);
  const apkPath = path.join(temp, "input.apk");
  const apkBytes = Buffer.from("deterministic mock APK bytes\n");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(apkPath, apkBytes);
  const commands = [];
  const runtime = { environment: { async exec(command) {
    commands.push(command);
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8", cwd: temp });
    return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } } };
  const options = { runtime, projectPath, projectId: "project-v226", version: "1.8.45", releaseName: "repeat-audit-v226", gate: { releaseAllowed: true, artifact: apkPath, checks: [{ id: "mock", passed: true }], regression: { report: { status: "passed", totals: { passed: 4 } } } } };
  try {
    const blocked = await createReleaseArtifact({ ...options, gate: { ...options.gate, releaseAllowed: false } });
    assert.equal(blocked.created, false);
    assert.equal(commands.length, 0, "blocked release gate must not touch the shell");
    const result = await createReleaseArtifact(options);
    assert.equal(result.created, true, result.message);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.sha256, createHash("sha256").update(apkBytes).digest("hex"));
    assert.equal(result.bundleArchive && fs.existsSync(result.bundleArchive), true);
    assert.deepEqual(fs.readFileSync(result.apkPath), apkBytes);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.version, "1.8.45");
    assert.equal(manifest.projectId, "project-v226");
    assert.equal(fs.existsSync(marker), false, "hostile project path must remain data, not shell syntax");
    const missing = await createReleaseArtifact({ ...options, gate: { ...options.gate, artifact: path.join(temp, "missing.apk") } });
    assert.equal(missing.created, false, "missing source APK must not yield a release artifact success");
    assert.match(missing.message, /APK_NOT_FOUND/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

await scenario("Secure key persistence migrates existing legacy fallback and never creates plaintext copies on write failure", async () => {
  const { readSecureStoreItem, persistSecureStoreItem } = loadTs(path.join(root, "lib/persistence.ts"));
  storageState.secure.clear(); storageState.async.clear(); storageState.getError = null; storageState.setErrors = 0; storageState.setCalls = 0;
  storageState.secure.set("provider.key", "secure-value");
  assert.equal(await readSecureStoreItem("provider.key", "provider.fallback"), "secure-value");
  storageState.getError = new Error("mock read failure");
  storageState.async.set("provider.fallback", "fallback-value");
  assert.equal(await readSecureStoreItem("provider.key", "provider.fallback"), "fallback-value");
  assert.equal(await readSecureStoreItem("missing.key"), null);
  const warnings = [];
  const oldWarn = console.warn;
  let callsBeforeWrite = 0;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    storageState.setErrors = 2;
    storageState.async.set("provider.fallback", "preexisting-legacy-value");
    callsBeforeWrite = storageState.setCalls;
    persistSecureStoreItem("provider.key", "do-not-log-this-secret", { fallbackKey: "provider.fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally { console.warn = oldWarn; }
  assert.equal(storageState.setCalls - callsBeforeWrite, 2, "secure storage performs exactly one retry");
  assert.equal(storageState.async.get("provider.fallback"), "preexisting-legacy-value", "failed writes preserve but do not overwrite an existing legacy value");
  assert.ok(warnings.some((x) => x.includes("retry failed")));
  assert.ok(warnings.every((x) => !x.includes("do-not-log-this-secret")), "secret values must not be logged");
});

await scenario("OpenRouter secured transport handles success, non-2xx, offline retry and malformed JSON", async () => {
  const { onlineModelEngine } = loadTs(path.join(root, "lib/online-model.ts"));
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "  answer  " } }] }) });
    assert.equal(await onlineModelEngine.chat([{ role: "user", content: "hello" }], undefined, "en"), "answer");
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "bad key" });
    await assert.rejects(onlineModelEngine.chat([{ role: "user", content: "hello" }], undefined, "en"), /HTTP:401/);
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError("offline"); };
    await assert.rejects(onlineModelEngine.chat([{ role: "user", content: "hello" }], undefined, "en"), /NETWORK:/);
    assert.equal(calls, 2, "transient network error receives one bounded retry");
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } });
    await assert.rejects(onlineModelEngine.chat([{ role: "user", content: "hello" }], undefined, "en"), /NETWORK:/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "   " } }] }) });
    await assert.rejects(onlineModelEngine.chat([{ role: "user", content: "hello" }], undefined, "en"), /EMPTY/);
  } finally { globalThis.fetch = oldFetch; }
});

await scenario("OpenRouter abort during retry backoff terminates before a second provider request", async () => {
  const { onlineModelEngine } = loadTs(path.join(root, "lib/online-model.ts"));
  const oldFetch = globalThis.fetch;
  let calls = 0;
  const controller = new AbortController();
  try {
    globalThis.fetch = async () => { calls++; return { ok: false, status: 503, statusText: "unavailable", text: async () => "upstream unavailable" }; };
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(onlineModelEngine.chat([{ role: "user", content: "x" }], undefined, "en", undefined, undefined, controller.signal), /ABORTED/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = oldFetch; }
});

await scenario("OpenRouter model-check fake request timeout is detected and classified (no provider service called)", async () => {
  const { checkOpenRouterModels } = loadTs(path.join(root, "lib/online-model.ts"));
  const oldFetch = globalThis.fetch;
  const oldSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (fn, _ms, ...args) => oldSetTimeout(fn, 0, ...args);
    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
    });
    const transport = async (_provider, _route, requestPath, init) => globalThis.fetch(`https://openrouter.test/${requestPath}`, init);
    const results = await checkOpenRouterModels([{ id: "mock/model", name: "Mock", vision: false, contextLength: 1024 }], undefined, { maxRetries: 0, staggerMs: 0 }, transport);
    assert.equal(results["mock/model"].status, "timeout");
    assert.equal(results["mock/model"].error, "TIMEOUT");
  } finally { globalThis.fetch = oldFetch; globalThis.setTimeout = oldSetTimeout; }
});

await scenario("One-shot completion timeout and explicit Stop abort the in-flight operation signal", async () => {
  const { withAbortableTimeout } = loadTs(path.join(root, "lib/abortable-timeout.ts"));
  const timeoutController = new AbortController();
  let timedSignal;
  await assert.rejects(withAbortableTimeout((signal) => {
    timedSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("provider observed abort")), { once: true }));
  }, 5, timeoutController), /MODEL_TIMEOUT/);
  assert.equal(timedSignal.aborted, true, "timeout must abort the underlying provider/inference operation");

  const stopController = new AbortController();
  let stopSignal;
  const stopped = withAbortableTimeout((signal) => {
    stopSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("ABORTED")), { once: true }));
  }, 1000, stopController);
  stopController.abort();
  await assert.rejects(stopped, /ABORTED/);
  assert.equal(stopSignal.aborted, true);
});

await scenario("Device evidence sha256 is a real digest of exact UTF-8/binary bytes and reports byte-accurate sizes", async () => {
  const { DeviceEvidenceStore, sha256Bytes } = loadTs(path.join(root, "core/device/DeviceEvidenceStore.ts"));
  for (const text of ["", "abc", "café 🌱", "a".repeat(1000)]) {
    const bytes = Buffer.from(text, "utf8");
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256Bytes(new Uint8Array(bytes)), expected);
  }
  const store = new DeviceEvidenceStore("/home/aib/projects/demo", "run-1");
  const text = "café 🌱";
  const textRef = await store.write("case-1", "log.txt", text, "logcat");
  assert.equal(textRef.sha256, createHash("sha256").update(text, "utf8").digest("hex"));
  assert.equal(textRef.bytes, Buffer.byteLength(text, "utf8"));
  assert.equal(evidenceState.files.get(textRef.path).encoding, "utf8");
  assert.equal(evidenceState.files.get(textRef.path).value, text);

  const binary = Uint8Array.from([0, 1, 2, 250, 255]);
  const binaryRef = await store.write("case-1", "screen.png", binary, "screenshot");
  assert.equal(binaryRef.sha256, createHash("sha256").update(binary).digest("hex"));
  assert.equal(binaryRef.bytes, binary.byteLength);
  assert.equal(evidenceState.files.get(binaryRef.path).encoding, "base64");
  assert.equal(evidenceState.files.get(binaryRef.path).value, Buffer.from(binary).toString("base64"));
});

await scenario("DeviceTestRunner fails closed for unmatched/empty case selection instead of passing zero tests", async () => {
  const { runDeviceTestSuite } = loadTs(path.join(root, "core/device/DeviceTestRunner.ts"));
  const evidence = {
    root: "file:///evidence/run-select",
    async init() {},
    async write(testId, name, _value, kind = "artifact") { return { kind, path: `${this.root}${testId}/${name}`, sha256: "x", bytes: 0 }; },
    async writeJson(testId, name, value) { return this.write(testId, name, JSON.stringify(value), "json"); },
    relative(ref) { return ref.path.slice(this.root.length); },
  };
  const bridge = {};
  const suite = { goal: "should not silently pass", cases: [{ id: "known", title: "Known", goal: "goal", steps: [] }] };
  const selected = await runDeviceTestSuite(bridge, { apkPath: "/app.apk", packageName: "com.example.app", suite, evidence, caseIds: ["missing"] });
  assert.equal(selected.report.status, "failed");
  assert.equal(selected.report.totals.cases, 1);
  assert.equal(selected.report.totals.blocked, 1);
  assert.equal(selected.report.cases[0].reason, "NO_MATCHING_TEST_CASES");
  const empty = await runDeviceTestSuite(bridge, { apkPath: "/app.apk", packageName: "com.example.app", suite: { goal: "empty", cases: [] }, evidence });
  assert.equal(empty.report.status, "failed");
  assert.equal(empty.report.cases[0].reason, "NO_TEST_CASES");
});

await scenario("DeviceTestRunner executes a wait action for its configured duration exactly once", async () => {
  const { runDeviceTestSuite } = loadTs(path.join(root, "core/device/DeviceTestRunner.ts"));
  const evidence = {
    root: "file:///evidence/run-wait",
    async init() {},
    async write(testId, name, _value, kind = "artifact") { return { kind, path: `${this.root}${testId}/${name}`, sha256: "x", bytes: 0 }; },
    async writeJson(testId, name, value) { return this.write(testId, name, JSON.stringify(value), "json"); },
    relative(ref) { return ref.path.slice(this.root.length); },
  };
  const bridge = {
    async install() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async screenshotBase64() { return "AA=="; },
    async uiHierarchy() { return { exitCode: 0, stdout: "<hierarchy><node text=\"ready\" bounds=\"[0,0][10,10]\" /></hierarchy>", stderr: "" }; },
    async logcat() { return { exitCode: 0, stdout: "", stderr: "" }; },
  };
  const timers = [];
  const oldSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds <= 20) { timers.push(milliseconds); queueMicrotask(() => callback(...args)); return 1; }
    return oldSetTimeout(callback, milliseconds, ...args);
  };
  try {
    const result = await runDeviceTestSuite(bridge, {
      apkPath: "/app.apk", packageName: "com.example.app", suite: { goal: "wait", cases: [{ id: "c", title: "wait", goal: "wait", steps: [{ id: "s", action: { type: "wait", durationMs: 12 }, assertions: [] }] }] }, evidence,
    });
    assert.equal(result.report.status, "passed");
    assert.deepEqual(timers, [12]);
  } finally { globalThis.setTimeout = oldSetTimeout; }
});

await scenario("GitHub production writer commits create/update/rename/delete atomically and verifies ref SHA", async () => {
  let branchReads = 0;
  let treeBody;
  let commitBody;
  let patchBody;
  let blobIndex = 0;
  installGithubMock(async (request) => {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "GET /repos/acme/demo") return { body: { default_branch: "main", archived: false, permissions: { push: true } } };
    if (route === "GET /repos/acme/demo/git/ref/heads/feature") {
      branchReads++;
      return { body: { object: { sha: branchReads === 1 ? "parent-sha" : "commit-sha" } } };
    }
    if (route === "GET /repos/acme/demo/git/commits/parent-sha") return { body: { tree: { sha: "base-tree" } } };
    if (route === "POST /repos/acme/demo/git/blobs") return { body: { sha: `blob-${++blobIndex}` } };
    if (route === "POST /repos/acme/demo/git/trees") { treeBody = JSON.parse(request.body); return { body: { sha: "tree-sha" } }; }
    if (route === "POST /repos/acme/demo/git/commits") { commitBody = JSON.parse(request.body); return { body: { sha: "commit-sha", html_url: "https://github.com/acme/demo/commit/commit-sha" } }; }
    if (route === "PATCH /repos/acme/demo/git/refs/heads/feature") { patchBody = JSON.parse(request.body); return { body: { object: { sha: "commit-sha" } } }; }
    return { status: 500, body: { message: `unexpected ${route}` } };
  });
  const { githubApplyFiles } = loadTs(path.join(root, "lib/github-tools.ts"));
  const changes = [
    { path: "docs/new.md", content: "new" },
    { path: "docs/edit.md", content: "edited" },
    { path: "docs/renamed.md", content: "renamed contents" },
    { path: "docs/old-name.md", delete: true },
    { path: "remove.md", delete: true },
  ];
  const result = await githubApplyFiles("acme", "demo", "feature", "Apply file changes", changes);
  assert.equal(result.verified, true);
  assert.equal(result.commitSha, "commit-sha");
  assert.equal(result.changedFiles.length, changes.length);
  assert.equal(treeBody.base_tree, "base-tree");
  assert.deepEqual(treeBody.tree.filter((entry) => entry.sha === null).map((entry) => entry.path), ["docs/old-name.md", "remove.md"]);
  assert.deepEqual(treeBody.tree.filter((entry) => entry.sha !== null).map((entry) => entry.sha), ["blob-1", "blob-2", "blob-3"]);
  assert.deepEqual(commitBody.parents, ["parent-sha"]);
  assert.equal(patchBody.sha, "commit-sha");
  assert.equal(patchBody.force, false, "writer must not force-update a branch");
  assert.equal(githubState.requests.at(-1).method, "GET", "successful write ends with production ref verification");
  assert.ok(githubState.requests.every((request) => request.headers.Authorization === "Bearer mock-github-token"));
});

await scenario("GitHub writer rejects unsafe/empty path, missing token, absent push permission and empty repository without false commit", async () => {
  const { githubApplyFiles } = loadTs(path.join(root, "lib/github-tools.ts"));
  installGithubMock(async () => ({ body: { default_branch: "main", archived: false, permissions: { push: true } } }));
  for (const unsafePath of ["", " ", "/x", "../x", "a/../b"]) {
    await assert.rejects(githubApplyFiles("acme", "demo", "main", "message", [{ path: unsafePath, content: "x" }]), /GITHUB_FILE_PATH_INVALID/);
  }
  assert.equal(githubState.requests.length, 0, "path validation must run before network/bridge requests");

  installGithubMock(async () => ({ body: { default_branch: "main", archived: false, permissions: { push: false } } }));
  await assert.rejects(githubApplyFiles("acme", "demo", "main", "message", [{ path: "safe.txt", content: "x" }]), /GITHUB_PUSH_PERMISSION_REQUIRED/);
  assert.equal(githubState.requests.length, 1, "permission denial performs only repository-info read");

  installGithubMock(async () => ({ body: { default_branch: null, archived: false, permissions: { push: true } } }), "");
  await assert.rejects(githubApplyFiles("acme", "empty", "main", "message", [{ path: "first.txt", content: "x" }]), /GITHUB_TOKEN_NOT_CONNECTED/);
  assert.equal(githubState.requests.length, 0, "missing protected token prevents all network calls");

  installGithubMock(async (request) => {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "GET /repos/acme/empty") return { body: { default_branch: null, archived: false, permissions: { push: true } } };
    if (route === "GET /repos/acme/empty/git/ref/heads/main") return { status: 404, body: { message: "Reference not found" } };
    if (route === "GET /repos/acme/empty/git/ref/heads/feature") return { status: 404, body: { message: "Reference not found" } };
    return { status: 500, body: { message: `unexpected ${route}` } };
  });
  await assert.rejects(githubApplyFiles("acme", "empty", "feature", "first commit", [{ path: "first.txt", content: "x" }]), /GITHUB_HTTP_404/);
  assert.equal(githubState.requests.some((request) => ["POST", "PATCH"].includes(request.method)), false, "empty repository does not falsely create an initial commit");
});

await scenario("GitHub partial blob/API failure never advances branch and commit verification mismatch is reported", async () => {
  let blobCount = 0;
  installGithubMock(async (request) => {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "GET /repos/acme/demo") return { body: { default_branch: "main", archived: false, permissions: { push: true } } };
    if (route === "GET /repos/acme/demo/git/ref/heads/feature") return { body: { object: { sha: "parent-sha" } } };
    if (route === "GET /repos/acme/demo/git/commits/parent-sha") return { body: { tree: { sha: "base-tree" } } };
    if (route === "POST /repos/acme/demo/git/blobs" && ++blobCount === 2) return { status: 503, body: { message: "temporary API failure" } };
    if (route === "POST /repos/acme/demo/git/blobs") return { body: { sha: "blob-orphan" } };
    return { status: 500, body: { message: `unexpected ${route}` } };
  });
  const { githubApplyFiles } = loadTs(path.join(root, "lib/github-tools.ts"));
  await assert.rejects(githubApplyFiles("acme", "demo", "feature", "two files", [{ path: "a.txt", content: "a" }, { path: "b.txt", content: "b" }]), /GITHUB_HTTP_503/);
  assert.equal(githubState.requests.some((request) => ["POST /repos/acme/demo/git/trees", "POST /repos/acme/demo/git/commits", "PATCH /repos/acme/demo/git/refs/heads/feature"].includes(`${request.method} ${new URL(request.url).pathname}`)), false);

  let refReads = 0;
  installGithubMock(async (request) => {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "GET /repos/acme/demo") return { body: { default_branch: "main", archived: false, permissions: { push: true } } };
    if (route === "GET /repos/acme/demo/git/ref/heads/feature") { refReads++; return { body: { object: { sha: refReads === 1 ? "parent-sha" : "wrong-sha" } } }; }
    if (route === "GET /repos/acme/demo/git/commits/parent-sha") return { body: { tree: { sha: "base-tree" } } };
    if (route === "POST /repos/acme/demo/git/blobs") return { body: { sha: "blob-1" } };
    if (route === "POST /repos/acme/demo/git/trees") return { body: { sha: "tree-1" } };
    if (route === "POST /repos/acme/demo/git/commits") return { body: { sha: "commit-expected", html_url: "" } };
    if (route === "PATCH /repos/acme/demo/git/refs/heads/feature") return { body: { object: { sha: "commit-expected" } } };
    return { status: 500, body: { message: `unexpected ${route}` } };
  });
  await assert.rejects(githubApplyFiles("acme", "demo", "feature", "verify", [{ path: "a.txt", content: "a" }]), /GITHUB_COMMIT_VERIFY_FAILED/);
});

await scenario("Custom provider validates key/model config, returns content, reports HTTP failure and aborts retry wait", async () => {
  const { CustomProviderEngine } = loadTs(path.join(root, "lib/custom-provider.ts"));
  const engine = new CustomProviderEngine();
  await assert.rejects(engine.chat([{ role: "user", content: "x" }]), /required/);
  engine.setConfig({ baseUrl: "https://example.test/v1", hasApiKey: true, modelId: "gpt-4o-mini" });
  axiosState.calls = [];
  axiosState.responder = async () => ({ status: 200, data: { choices: [{ message: { content: " custom answer " } }] }, headers: {} });
  assert.equal(await engine.chat([{ role: "user", content: "hello" }]), "custom answer");
  axiosState.responder = async () => ({ status: 401, data: { error: { message: "bad key" } }, headers: {} });
    await assert.rejects(engine.chat([{ role: "user", content: "x" }]), /HTTP:401:AUTH_REJECTED/);
  const controller = new AbortController();
  axiosState.responder = async () => ({ status: 503, data: {}, headers: {} });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(engine.chat([{ role: "user", content: "x" }], undefined, controller.signal), /ABORTED/);
  assert.equal(axiosState.calls.length, 3, "aborted retry waits do not issue another call");
});

await scenario("Custom provider singleton switches explicit custom path to OpenCode default instead of retaining stale endpoint", async () => {
  const { CustomProviderEngine } = loadTs(path.join(root, "lib/custom-provider.ts"));
  const engine = new CustomProviderEngine();
  axiosState.calls = [];
  axiosState.responder = async () => ({ status: 200, data: { choices: [{ message: { content: "ok" } }] }, headers: {} });
  engine.setConfig({ name: "custom", baseUrl: "https://custom.example/v1", hasApiKey: true, modelId: "gpt-4o-mini", chatPath: "/custom/generate" });
  await engine.chat([{ role: "user", content: "one" }]);
  engine.setConfig({ name: "OpenCode", baseUrl: "https://opencode.ai/zen/v1", hasApiKey: true, modelId: "zen-model", chatPath: "/chat/completions" });
  await engine.chat([{ role: "user", content: "two" }]);
  assert.equal(axiosState.calls[0][0], "https://custom.example/v1/custom/generate");
  assert.equal(axiosState.calls[1][0], "https://opencode.ai/zen/v1/chat/completions");
  const hookSource = fs.readFileSync(path.join(root, "hooks/useLLM.ts"), "utf8");
  assert.match(hookSource, /chatPath:\s*cfg\.chatPath\s*\|\|\s*"\/chat\/completions"/);
  assert.match(hookSource, /chatPath:\s*"\/chat\/completions"/);
});

await scenario("Local model missing/corrupt files reject load; valid GGUF loads, generates, stops, switches params and unloads", async () => {
  const { LOCAL_MODEL, localModelEngine } = loadTs(path.join(root, "lib/local-model.ts"));
  const modelUri = `file:///aib-doc/models/${LOCAL_MODEL.llmFileName}`;
  fileStore.delete(modelUri);
  await assert.rejects(localModelEngine.load(), /MODEL_NOT_DOWNLOADED/);
  dirStore.add("file:///aib-doc/models");
  fileStore.set(modelUri, { size: LOCAL_MODEL.llmBytes, bytes: [0, 0, 0, 0], text: "" });
  await assert.rejects(localModelEngine.load(), /LLM_NOT_GGUF/);
  fileStore.set(modelUri, { size: LOCAL_MODEL.llmBytes, bytes: [0x47, 0x47, 0x55, 0x46], text: "" });
  const initBefore = llamaState.initCalls;
  await localModelEngine.load();
  assert.equal(localModelEngine.isLoaded(), true);
  assert.equal(llamaState.initCalls, initBefore + 1);
  assert.equal(await localModelEngine.chat([{ role: "user", content: "hello" }]), "local answer");
  llamaState.nextCompletion = () => new Promise((resolve) => { llamaState.pendingCompletionResolve = resolve; });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(localModelEngine.chat([{ role: "user", content: "stop me" }], undefined, undefined, undefined, controller.signal), /ABORTED/);
  assert.ok(llamaState.stopCalls >= 1, "stop must call native stopCompletion boundary");
  llamaState.nextCompletion = null;
  const params = { ...localModelEngine.getAppliedParams(), nCtx: localModelEngine.getAppliedParams().nCtx + 256 };
  const releasesBefore = llamaState.releaseCalls;
  await localModelEngine.load(params);
  assert.ok(llamaState.releaseCalls > releasesBefore, "parameter change unloads old context before reload");
  await localModelEngine.unload();
  assert.equal(localModelEngine.isLoaded(), false);
});

await scenario("Termux bridge returns callback output with final no-newline chunk preserved and capped timeout", async () => {
  const { runShellCommand } = loadTs(path.join(root, "lib/termux-bridge.ts"));
  const events = [];
  const { subscribeTermuxOutput } = loadTs(path.join(root, "lib/termux-bridge.ts"));
  const unsubscribe = subscribeTermuxOutput((event) => events.push(event));
  try {
    const result = await runShellCommand("printf tail", { timeoutMs: 3_600_000, backend: "termux" });
    assert.equal(result.stdout, "tail-without-newline");
    assert.equal(result.timedOut, false);
    assert.ok(events.some((e) => e.stream === "stdout" && e.chunk === "tail-without-newline\n"));
    const long = "x".repeat(128_000);
    termuxState.responder = async (_command, _workdir, timeoutMs) => ({ commandId: "native-long", stdout: long, stderr: "", exitCode: 0, timedOut: false, timeoutMs });
    const longResult = await runShellCommand("large-output", { timeoutMs: 20_000_000, backend: "termux" });
    assert.equal(longResult.stdout.length, 128_000, "callback path must preserve long final output");
    assert.equal(longResult.timeoutMs, 10_800_000, "explicit timeout is capped at 3 hours (v389)");
    const longInputCalls = [];
    termuxState.responder = async (command, _workdir, timeoutMs) => {
      longInputCalls.push(command);
      return { commandId: "native-long-input", stdout: "script-result", stderr: "", exitCode: 0, timedOut: false, timeoutMs };
    };
    const longInput = await runShellCommand("printf 'x'\\n".repeat(240), { backend: "termux" });
    assert.equal(longInput.stdout, "script-result");
    const chunkWrites = longInputCalls.filter((command) => command.includes("base64 -d >>"));
    assert.equal(chunkWrites.length, 2, "long input must be split into bounded encoded writes instead of one Binder payload");
    assert.ok(longInputCalls.some((command) => command.includes("aib-long-cmd-")), "long command should be staged under a unique script path");
    assert.ok(longInputCalls.at(-1).includes("bash"), "the staged script must be launched after chunks are written");
    termuxState.responder = async (_command, _workdir, timeoutMs) => ({ commandId: "native-build", stdout: "", stderr: "timeout", exitCode: 124, timedOut: true, timeoutMs });
    const buildTimeout = await runShellCommand("gradle assemble", { isBuild: true, timeoutMs: 1_000, backend: "termux" });
    assert.equal(buildTimeout.timedOut, true);
    assert.equal(buildTimeout.timeoutMs, 9_300_000, "build default is 155 minutes (v389 self-healing script)");
    termuxState.responder = async () => { throw new Error("SecurityException: permission denied"); };
    await assert.rejects(runShellCommand("protected", { backend: "termux" }), /permission denied/);
  } finally { unsubscribe(); }
});

await scenario("LinuxRuntime accepts nested workspace cwd and still rejects traversal/sibling paths", async () => {
  const { LinuxRuntime } = loadTs(path.join(root, "core/linux/LinuxRuntime.ts"));
  const commands = [];
  const home = { root: "/home/aib", workspace: "/home/aib/workspace", containers: "/home/aib/containers" };
  const environment = {
    async exec(command, options) {
      commands.push({ command, options });
      if (command === "command -v 'proot-distro'") return { exitCode: 0, stdout: "/bin/proot-distro" };
      if (command.includes("proot-distro") && command.includes("login") && command.includes("AIB_PROBE_ID")) return { exitCode: 0, stdout: "AIB_PROBE_ID:debian\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:x86_64\n", stderr: "" };
      if (command.includes("proot-distro") && command.includes("list")) return { exitCode: 0, stdout: "Installed distributions:\n  debian\n", stderr: "" };
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async exists() { return false; },
    async mkdir() {},
  };
  const runtime = new LinuxRuntime(environment, home);
  const result = await runtime.exec("pwd", [], { cwd: "/workspace/subdir" });
  assert.equal(result.exitCode, 0);
  assert.ok(commands.some((call) => call.command.includes("/workspace/subdir") && call.command.startsWith("proot-distro")));
  for (const cwd of ["/workspace/../outside", "/workspaceX/outside", "/workspace//subdir", "/workspace/./subdir"]) {
    await assert.rejects(runtime.exec("pwd", [], { cwd }), /Linux cwd must stay inside/);
  }
  assert.equal(commands.filter((call) => call.command.includes("/workspace/subdir")).length, 1, "rejected cwd values must not reach runtime execution");
});

await scenario("Native accelerator is unavailable unless its probe guarantees context-aware execution", async () => {
  const { isNativeAccelLinked } = loadTs(path.join(root, "core/runtime/native-accel-loader.ts"));
  const { NativeAccelBackend } = loadTs(path.join(root, "core/runtime/backends/NativeAccelBackend.ts"));
  let receivedRequest;
  let execCalls = 0;
  nativeAccelState.module = {
    async isAvailable() { return true; },
    async probe() { return { ok: true, supportsRuntimeContext: false, detail: "legacy app-private shell" }; },
    async exec(request) { execCalls++; receivedRequest = request; return { exitCode: 0, stdout: "", stderr: "" }; },
  };
  assert.equal(await isNativeAccelLinked(), false, "a healthy-looking but context-incomplete module must not be selected");
  const backend = new NativeAccelBackend(async () => true);
  assert.equal((await backend.probe()).health, "unavailable");
  const denied = await backend.exec({ command: "pwd", cwd: "/workspace", timeoutMs: 1000, env: { HOME: "/workspace" } });
  assert.equal(denied.exitCode, 127);
  assert.equal(execCalls, 0, "legacy shell implementation must not execute through the runtime backend");

  nativeAccelState.module.probe = async () => ({ ok: true, supportsRuntimeContext: true, detail: "context-aware test double" });
  assert.equal(await isNativeAccelLinked(), true);
  assert.equal((await backend.probe()).health, "ready");
  const request = { command: "pwd", cwd: "/workspace", timeoutMs: 1000, env: { HOME: "/workspace" } };
  assert.equal((await backend.exec(request)).exitCode, 0);
  assert.deepEqual(receivedRequest, request, "runtime context is forwarded as a single structured request");
});

await scenario("Project transfer production validators reject traversal, normalize safe separators and filter private metadata", async () => {
  const { assertTransferProjectName, normalizeTransferPath, createProjectTransferManifest } = loadTs(path.join(root, "core/project-transfer.ts"));
  assert.equal(assertTransferProjectName("demo-project_1"), "demo-project_1");
  assert.throws(() => assertTransferProjectName("../outside"));
  assert.throws(() => normalizeTransferPath("src/../../outside"));
  assert.equal(normalizeTransferPath("./src\\main.ts"), "src/main.ts");
  const manifest = createProjectTransferManifest("demo", ["src/main.ts", ".ai-builder/metadata.json", "README.md"]);
  assert.deepEqual(manifest.files, ["README.md", "src/main.ts"]);
});

await scenario("Production translator resolves supported locales and interpolation while preserving missing-key/placeholder fallbacks", async () => {
  const { t, LANGUAGE_LABELS } = loadTs(path.join(root, "lib/i18n.ts"));
  assert.equal(LANGUAGE_LABELS.uk, "Українська");
  assert.equal(LANGUAGE_LABELS.ru, "Русский");
  assert.equal(LANGUAGE_LABELS.en, "English");
  assert.equal(t("uk", "chat"), "Чат");
  assert.equal(t("ru", "chat"), "Чат");
  assert.equal(t("en", "chat"), "Chat");
  assert.equal(t("uk", "commandsGuideCount", { count: 2, total: 9 }), "Знайдено 2 з 9");
  assert.match(t("uk", "commandsGuideCount", { count: 2 }), /\{total\}/, "unprovided placeholders stay visible rather than silently disappearing");
  assert.equal(t("en", "missing-key"), "missing-key", "unknown translations fall back to their key");
});

console.log(`AIB_V226_SCENARIO_SELFTEST ${passed}/${passed + failed.length}`);
if (failed.length) {
  for (const item of failed) console.error(`DETAIL ${item.name}\n${item.error}`);
  process.exitCode = 1;
}
