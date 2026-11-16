#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";
import { typescript } from "./test-helpers/load-typescript.mjs";
const __AIB_VER = (await import("node:fs")).readFileSync(new URL("../core/runtime/RuntimeIdentity.ts", import.meta.url), "utf8").match(/appVersion: "([^"]+)"/)[1]; // v407: single source of truth (RuntimeIdentity == package.json)

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { inspectProotRuntimeReadiness } = loadRuntimeTs(path.join(root, "lib/runtime-environment-check.ts"));
const { runProotRuntimePreparationAction } = loadRuntimeTs(path.join(root, "lib/runtime-environment-action.ts"));
const {
  createLogExportService,
  isAllowedLogExportDirectoryUri,
  isAllowedLogExportFileUri,
  MAX_LOG_EXPORT_CHARACTERS,
} = loadRuntimeTs(path.join(root, "lib/log-export.ts"));
const { redactSecrets } = loadRuntimeTs(path.join(root, "lib/log-redaction.ts"));
const targets = [
  { target: "ubuntu-proot", alias: "ubuntu" },
];
const selectedDirectory = "content://com.android.externalstorage.documents/tree/primary%3AAIBuilderTermux%2Flogs";

function rootfsEnvelope(alias, options = {}) {
  const list = options.unknownList
    ? "Supported distributions:\n  Debian (debian)\n  Ubuntu (ubuntu)"
    : options.missing
      ? "No containers are installed."
      : `Installed containers:\n  * ${alias}`;
  const loginExit = options.missing || options.loginFailure ? 1 : 0;
  const id = options.id ?? alias;
  const guestMachine = options.guestMachine ?? "x86_64";
  const loginFields = loginExit === 0
    ? `AIB_PROBE_ID:${id}\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:${guestMachine}\n`
    : options.missing
      ? `Error: container '${alias}' is not installed.\n`
      : "proot-distro login failure is unclassified\n";
  return [
    "AIB_PROBE_BEGIN",
    "AIB_PROOT_TOOL:AVAILABLE",
    "AIB_HOST_UNAME:x86_64",
    "AIB_LIST_BEGIN",
    list,
    "AIB_LIST_END",
    "AIB_LIST_EXIT:0",
    "AIB_LOGIN_BEGIN",
    loginFields.trimEnd(),
    `AIB_LOGIN_EXIT:${loginExit}`,
    "AIB_LOGIN_END",
    "AIB_PROBE_END",
  ].join("\n");
}

function result(exitCode, extra = {}) {
  return { exitCode, stdout: "", stderr: "", ...extra };
}

async function check(target, alias, rootfsResult) {
  const run = async (_command, options) => {
    if (options.packageId === "proot-distro") return result(0, { stdout: "AIB_PROOT_TOOL:AVAILABLE" });
    if (options.packageId === `${alias}-rootfs`) {
      if (rootfsResult instanceof Error) throw rootfsResult;
      if (typeof rootfsResult === "function") return rootfsResult();
      return rootfsResult;
    }
    return result(0);
  };
  return inspectProotRuntimeReadiness(target, { run });
}

function androidAdapter(overrides = {}) {
  const calls = { request: 0, create: 0, write: 0, cache: 0, share: 0, fileName: "", uri: "" };
  const adapter = {
    platform: "android",
    async requestDirectoryPermission() {
      calls.request += 1;
      if (overrides.requestError) throw overrides.requestError;
      return overrides.pickerResult ?? { granted: true, directoryUri: selectedDirectory };
    },
    async createSafFile(directoryUri, fileName, mimeType) {
      calls.create += 1;
      calls.fileName = fileName;
      assert.equal(directoryUri, selectedDirectory);
      assert.equal(mimeType, "text/plain");
      return overrides.createdUri ?? "content://com.android.externalstorage.documents/document/primary%3AAIBuilderTermux%2Flogs%2Fai-builder-log-fixture.txt";
    },
    async writeText(uri, content) {
      calls.write += 1;
      if (overrides.writeError) throw overrides.writeError;
      calls.uri = uri;
      calls.content = content;
    },
    async writeCacheFile() { calls.cache += 1; throw new Error("ANDROID_MUST_USE_SAF"); },
    async isSharingAvailable() { return true; },
    async shareFile() { calls.share += 1; },
    ...overrides,
  };
  return { adapter, calls };
}

for (const { target, alias } of targets) {
  const healthy = await check(target, alias, result(0, { stdout: rootfsEnvelope(alias) }));
  assert.equal(healthy.status, "ready", `${alias}: complete rootfs identity and baseline are ready`);
  assert.equal(healthy.rootfsState.healthy, true);

  const missing = await check(target, alias, result(0, { stdout: rootfsEnvelope(alias, { missing: true }) }));
  assert.equal(missing.status, "missing", `${alias}: exact-alias login not-installed response confirms absence`);
  assert.equal(missing.phase, "rootfs-check");
  assert.equal(missing.rootfs, "missing");

  const unknown = await check(target, alias, result(0, { stdout: rootfsEnvelope(alias, { unknownList: true, loginFailure: true }) }));
  assert.equal(unknown.status, "error", `${alias}: incomplete/unsupported list plus unclassified login failure stays unknown`);
  assert.notEqual(unknown.rootfs, "missing");

  const loginProven = await check(target, alias, result(0, { stdout: rootfsEnvelope(alias, { unknownList: true }) }));
  assert.equal(loginProven.status, "ready", `${alias}: exact guest identity remains authoritative despite an unrecognized list format`);
  assert.equal(loginProven.rootfsState.listEvidence, "unrecognized");

  const permission = await check(target, alias, result(126, { stderr: "Permission denied" }));
  assert.equal(permission.status, "error");
  assert.match(permission.detail, /permission/i, `${alias}: permission reason is visible without raw output`);
  assert.notEqual(permission.rootfs, "missing");

  const timeout = await check(target, alias, result(-1, { timedOut: true }));
  assert.equal(timeout.status, "error");
  assert.match(timeout.detail, /timed out/i, `${alias}: timeout reason is visible`);
  assert.notEqual(timeout.rootfs, "missing");

  const identityMismatch = await check(target, alias, result(0, {
    stdout: rootfsEnvelope(alias, { id: "fedora", guestMachine: "aarch64" }),
  }));
  assert.equal(identityMismatch.status, "error");
  assert.equal(identityMismatch.rootfsState.installed, true, `${alias}: listed installed mismatch is preserved as present`);
  assert.notEqual(identityMismatch.rootfs, "missing");

  const permissionException = await check(target, alias, new Error("RUN_COMMAND_PERMISSION_MISSING"));
  assert.equal(permissionException.status, "error");
  assert.match(permissionException.detail, /permission/i, `${alias}: rejected bridge call is classified safely`);
  assert.notEqual(permissionException.rootfs, "missing");

  let prepareCalls = 0;
  const blocked = await runProotRuntimePreparationAction(target, {
    check: async () => unknown,
    prepare: async () => { prepareCalls += 1; return true; },
  });
  assert.equal(blocked.kind, "blocked");
  assert.equal(prepareCalls, 0, `${alias}: unknown click-time result never starts mutation`);

  let freshCalls = 0;
  const prepared = await runProotRuntimePreparationAction(target, {
    check: async () => { freshCalls += 1; return missing; },
    prepare: async (fresh) => { assert.equal(fresh.status, "missing"); prepareCalls += 1; return "mock-prepared"; },
  });
  assert.equal(freshCalls, 1, `${alias}: explicit click performs a fresh check`);
  assert.equal(prepared.kind, "prepared", `${alias}: only exact fresh absence proceeds`);
  assert.equal(prepareCalls, 1);
}

assert.equal(isAllowedLogExportDirectoryUri(selectedDirectory), true, "SAF grants may target AIBuilderTermux or a descendant");
assert.equal(isAllowedLogExportDirectoryUri("content://com.android.externalstorage.documents/tree/primary%3ADownload"), false);
assert.equal(isAllowedLogExportDirectoryUri("content://untrusted.documents/tree/primary%3AAIBuilderTermux"), false);
assert.equal(isAllowedLogExportDirectoryUri("file:///storage/emulated/0/AIBuilderTermux"), false);
assert.equal(isAllowedLogExportDirectoryUri("content://com.android.externalstorage.documents/tree/primary%3AAIBuilderTermux%2F..%2FDocuments"), false);
assert.equal(isAllowedLogExportFileUri("content://com.android.externalstorage.documents/document/primary%3AAIBuilderTermux%2Flogs%2Fapp.txt", selectedDirectory), true);
assert.equal(isAllowedLogExportFileUri("content://com.android.externalstorage.documents/document/primary%3AAIBuilderTermux%2Fother%2Fapp.txt", selectedDirectory), false);

{
  const { adapter, calls } = androidAdapter();
  const save = createLogExportService(adapter);
  const resultValue = await save("safe log text", { fileName: "fixture.txt" });
  assert.equal(resultValue.kind, "saved");
  assert.equal(calls.request, 1);
  assert.equal(calls.create, 1);
  assert.equal(calls.write, 1);
  assert.equal(calls.content, "safe log text");
  assert.equal(calls.cache, 0, "Android export does not use app cache as its user-visible destination");
  assert.equal(calls.share, 0, "Android SAF completion is not misreported as a share failure");
  assert.equal(calls.fileName, "fixture.txt");
}

{
  const { adapter, calls } = androidAdapter({ pickerResult: { granted: false } });
  const value = await createLogExportService(adapter)("text");
  assert.deepEqual(value, { kind: "cancelled", reason: "directory-picker-cancelled" });
  assert.equal(calls.create, 0);
}

{
  const { adapter, calls } = androidAdapter({ requestError: new Error("SecurityException: permission denied") });
  const value = await createLogExportService(adapter)("text");
  assert.deepEqual(value, { kind: "failed", reason: "permission-denied" });
  assert.equal(calls.create, 0);
}

{
  const { adapter, calls } = androidAdapter({ pickerResult: { granted: true, directoryUri: null } });
  const value = await createLogExportService(adapter)("text");
  assert.deepEqual(value, { kind: "failed", reason: "storage-unavailable" });
  assert.equal(calls.create, 0);
}

{
  const { adapter, calls } = androidAdapter({ pickerResult: { granted: true, directoryUri: "content://com.android.externalstorage.documents/tree/primary%3ADownload" } });
  const value = await createLogExportService(adapter)("text");
  assert.deepEqual(value, { kind: "failed", reason: "wrong-directory" });
  assert.equal(calls.create, 0, "outside folders are rejected before a write");
}

{
  const { adapter, calls } = androidAdapter({ createdUri: "content://com.android.externalstorage.documents/document/primary%3AAIBuilderTermux%2Fother%2Fescaped.txt" });
  const value = await createLogExportService(adapter)("text");
  assert.deepEqual(value, { kind: "failed", reason: "storage-unavailable" });
  assert.equal(calls.write, 0, "the created document must remain beneath the user's selected SAF tree");
}

{
  const { adapter, calls } = androidAdapter({ writeError: new Error("ENOSPC") });
  const value = await createLogExportService(adapter)("text");
  assert.deepEqual(value, { kind: "failed", reason: "write-failed" });
  assert.equal(calls.write, 1);
}

{
  const { adapter, calls } = androidAdapter();
  const value = await createLogExportService(adapter)("");
  assert.deepEqual(value, { kind: "empty" });
  assert.equal(calls.request, 0, "empty export does not open SAF");
}

{
  const { adapter, calls } = androidAdapter();
  const value = await createLogExportService(adapter)("x".repeat(MAX_LOG_EXPORT_CHARACTERS + 1));
  assert.deepEqual(value, { kind: "failed", reason: "too-large" });
  assert.equal(calls.request, 0, "oversized export is rejected before allocation on platform storage");
}

{
  const { adapter, calls } = androidAdapter();
  const large = "large-log-entry\n".repeat(100_000);
  const value = await createLogExportService(adapter)(large, { fileName: "large.txt" });
  assert.equal(value.kind, "saved", "large but bounded logs complete through SAF");
  assert.equal(calls.content.length, large.length);
}

{
  let releasePicker;
  const pickerGate = new Promise((resolve) => { releasePicker = resolve; });
  const { adapter, calls } = androidAdapter({ pickerResult: pickerGate });
  const save = createLogExportService(adapter);
  const first = save("first tap");
  const second = save("repeated tap");
  releasePicker({ granted: true, directoryUri: selectedDirectory });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.kind, "saved");
  assert.equal(two.kind, "saved");
  assert.equal(calls.request, 1, "rapid repeat tap shares one SAF request");
  assert.equal(calls.create, 1, "rapid repeat tap creates one file");
}

{
  const other = {
    platform: "other",
    async writeCacheFile(fileName, content) { assert.equal(content, "cross-platform"); return `file:///cache/${fileName}`; },
    async isSharingAvailable() { return true; },
    async shareFile() {},
  };
  assert.equal((await createLogExportService(other)("cross-platform")).kind, "saved");
  const cancelledShare = createLogExportService({
    ...other,
    async shareFile() { throw new Error("share dismissed by user"); },
  });
  assert.deepEqual(await cancelledShare("cross-platform"), { kind: "cancelled", reason: "share-cancelled" });
  const noShare = createLogExportService({ ...other, async isSharingAvailable() { return false; } });
  assert.deepEqual(await noShare("cross-platform"), { kind: "failed", reason: "share-unavailable" });
}

const screen = fs.readFileSync(path.join(root, "app/log-screen.tsx"), "utf8");
const hook = fs.readFileSync(path.join(root, "hooks/useLogger.ts"), "utf8");
const config = fs.readFileSync(path.join(root, "app.config.ts"), "utf8");
const checkSource = fs.readFileSync(path.join(root, "lib/runtime-environment-check.ts"), "utf8");
const runtimeFacade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.match(hook, /StorageAccessFramework\.requestDirectoryPermissionsAsync/);
assert.match(hook, /redactLogText\(content\)/, "content is redacted before export");
assert.doesNotMatch(hook, /activity-events\.jsonl/, "the timeline append is not the .txt export path");
assert.match(runtimeFacade, /new ActivityTimeline\(new EventStore\(new EnvironmentTextStore\([\s\S]{0,180}activity-events\.jsonl/);
assert.match(screen, /exportBusyRef\.current/);
assert.match(screen, /catch\s*\{[\s\S]{0,120}export failure must never close the screen/);
assert.match(checkSource, /classifyProbeException/);
assert.match(config, /android\.permission\.MANAGE_EXTERNAL_STORAGE/, "v471 explicitly declares the user-enabled Android special access");
assert.doesNotMatch(config, /android\.permission\.(?:READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE)/, "the special-access flow does not restore legacy broad storage permissions");
assert.equal(packageJson.version, __AIB_VER, "app version stays unchanged for source-only patches");
assert.match(fs.readFileSync(path.join(root, "app.config.ts"), "utf8"), /com\.karat\.aibuilder/);
assert.doesNotMatch(hook, /console\.(?:log|warn|error)\([^\n]*err/);
const redacted = redactSecrets("Authorization: Bearer veryLongSyntheticSecret123 https://example.invalid/private/project");
assert.doesNotMatch(redacted, /veryLongSyntheticSecret123|example\.invalid/);
assert.match(redacted, /REDACTED/);

for (const relative of [
  "app/log-screen.tsx",
  "components/LoggerContext.tsx",
  "hooks/useLogger.ts",
  "lib/log-export.ts",
  "lib/proot-distro-state.ts",
  "lib/runtime-environment-check.ts",
]) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const result = typescript.transpileModule(source, {
    fileName: relative,
    reportDiagnostics: true,
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactNative,
    },
  });
  const errors = (result.diagnostics || []).filter((item) => item.category === typescript.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${relative}: source transpiles without syntax errors`);
}

console.log("AIB_V278_RUNTIME_EXPORT_SELFTEST_OK active_alias=ubuntu preflight=click-time fresh missing-only=1 rootfs=unknown/permission/timeout/identity fail-closed=1 SAF=AIBuilderTermux scoped=1 export=success/cancel/denied/write-fail/large/empty/repeat=PASS privacy=redacted MANAGE_EXTERNAL_STORAGE=manual+gated legacy-broad-permissions=0");
