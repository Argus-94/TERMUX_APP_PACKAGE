#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-scoped-backup-"));
try {
  for (const rel of ["core/backup/TermuxBackupAdapter.ts", "lib/secret-archive-policy.ts"]) {
    const dest = path.join(out, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typescript.transpile(fs.readFileSync(path.join(root, rel), "utf8"), { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }));
  }
  const policyPath = path.join(out, "lib/backup-secrets-policy.js");
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, typescript.transpileModule(fs.readFileSync(path.join(root, "lib/backup-secrets-policy.ts"), "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
  const require = createRequire(import.meta.url);
  const policyModule = new Module(policyPath);
  policyModule.filename = policyPath;
  policyModule.paths = Module._nodeModulePaths(path.dirname(policyPath));
  policyModule.require = (request) => {
    if (request === "@react-native-async-storage/async-storage") return { getAllKeys: async () => [] };
    if (request === "./persistent-logger") return { persistentLogger: { add() {} } };
    return require(request);
  };
  policyModule._compile(fs.readFileSync(policyPath, "utf8"), policyPath);
  const { classifyBackupStorageKey } = policyModule.exports;
  const bridgeToken = "aib_ab12cd34ef561700000000000";
  assert.equal(classifyBackupStorageKey(bridgeToken), "secret", "generated bridge-token key names must be classified as secret");
  const { TermuxBackupAdapter } = require(path.join(out, "core/backup/TermuxBackupAdapter.js"));
  const home = path.join(out, "home");
  for (const dir of ["projects/demo", "workspace", "metadata", ".aibuilder/keys"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(path.join(home, "projects/demo/README.md"), "ok");
  fs.writeFileSync(path.join(home, "projects/demo/.env"), "API_KEY=secret");
  fs.writeFileSync(path.join(home, "projects/demo/access-token.json"), "token");
  fs.writeFileSync(path.join(home, "projects/demo/api_key.json"), "API_KEY=secret");
  fs.writeFileSync(path.join(home, ".aibuilder/keys/release.jks"), "synthetic archive fixture");
  fs.writeFileSync(path.join(home, "metadata/profile.json"), "{}");

  const env = {
    mkdir: async (value) => fs.mkdirSync(value, { recursive: true }),
    exec: async (command, options = {}) => {
      const result = spawnSync("/bin/sh", ["-lc", command], { cwd: options.cwd, encoding: "utf8" });
      return { exitCode: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
    },
  };
  const layout = { root: home, projects: path.join(home, "projects"), workspace: path.join(home, "workspace"), metadata: path.join(home, "metadata") };
  const adapter = new TermuxBackupAdapter(env, layout);
  const destination = path.join(out, "backup");
  await adapter.snapshot([layout.projects, path.join(home, ".aibuilder")], destination);
  const archive = path.join(destination, "ai-builder-data.tar.gz");
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /projects\/demo\/README.md/);
  assert.doesNotMatch(listing.stdout, /\.env|access-token|api_key|\.aibuilder\/keys|release\.jks/);
  await assert.rejects(() => adapter.validateRestoreScope(destination, [layout.metadata]), /BACKUP_ARCHIVE_SCOPE_MISMATCH|BACKUP_ARCHIVE_SCOPE_INCOMPLETE/);

  const secretConfig = path.join(home, "projects/demo/config.json");
  fs.writeFileSync(secretConfig, JSON.stringify({ APP_MODE: "production", api_key: "sk-SYNTHETICTESTFIXTURE01XXX6789" }));
  const secretDestination = path.join(out, "secret-backup");
  await assert.rejects(() => adapter.snapshot([layout.projects], secretDestination), /BACKUP_ARCHIVE_SECRET_CONTENT_FORBIDDEN/);
  assert.equal(fs.existsSync(path.join(secretDestination, "ai-builder-data.tar.gz")), false, "secret-bearing backup was not committed");
  fs.unlinkSync(secretConfig);

  const bridgeConfig = path.join(home, "projects/demo/bridge-config.json");
  fs.writeFileSync(bridgeConfig, JSON.stringify({ bridge: bridgeToken }));
  const bridgeDestination = path.join(out, "bridge-token-backup");
  await assert.rejects(() => adapter.snapshot([layout.projects], bridgeDestination), /BACKUP_ARCHIVE_SECRET_CONTENT_FORBIDDEN/);
  assert.equal(fs.existsSync(path.join(bridgeDestination, "ai-builder-data.tar.gz")), false, "bridge-token content must block backup commit");
  fs.unlinkSync(bridgeConfig);

  const maliciousStage = path.join(out, "malicious-backup-stage");
  fs.mkdirSync(path.join(maliciousStage, "projects/demo"), { recursive: true });
  fs.writeFileSync(path.join(maliciousStage, "projects/demo/config.json"), JSON.stringify({ api_key: "sk-SYNTHETICTESTFIXTURE02XXXX6789" }));
  const maliciousDestination = path.join(out, "malicious-backup");
  fs.mkdirSync(maliciousDestination);
  const maliciousCreated = spawnSync("tar", ["-czf", path.join(maliciousDestination, "ai-builder-data.tar.gz"), "projects"], { cwd: maliciousStage, encoding: "utf8" });
  assert.equal(maliciousCreated.status, 0, maliciousCreated.stderr);
  await assert.rejects(() => adapter.validateRestoreScope(maliciousDestination, [layout.projects]), /BACKUP_ARCHIVE_SECRET_CONTENT_FORBIDDEN/);

  fs.writeFileSync(path.join(maliciousStage, "projects/demo/config.json"), JSON.stringify({ bridge: bridgeToken }));
  const bridgeMaliciousDestination = path.join(out, "bridge-token-restore");
  fs.mkdirSync(bridgeMaliciousDestination);
  const bridgeMaliciousCreated = spawnSync("tar", ["-czf", path.join(bridgeMaliciousDestination, "ai-builder-data.tar.gz"), "projects"], { cwd: maliciousStage, encoding: "utf8" });
  assert.equal(bridgeMaliciousCreated.status, 0, bridgeMaliciousCreated.stderr);
  await assert.rejects(() => adapter.validateRestoreScope(bridgeMaliciousDestination, [layout.projects]), /BACKUP_ARCHIVE_SECRET_CONTENT_FORBIDDEN/);

  const boundCalls = [];
  const tooManyMembers = new TermuxBackupAdapter({ exec: async (command) => {
    boundCalls.push(command);
    return { exitCode: 0, stdout: command.includes("| wc -l") ? "20001\n" : "0\n" };
  } }, { root: "/termux/home" });
  await assert.rejects(() => tooManyMembers.validateRestoreScope("/tmp/too-many", ["/termux/home/projects"]), /BACKUP_ARCHIVE_LIMIT_EXCEEDED/);
  assert.equal(boundCalls.length, 1, "member-count limit rejects before archive member listings");
  boundCalls.length = 0;
  const tooManyBytes = new TermuxBackupAdapter({ exec: async (command) => {
    boundCalls.push(command);
    return { exitCode: 0, stdout: command.includes("| wc -l") ? "1\n" : "4294967297\n" };
  } }, { root: "/termux/home" });
  await assert.rejects(() => tooManyBytes.validateRestoreScope("/tmp/too-large", ["/termux/home/projects"]), /BACKUP_ARCHIVE_LIMIT_EXCEEDED/);
  assert.equal(boundCalls.length, 2, "expanded-byte limit rejects before archive member listings");

  console.log("AIB_SCOPED_BACKUP_SELFTEST_OK projects_scope=isolated secret_paths_and_content=blocked bridge_token=blocked restore_limits=bounded");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
