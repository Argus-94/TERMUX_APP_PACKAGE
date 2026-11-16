#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const pkg = JSON.parse(read("package.json"));
const config = read("app.config.ts");
const bridgeNative = read("plugins/withTermuxBridge.js");
const bridgeJs = read("lib/termux-bridge.ts");
const runtime = read("app/runtime.tsx");
const privatePolicy = read("lib/agent-private-tool-policy.ts");
const workspaceList = read("lib/agent-tools/workspace-list.ts");
const workspaceRead = read("lib/agent-tools/workspace-read.ts");
const prompt = read("lib/termux-agent.ts");

assert.equal(pkg.version, "1.10.112", "current package identity is v512");
assert.match(config, /versionCode:\s*512/);
assert.match(config, /android\.permission\.MANAGE_EXTERNAL_STORAGE/);
assert.match(config, /restricted Android 11\+ special access/i);
assert.match(bridgeNative, /Environment\.isExternalStorageManager\(\)/);
assert.match(bridgeNative, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.R/);
assert.match(bridgeNative, /Settings\.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION/);
assert.match(bridgeNative, /Settings\.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION/);
assert.match(bridgeNative, /Uri\.parse\("package:\\\$\{reactApplicationContext\.packageName\}"\)/);
assert.match(bridgeNative, /fun getAIBuilderAllFilesAccessStatus\(promise: Promise\)/);
assert.match(bridgeNative, /fun openAIBuilderAllFilesAccessSettings\(promise: Promise\)/);
assert.match(bridgeNative, /AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED/);

const nativeListStart = bridgeNative.indexOf("fun listAIBuilderWorkspace(promise: Promise)");
const nativeListEnd = bridgeNative.indexOf("@ReactMethod\n    fun exportModelToDirectory", nativeListStart);
assert.ok(nativeListStart >= 0 && nativeListEnd > nativeListStart, "native exact-root workspace operations remain present");
const nativeWorkspace = bridgeNative.slice(nativeListStart, nativeListEnd);
assert.match(nativeWorkspace, /if \(!hasAIBuilderAllFilesAccess\(\)\)[\s\S]*?AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED/);
assert.match(nativeWorkspace, /findAIBuilderWorkspaceGrantUri\(\)/, "exact user-selected SAF grant remains required after broad access is enabled");
assert.match(bridgeNative, /aiBuilderWorkspaceTreeDocumentId = "primary:AIBuilderTermux"/);
assert.match(nativeWorkspace, /count >= 200/);
assert.doesNotMatch(nativeWorkspace, /runEmbeddedTermuxCommand|runCommand\(|proot|external Termux/i,
  "workspace operations do not delegate to shell, proot, or external Termux");
const nativeRequestStart = bridgeNative.indexOf("fun requestAIBuilderWorkspaceGrant(promise: Promise)");
const nativeRequestEnd = bridgeNative.indexOf("@ReactMethod\n    fun listAIBuilderWorkspace", nativeRequestStart);
assert.ok(nativeRequestStart >= 0 && nativeRequestEnd > nativeRequestStart);
const nativeRequest = bridgeNative.slice(nativeRequestStart, nativeRequestEnd);
assert.match(nativeRequest, /if \(!hasAIBuilderAllFilesAccess\(\)\)[\s\S]*?AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED[\s\S]*?Intent\.ACTION_OPEN_DOCUMENT_TREE/,
  "the SAF folder picker is gated before launching Android's picker");

assert.match(bridgeJs, /export async function getAIBuilderAllFilesAccessStatus/);
assert.match(bridgeJs, /export async function openAIBuilderAllFilesAccessSettings/);
assert.match(bridgeJs, /if \(!access\.granted\) throw new Error\(access\.reason \|\| "AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED"\)/);
assert.match(bridgeJs, /listAIBuilderWorkspace\(\): Promise<AIBuilderWorkspaceListing>[\s\S]*?getAIBuilderAllFilesAccessStatus\(\)/);
assert.match(bridgeJs, /requestAIBuilderWorkspaceGrant\(\): Promise<AIBuilderWorkspaceGrantStatus>[\s\S]*?getAIBuilderAllFilesAccessStatus\(\)/);

assert.match(privatePolicy, /"workspace\.list", "workspace\.read", "workspace\.write"/);
assert.match(workspaceList, /listAIBuilderWorkspace\(\)/);
assert.match(workspaceRead, /readAIBuilderWorkspaceFile/);
assert.doesNotMatch(workspaceRead, /SAF_NOFOLLOW_UNPROVEN|listAIBuilderWorkspace|runEmbeddedTermuxCommand/,
  "workspace.read uses dedicated native file API only, never SAF contents or shell fallback");
assert.match(bridgeJs, /export async function getAIBuilderWorkspaceFileCapabilities/);
assert.match(bridgeJs, /export async function readAIBuilderWorkspaceFile/);
assert.match(bridgeJs, /export async function writeAIBuilderWorkspaceFile/);
assert.match(bridgeNative, /fun getAIBuilderWorkspaceFileCapabilities\(promise: Promise\)/);
assert.match(bridgeNative, /fun readAIBuilderWorkspaceFile\(relativePath: String, promise: Promise\)/);
assert.match(bridgeNative, /fun writeAIBuilderWorkspaceFile\(relativePath: String, content: String, promise: Promise\)/);
assert.match(bridgeNative, /O_NOFOLLOW/);
assert.match(bridgeNative, /proc\/self\/fd/);
assert.match(prompt, /MANAGE_EXTERNAL_STORAGE/);
assert.match(prompt, /procfd-nofollow/);
assert.match(prompt, /workspace\.write/);

assert.match(runtime, /AppState\.addEventListener\("change"/);
assert.match(runtime, /if \(state === "active"\)[\s\S]*?refreshAIBuilderAllFilesAccess\(\)/,
  "status is rechecked when returning from Settings");
const statusEffectStart = runtime.indexOf("useEffect(() => {\n    void refreshAIBuilderAllFilesAccess()");
const statusEffectEnd = runtime.indexOf("const onOpenAIBuilderAllFilesAccessSettings", statusEffectStart);
assert.ok(statusEffectStart >= 0 && statusEffectEnd > statusEffectStart);
assert.doesNotMatch(runtime.slice(statusEffectStart, statusEffectEnd), /openAIBuilderAllFilesAccessSettings/,
  "mount/resume status checks never open Settings automatically");
assert.equal((runtime.match(/openAIBuilderAllFilesAccessSettings\(\)/g) || []).length, 1,
  "Settings launcher is called only by the explicit handler");
assert.match(runtime, /onPress=\{\(\) => void onOpenAIBuilderAllFilesAccessSettings\(\)\}/,
  "a visible Runtime button is the only UI entry point");
for (const token of ["ru:", "uk:", "en:"]) assert.ok(runtime.includes(token));
assert.match(runtime, /not a sandbox limited to \/storage\/emulated\/0\/AIBuilderTermux/i);
assert.match(runtime, /Google Play restricts MANAGE_EXTERNAL_STORAGE/i);
assert.match(runtime, /workspace\.read/i);
assert.match(runtime, /aiBuilderAllFilesAccess\?\.granted !== true/,
  "the exact-root SAF picker is disabled until special access is enabled");

console.log("AIB_WORKSPACE_ALL_FILES_ACCESS_SELFTEST_OK manifest=1 native-status=1 manual-settings-only=1 resume-recheck=1 typed-denial=1 exact-root-saf-still-required=1 native-procfd-read-write=1 shell-fallback=0 localized-disclosure=ru+uk+en Play-restriction-disclosed=1");
