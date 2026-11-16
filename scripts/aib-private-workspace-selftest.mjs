#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const policySource = fs.readFileSync(path.join(root, "lib/private-workspace-policy.ts"), "utf8");
const policyJs = typescript.transpile(policySource, {
  module: typescript.ModuleKind.CommonJS,
  target: typescript.ScriptTarget.ES2022,
});
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-private-workspace-"));
try {
  const libDir = path.join(out, "lib");
  const agentToolsDir = path.join(libDir, "agent-tools");
  fs.mkdirSync(agentToolsDir, { recursive: true });
  const policyPath = path.join(libDir, "private-workspace-policy.js");
  fs.writeFileSync(policyPath, policyJs);
  const policy = createRequire(import.meta.url)(policyPath);
  const rootPath = "/storage/emulated/0/AIBuilderTermux";
  const treeId = "primary:AIBuilderTermux";

  assert.equal(policy.isCanonicalAIBuilderWorkspacePath(rootPath), true, "the exact shared root is canonical");
  assert.equal(policy.isCanonicalAIBuilderWorkspacePath(`${rootPath}/Project A`), true, "a direct workspace descendant is contained");
  for (const outside of [
    "/storage/emulated/0/Pictures",
    "/storage/emulated/0/AIBuilderTermuxBackup",
    "/storage/emulated/1/AIBuilderTermux",
    "/storage/primary/AIBuilderTermux",
    `${rootPath}/../Pictures`,
    `${rootPath}/./Project`,
    `${rootPath}//Project`,
    `${rootPath}\\Project`,
    `${rootPath}/Project\0x`,
  ]) assert.equal(policy.isCanonicalAIBuilderWorkspacePath(outside), false, `reject non-canonical/outside path: ${String(outside)}`);

  assert.equal(policy.isExactAIBuilderWorkspaceTreeDocumentId(treeId), true, "accept only the exact primary-volume SAF tree");
  for (const id of ["primary:Pictures", "ABCD-1234:AIBuilderTermux", "primary:AIBuilderTermuxBackup", "primary:AIBuilderTermux/../Pictures"]) {
    assert.equal(policy.isExactAIBuilderWorkspaceTreeDocumentId(id), false, `reject outside or traversal tree ID: ${id}`);
  }
  assert.equal(policy.isDirectAIBuilderWorkspaceChildDocumentId(`${treeId}/notes.txt`), true);
  assert.equal(policy.isDirectAIBuilderWorkspaceChildDocumentId(`${treeId}/Shortcut`), true, "a possible symlink-like entry may be named, but only its own metadata can be listed");
  for (const id of [
    `${treeId}/../Pictures/secret.txt`,
    `${treeId}/Shortcut/secret.txt`,
    `${treeId}/.`,
    `${treeId}/..`,
    `${treeId}/bad\\name`,
    `${treeId}/`,
  ]) assert.equal(policy.isDirectAIBuilderWorkspaceChildDocumentId(id), false, `reject traversal/nested/invalid child ID: ${id}`);
  assert.equal(policy.aiBuilderWorkspaceChildPath(rootPath, "notes.txt"), `${rootPath}/notes.txt`);
  assert.throws(() => policy.aiBuilderWorkspaceChildPath("/storage/emulated/0/Pictures", "notes.txt"), /AIB_WORKSPACE_ROOT_NOT_CANONICAL/);
  for (const name of ["..", ".", "../outside", "nested/secret", "link\\secret", "nul\0name"]) {
    assert.throws(() => policy.aiBuilderWorkspaceChildPath(rootPath, name), /AIB_WORKSPACE_CHILD_NAME_INVALID/);
  }

  const bridgePath = path.join(libDir, "termux-bridge.js");
  fs.writeFileSync(bridgePath, [
    "exports.getAIBuilderAllFilesAccessStatus = async () => {",
    "  global.__aibWorkspaceState.accessCalls += 1;",
    "  return global.__aibWorkspaceState.access;",
    "};",
    "exports.listAIBuilderWorkspace = async () => {",
    "  const access = await exports.getAIBuilderAllFilesAccessStatus();",
    "  if (!access.granted) throw new Error(access.reason || 'AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED');",
    "  global.__aibWorkspaceState.calls += 1;",
    "  if (global.__aibWorkspaceState.error) throw global.__aibWorkspaceState.error;",
    "  return global.__aibWorkspaceState.value;",
    "};",
  ].join("\n"));
  const toolSource = fs.readFileSync(path.join(root, "lib/agent-tools/workspace-list.ts"), "utf8");
  const toolPath = path.join(agentToolsDir, "workspace-list.js");
  fs.writeFileSync(toolPath, typescript.transpile(toolSource, {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2022,
  }));
  const tool = createRequire(import.meta.url)(toolPath);
  const state = { calls: 0, accessCalls: 0, access: { supported: true, granted: true, reason: null }, error: null, value: { rootPath, readOnly: true, entries: [], truncated: false } };
  global.__aibWorkspaceState = state;
  assert.equal(tool.validate({}), null);
  assert.equal(tool.validate({ path: "/storage/emulated/0/Pictures" }), "AIB_WORKSPACE_LIST_ARGS_UNSUPPORTED");
  await assert.rejects(
    tool.execute({}, "/storage/emulated/0/Pictures", { executionTarget: "selected-backend" }),
    { message: "AIB_TOOL_WORKSPACE_LIST_PRIVATE_TARGET_REQUIRED" },
  );
  assert.equal(state.calls, 0, "injected legacy target fails before native or external execution");
  assert.equal(state.accessCalls, 0, "injected legacy target fails before permission or storage access");
  const listing = await tool.execute({}, "/storage/emulated/0/Pictures", { executionTarget: "embedded-private" });
  assert.equal(listing.rootPath, rootPath, "projectPath cannot redirect the native workspace operation");
  assert.equal(state.calls, 1, "the private path performs one native metadata call only");
  assert.equal(state.accessCalls, 1, "workspace.list checks all-files access before metadata I/O");

  state.access = { supported: true, granted: false, reason: "AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED" };
  await assert.rejects(tool.execute({}, null, { executionTarget: "embedded-private" }), { message: "AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED" });
  assert.equal(state.calls, 1, "missing/revoked broad access fails before SAF/provider metadata access");
  state.access = { supported: true, granted: true, reason: null };

  state.error = new Error("AIB_WORKSPACE_GRANT_REQUIRED");
  await assert.rejects(tool.execute({}, null, { executionTarget: "embedded-private" }), { message: "AIB_WORKSPACE_GRANT_REQUIRED" });
  assert.equal(state.calls, 2, "an absent SAF grant surfaces a typed failure without retry/fallback");
  state.error = new Error("AIB_WORKSPACE_LIST_FAILED");
  await assert.rejects(tool.execute({}, null, { executionTarget: "embedded-private" }), { message: "AIB_WORKSPACE_LIST_FAILED" });
  assert.equal(state.calls, 3, "native/provider failure surfaces unchanged without another executor");
  delete global.__aibWorkspaceState;

  const plugin = fs.readFileSync(path.join(root, "plugins/withTermuxBridge.js"), "utf8");
  assert.match(plugin, /private val aiBuilderWorkspaceTreeDocumentId = "primary:AIBuilderTermux"/);
  assert.match(plugin, /private fun workspaceTreeDocumentId\(uri: Uri\)/);
  assert.match(plugin, /it\.isReadPermission && isAIBuilderWorkspaceTree\(it\.uri\)/);
  assert.match(plugin, /AIB_WORKSPACE_GRANT_PERSIST_FAILED/);
  const start = plugin.indexOf("private fun workspaceTreeDocumentId(uri: Uri)");
  const end = plugin.indexOf("@ReactMethod\n    fun exportModelToDirectory", start);
  assert.ok(start >= 0 && end > start, "native workspace API section is present");
  const nativeWorkspace = plugin.slice(start, end);
  assert.match(nativeWorkspace, /buildChildDocumentsUriUsingTree\(treeUri, rootDocumentId\)/);
  assert.match(nativeWorkspace, /isDirectWorkspaceChildDocumentId\(documentId\)/);
  assert.match(nativeWorkspace, /if \(count >= 200\)/, "native listing is bounded");
  assert.match(nativeWorkspace, /AIB_WORKSPACE_GRANT_REQUIRED/);
  assert.doesNotMatch(nativeWorkspace, /releasePersistableUriPermission/,
    "the feature never revokes a persisted grant which an existing project flow may use");
  const listingStart = plugin.indexOf("fun listAIBuilderWorkspace(promise: Promise)", start);
  const listingEnd = plugin.indexOf("\n    @ReactMethod", listingStart);
  assert.ok(listingStart >= 0 && listingEnd > listingStart, "native metadata-list function is isolated");
  const nativeListing = plugin.slice(listingStart, listingEnd);
  assert.doesNotMatch(nativeListing, /FLAG_GRANT_WRITE_URI_PERMISSION|openInputStream|openFileDescriptor|canonicalFile|listFiles\s*\(/,
    "workspace grant is read-only and metadata listing never opens or recursively follows entry contents/symlinks");
  assert.equal((nativeWorkspace.match(/buildChildDocumentsUriUsingTree\(/g) || []).length, 1,
    "native metadata listing queries only the immediate children and never recurses");

  assert.doesNotMatch(toolSource, /runEmbeddedTermuxCommand|runShellCommand|executeGuardedTermuxCommand|TERMUX_RUN|proot/i,
    "workspace tool has no shell, legacy backend, or external fallback route");
  const privatePolicy = fs.readFileSync(path.join(root, "lib/agent-private-tool-policy.ts"), "utf8");
  assert.match(privatePolicy, /"workspace\.list"/);
  assert.match(privatePolicy, /target !== "embedded-private"\) return "AGENT_SHELL_TARGET_INVALID"/);
  const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
  assert.match(ui, /requestAIBuilderWorkspaceGrant/);
  assert.match(ui, /read-only grant/i);
  assert.match(ui, /MANAGE_EXTERNAL_STORAGE/);

  console.log("AIB_PRIVATE_WORKSPACE_SELFTEST_OK exact-root=1 outside/traversal=1 direct-child=1 symlink-no-follow=1 grant-fail-closed=1 no-external-fallback=1 bounded-metadata-only=1");
} finally {
  delete global.__aibWorkspaceState;
  fs.rmSync(out, { recursive: true, force: true });
}
