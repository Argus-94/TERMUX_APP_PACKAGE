import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "AIBuilder v229 repeat audit "));
const projectPath = path.join(tempRoot, "project with spaces — 'Miro'");
fs.mkdirSync(projectPath, { recursive: true });

function loadTypeScriptModule(filePath, requireImpl) {
  const source = fs.readFileSync(filePath, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const context = { module, exports: module.exports, require: requireImpl, console, Date, Math, JSON, Set, Error, String, Array, Object, RegExp };
  vm.runInNewContext(js, context, { filename: filePath });
  return module.exports;
}

function createLifecycleFs() {
  const dirs = new Set();
  const files = new Map();
  const controls = { failWritePath: "", failRemovePath: "" };
  return {
    dirs, files, controls,
    ensureDirectory(path) { dirs.add(path); },
    listDirectories(path) {
      const prefix = `${path.replace(/[\\/]+$/, "")}/`;
      return [...dirs].filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"))
        .map((entry) => entry.slice(prefix.length));
    },
    readTextFile(path) {
      if (!files.has(path)) throw new Error("MISSING_FILE");
      return files.get(path);
    },
    writeTextFile(path, content) {
      if (controls.failWritePath === path) {
        controls.failWritePath = "";
        throw new Error("injected metadata write failure");
      }
      files.set(path, content);
    },
    fileExists(path) { return files.has(path); },
    removeDirectory(path) {
      for (const entry of [...dirs]) if (entry === path || entry.startsWith(`${path}/`)) dirs.delete(entry);
      for (const entry of [...files.keys()]) if (entry === path || entry.startsWith(`${path}/`)) files.delete(entry);
    },
    moveDirectory(from, to) {
      if (!dirs.has(from) || dirs.has(to)) throw new Error("PROJECT_MOVE_FAILED");
      const movedDirs = [...dirs].filter((entry) => entry === from || entry.startsWith(`${from}/`));
      const movedFiles = [...files.entries()].filter(([entry]) => entry.startsWith(`${from}/`));
      for (const entry of movedDirs) dirs.delete(entry);
      for (const entry of movedDirs) dirs.add(`${to}${entry.slice(from.length)}`);
      for (const [entry] of movedFiles) files.delete(entry);
      for (const [entry, content] of movedFiles) files.set(`${to}${entry.slice(from.length)}`, content);
    },
    removeFile(path) {
      if (controls.failRemovePath === path) {
        controls.failRemovePath = "";
        throw new Error("injected metadata delete failure");
      }
      files.delete(path);
    },
  };
}

let failMoveTarget = "";
let failMoveOnce = false;
const runtime = {
  environment: {
    async exec(command) {
      if (failMoveOnce && failMoveTarget && command.includes("mv -f ") && command.includes(`${path.basename(failMoveTarget)}.tmp-`)) {
        failMoveOnce = false;
        return { exitCode: 73, stdout: "", stderr: "injected rename failure" };
      }
      try {
        const stdout = execFileSync("/bin/bash", ["-lc", command], {
          cwd: projectPath,
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr: "" };
      } catch (error) {
        return {
          exitCode: Number.isInteger(error?.status) ? error.status : 1,
          stdout: String(error?.stdout || ""),
          stderr: String(error?.stderr || error?.message || "shell command failed"),
        };
      }
    },
  },
};

try {
  const projectManagerModule = loadTypeScriptModule(
    path.join(root, "core/project-manager.ts"),
    () => { throw new Error("unexpected ProjectManager import"); },
  );
  const projectMetadataModule = loadTypeScriptModule(
    path.join(root, "core/project-metadata.ts"),
    (specifier) => specifier === "./project-manager" ? projectManagerModule : (() => { throw new Error(`unexpected metadata import ${specifier}`); })(),
  );
  const projectStorageModule = loadTypeScriptModule(
    path.join(root, "core/project-storage.ts"),
    (specifier) => specifier === "./project-manager" ? projectManagerModule : (() => { throw new Error(`unexpected storage import ${specifier}`); })(),
  );
  const homeLayoutModule = loadTypeScriptModule(
    path.join(root, "core/home/HomeLayout.ts"),
    () => { throw new Error("unexpected HomeLayout import"); },
  );
  const projectLifecycleModule = loadTypeScriptModule(
    path.join(root, "core/project-lifecycle.ts"),
    (specifier) => {
      if (specifier === "./project-manager") return projectManagerModule;
      if (specifier === "./project-metadata") return projectMetadataModule;
      if (specifier === "./project-storage") return projectStorageModule;
      throw new Error(`unexpected lifecycle import ${specifier}`);
    },
  );
  const lifecycleLayout = homeLayoutModule.createHomeLayout(path.join(tempRoot, "lifecycle home"));
  const lifecycleFs = createLifecycleFs();
  const lifecycle = new projectLifecycleModule.ProjectLifecycle(lifecycleLayout, lifecycleFs);
  const racedCreates = await Promise.allSettled([
    lifecycle.create("race", { metadata: { owner: "first" } }),
    lifecycle.create("race", { metadata: { owner: "second" } }),
  ]);
  assert.equal(racedCreates.filter((result) => result.status === "fulfilled").length, 1, "concurrent same-name creates must have exactly one winner");
  assert.equal(racedCreates.filter((result) => result.status === "rejected").length, 1, "the losing create must fail, not overwrite metadata");
  assert.equal(racedCreates.find((result) => result.status === "rejected").reason.message, "PROJECT_ALREADY_EXISTS");
  const raceMetadataPath = projectMetadataModule.projectMetadataPath(lifecycleLayout, "race");
  assert.ok(["first", "second"].includes(JSON.parse(lifecycleFs.files.get(raceMetadataPath)).owner));

  const failedCreateMetadata = projectMetadataModule.projectMetadataPath(lifecycleLayout, "create-fails");
  lifecycleFs.controls.failWritePath = failedCreateMetadata;
  await assert.rejects(lifecycle.create("create-fails"), /injected metadata write failure/);
  assert.equal(lifecycleFs.dirs.has(`${lifecycleLayout.projects}/create-fails`), false, "failed create must remove its new payload directory");
  assert.equal(lifecycleFs.files.has(failedCreateMetadata), false, "failed create must leave no partial metadata");

  await lifecycle.create("rename-source", { metadata: { owner: "rename-source" } });
  const failedRenameMetadata = projectMetadataModule.projectMetadataPath(lifecycleLayout, "rename-target");
  lifecycleFs.controls.failWritePath = failedRenameMetadata;
  await assert.rejects(lifecycle.rename("rename-source", "rename-target"), /injected metadata write failure/);
  assert.equal(lifecycleFs.dirs.has(`${lifecycleLayout.projects}/rename-source`), true, "failed rename must move the payload back");
  assert.equal(lifecycleFs.dirs.has(`${lifecycleLayout.projects}/rename-target`), false, "failed rename must remove the new path");
  assert.equal(JSON.parse(lifecycleFs.files.get(projectMetadataModule.projectMetadataPath(lifecycleLayout, "rename-source"))).owner, "rename-source");

  await lifecycle.rename("rename-source", "rename-target");
  const targetMetadata = projectMetadataModule.projectMetadataPath(lifecycleLayout, "rename-target");
  lifecycleFs.controls.failRemovePath = targetMetadata;
  await assert.rejects(lifecycle.delete("rename-target"), /injected metadata delete failure/);
  assert.equal(lifecycleFs.dirs.has(`${lifecycleLayout.projects}/rename-target`), true, "failed delete must restore the quarantined project");
  assert.equal(lifecycleFs.files.has(targetMetadata), true, "failed delete must preserve project metadata");
  await lifecycle.delete("rename-target");
  assert.equal(lifecycleFs.dirs.has(`${lifecycleLayout.projects}/rename-target`), false, "successful delete must remove the payload");
  assert.equal(lifecycleFs.files.has(targetMetadata), false, "successful delete must remove metadata");

  const recoveryModule = loadTypeScriptModule(
    path.join(root, "lib/fleet-audit-recovery.ts"),
    () => { throw new Error("unexpected runtime import from fleet-audit-recovery"); },
  );
  const backupModule = loadTypeScriptModule(
    path.join(root, "lib/fleet-backup-recovery.ts"),
    (specifier) => {
      if (specifier === "./fleet-audit-recovery") return recoveryModule;
      throw new Error(`unexpected runtime import ${specifier}`);
    },
  );

  const policyRel = "artifacts/deployments/fleet-policy.json";
  const channelRel = "artifacts/channels/debug/channel.json";
  const productionRel = "artifacts/deployments/fleet-production.json";
  const lateRel = "artifacts/channels/internal/channel.json";
  const emptyRel = "artifacts/deployments/canary-debug.json";
  const policyPath = path.join(projectPath, policyRel);
  const channelPath = path.join(projectPath, channelRel);
  const productionPath = path.join(projectPath, productionRel);
  const latePath = path.join(projectPath, lateRel);
  const emptyPath = path.join(projectPath, emptyRel);
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.mkdirSync(path.dirname(channelPath), { recursive: true });
  fs.mkdirSync(path.dirname(productionPath), { recursive: true });
  fs.mkdirSync(path.dirname(emptyPath), { recursive: true });
  const originalPolicy = '{"revision":"known-good","enabled":true}';
  const originalChannel = '{"channel":"debug","revision":17}';
  const originalProduction = '{"channel":"production","revision":23}';
  fs.writeFileSync(policyPath, originalPolicy);
  fs.writeFileSync(channelPath, originalChannel);
  fs.writeFileSync(productionPath, originalProduction);
  fs.writeFileSync(emptyPath, "");

  const secret = "local-test-secret-0123456789";
  const { record } = await backupModule.createFleetEncryptedBackup({ runtime, projectPath, secret, reason: "v229 regression" });
  fs.writeFileSync(policyPath, '{"revision":"modified-after-backup"}');
  fs.writeFileSync(channelPath, '{"channel":"debug","revision":999}');
  fs.writeFileSync(productionPath, '{"channel":"production","revision":999}');
  fs.writeFileSync(emptyPath, "no longer empty");
  fs.mkdirSync(path.dirname(latePath), { recursive: true });
  fs.writeFileSync(latePath, '{"created":"after-backup"}');

  const restored = await backupModule.restoreFleetEncryptedBackup({ runtime, projectPath, backupId: record.id, secret });
  assert.equal(restored.restored, true, "restore must report success only after the snapshot is applied");
  assert.equal(restored.recoveryIndexUpdated, true, "recovery index should point to the applied snapshot");
  assert.equal(fs.readFileSync(policyPath, "utf8"), originalPolicy, "fleet policy must actually be restored");
  assert.equal(fs.readFileSync(channelPath, "utf8"), originalChannel, "channel configuration must actually be restored");
  assert.equal(fs.readFileSync(productionPath, "utf8"), originalProduction, "later-scope files present in the snapshot must be restored");
  assert.equal(fs.readFileSync(emptyPath, "utf8"), "", "existing zero-byte files must remain distinguishable from absent files");
  assert.equal(fs.existsSync(latePath), false, "files created after the snapshot must be removed when absent from it");

  const manifestPath = record.manifestPath;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.encryptedPath = "/etc/passwd";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const forged = await backupModule.verifyFleetEncryptedBackup({ runtime, projectPath, backupId: record.id, secret });
  assert.equal(forged.valid, false, "manifest paths outside the expected backup set must be rejected");
  assert.equal(forged.reason, "BACKUP_MANIFEST_INVALID");
  fs.writeFileSync(manifestPath, JSON.stringify(record));

  const failedRestoreSnapshot = await recoveryModule.createFleetRecoverySnapshot({ runtime, projectPath });
  const changedPolicy = '{"revision":"must-survive-rollback"}';
  const changedChannel = '{"channel":"debug","revision":31337}';
  const changedProduction = '{"channel":"production","revision":31337}';
  fs.writeFileSync(policyPath, changedPolicy);
  fs.writeFileSync(channelPath, changedChannel);
  fs.writeFileSync(productionPath, changedProduction);
  fs.writeFileSync(latePath, '{"created":"must-survive-rollback"}');
  failMoveTarget = productionPath;
  failMoveOnce = true;
  await assert.rejects(
    recoveryModule.restoreFleetRecoverySnapshot({ runtime, projectPath, snapshotId: failedRestoreSnapshot.id }),
    /RECOVERY_RESTORE_FAILED:.*ROLLED_BACK/,
    "a mid-restore rename failure must be reported and rolled back",
  );
  assert.equal(fs.readFileSync(policyPath, "utf8"), changedPolicy, "earlier successful writes must be rolled back");
  assert.equal(fs.readFileSync(channelPath, "utf8"), changedChannel, "the failing file must retain its pre-restore value");
  assert.equal(fs.readFileSync(productionPath, "utf8"), changedProduction, "the failing production file must retain its pre-restore value");
  assert.equal(fs.readFileSync(latePath, "utf8"), '{"created":"must-survive-rollback"}', "deletions of post-snapshot files must roll back after later write failure");

  const virtualFiles = new Map();
  const virtualDirs = new Set(["/mock/documents"]);
  const pickedFiles = new Map();
  let failMoveDestination = "";
  class MockDirectory {
    constructor(parent, name) {
      const base = typeof parent === "string" ? parent : parent?.uri || String(parent);
      this.uri = `${String(base).replace(/\/$/, "")}/${name}`;
    }
    get exists() { return virtualDirs.has(this.uri); }
    create() { virtualDirs.add(this.uri); }
  }
  class MockFile {
    constructor(parent, name) {
      const base = typeof parent === "string" ? parent : parent?.uri || String(parent);
      this.uri = name === undefined ? base : `${String(base).replace(/\/$/, "")}/${name}`;
      this.name = this.uri.split("/").pop();
    }
    get exists() { return virtualFiles.has(this.uri); }
    get size() { return virtualFiles.get(this.uri)?.size || 0; }
    write(text) { const value = String(text); virtualFiles.set(this.uri, { size: Buffer.byteLength(value), text: value }); }
    textSync() { return virtualFiles.get(this.uri)?.text || ""; }
    open() {
      const bytes = Buffer.from(virtualFiles.get(this.uri)?.text || "", "utf8");
      return { readBytes: (length) => new Uint8Array(bytes.subarray(0, length)), close() {} };
    }
    delete() { virtualFiles.delete(this.uri); }
    move(destination) {
      if (failMoveDestination === destination.uri) {
        failMoveDestination = "";
        throw new Error("injected metadata rename failure");
      }
      const current = virtualFiles.get(this.uri);
      if (!current) throw new Error(`ENOENT:${this.uri}`);
      virtualFiles.set(destination.uri, current);
      virtualFiles.delete(this.uri);
    }
  }
  const fileSystemMock = {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: "/mock/documents" },
  };
  const legacyFileSystemMock = {
    async copyAsync({ from, to }) {
      const source = pickedFiles.get(from);
      if (!source) throw new Error(`PICKED_SOURCE_MISSING:${from}`);
      virtualFiles.set(to, { ...source });
    },
    async readAsStringAsync(uri) { return virtualFiles.get(uri)?.text || ""; },
  };
  const modelModule = loadTypeScriptModule(
    path.join(root, "lib/local-model.ts"),
    (specifier) => {
      if (specifier === "expo-file-system") return fileSystemMock;
      if (specifier === "expo-file-system/legacy") return legacyFileSystemMock;
      if (specifier === "llama.rn") return { initLlama: async () => { throw new Error("model engine intentionally unused"); } };
      if (specifier === "./termux-bridge") return { getTermuxNative: () => ({}) };
      throw new Error(`unexpected local-model runtime import ${specifier}`);
    },
  );
  const modelsRoot = "/mock/documents/models";
  virtualDirs.add(modelsRoot);
  const originalMeta = { displayName: "Known good", llmFileName: "old.gguf", llmBytes: 1_500_000, source: "import" };
  virtualFiles.set(`${modelsRoot}/old.gguf`, { size: 1_500_000, text: "OLD_MODEL_BYTES" });
  await modelModule.writeActiveModelMeta(originalMeta);

  pickedFiles.set("file:///imports/too-small.gguf", { size: 32, text: "partial" });
  const tooSmall = await modelModule.localModelEngine.importLlmFile({ uri: "file:///imports/too-small.gguf", name: "old.gguf" });
  assert.equal(tooSmall.ok, false, "a partial/undersized import must be rejected");
  assert.deepEqual(virtualFiles.get(`${modelsRoot}/old.gguf`), { size: 1_500_000, text: "OLD_MODEL_BYTES" }, "failed staging must preserve the active model bytes");
  assert.equal([...virtualFiles.keys()].some((name) => name.includes(".import-") && name.endsWith(".tmp")), false, "failed staging leaves no import temp file");

  pickedFiles.set("file:///imports/replacement.gguf", { size: 1_750_000, text: "GGUF_NEW_MODEL_BYTES" });
  failMoveDestination = `${modelsRoot}/active-model.json`;
  const metadataFailure = await modelModule.localModelEngine.importLlmFile({ uri: "file:///imports/replacement.gguf", name: "old.gguf" });
  assert.equal(metadataFailure.ok, false, "metadata persistence failure must fail the import");
  assert.deepEqual(virtualFiles.get(`${modelsRoot}/old.gguf`), { size: 1_500_000, text: "OLD_MODEL_BYTES" }, "metadata failure must roll back the replaced GGUF");
  assert.deepEqual(modelModule.readActiveModelMeta(), originalMeta, "metadata rollback keeps the previous active model selected");

  pickedFiles.set("file:///imports/legacy.ggml", { size: 1_650_000, text: "GGUF_LEGACY_GGML" });
  const legacySuffix = await modelModule.localModelEngine.importLlmFile({ uri: "file:///imports/legacy.ggml", name: "legacy.ggml" });
  assert.equal(legacySuffix.ok, true, legacySuffix.reason);
  assert.equal(modelModule.readActiveModelMeta()?.llmFileName, "legacy.ggml", "supported .ggml files must retain their suffix");
  const collision = await modelModule.localModelEngine.importMmprojFile({ uri: "file:///imports/mmproj.gguf", name: "legacy.ggml" });
  assert.equal(collision.ok, false);
  assert.match(collision.reason || "", /FILENAME_COLLISION/);

  const scriptRunnerSource = fs.readFileSync(path.join(root, "app/script-runner.tsx"), "utf8");
  const draftSave = scriptRunnerSource.slice(scriptRunnerSource.indexOf("const handleSaveDraft"), scriptRunnerSource.indexOf("const handleClearDraft"));
  assert.ok(scriptRunnerSource.includes("Promise.allSettled(["), "script settings hydrate independently instead of losing available state on one read failure");
  assert.ok(scriptRunnerSource.includes("scriptsLoadFailedRef.current || scriptsPersistingRef.current"), "failed or concurrent list writes cannot overwrite saved scripts");
  assert.ok(draftSave.indexOf("await scriptsHydratedPromiseRef.current") < draftSave.indexOf("const next = [item, ...scriptsRef.current]"), "first save waits for stored scripts before constructing the replacement list");
  assert.ok(scriptRunnerSource.indexOf("await AsyncStorage.setItem(STORAGE_SCRIPTS") < scriptRunnerSource.indexOf("scriptsRef.current = list"), "visible script list/ref advance only after storage succeeds");
  assert.ok(draftSave.indexOf("if (!(await persistScripts(next)))") < draftSave.indexOf("setDraftName(\"\")"), "a failed save does not clear the user's draft");

  const chatSource = fs.readFileSync(path.join(root, "app/index.tsx"), "utf8");
  const pasteHandler = chatSource.slice(chatSource.indexOf("const handleLargeTextPaste"), chatSource.indexOf("const handleChangeText"));
  assert.ok(pasteHandler.includes("if (largePasteSavingRef.current) return"), "large paste does not start duplicate concurrent saves");
  assert.ok(pasteHandler.indexOf("await saveTextAsFile(text, \"paste\")") < pasteHandler.indexOf("setInput((current) => current === text ? \"\" : current)"), "large paste remains in the input until durable attachment creation succeeds");
  assert.ok(pasteHandler.includes("showDialog(t(\"modelError\"), detail)"), "large-paste failures are shown instead of silently reported as successful");

  console.log("AIB_V229_REPEAT_AUDIT_OK project-race/lifecycle-rollback fleet-exact-restore model-import rollback/ui-hydration paste-retention contracts");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
