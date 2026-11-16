#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const mgr = fs.readFileSync(path.join(root, "core/backup/BackupManager.ts"), "utf8");
assert.match(mgr, /async list\(/);
const ad = fs.readFileSync(path.join(root, "core/backup/TermuxBackupAdapter.ts"), "utf8");
assert.match(ad, /listChildren/);
const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /listBackups/);
const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /onBackupVerify/);
assert.match(ui, /onBackupRefreshList/);
assert.match(ui, /backupScope/);
assert.match(ui, /Список бэкапов|Backup list/);
const tx = fs.readFileSync(path.join(root, "core/backup/RestoreTransaction.ts"), "utf8");
assert.match(tx, /INVALID_BACKUP_SCOPE/);
assert.match(tx, /this\.resolvePaths\(scope\)/);
const mem = fs.readFileSync(path.join(root, "core/backup/MemoryBackupAdapter.ts"), "utf8");
assert.match(mem, /class MemoryBackupAdapter/);
assert.match(mem, /async listChildren/);
assert.ok(mem.indexOf("class MemoryBackupAdapter") < mem.indexOf("async listChildren"));

// Exercise the real adapter implementation using a deterministic fake Termux environment.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const adapterSource = fs.readFileSync(path.join(root, "core/backup/TermuxBackupAdapter.ts"), "utf8");
const archivePolicyUrl = pathToFileURL(path.join(root, "lib/secret-archive-policy.ts")).href;
const compiled = ts.transpileModule(adapterSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(
  /from ["']\.\.\/\.\.\/lib\/secret-archive-policy["']/, 
  `from ${JSON.stringify(archivePolicyUrl)}`,
);
assert.ok(compiled.includes(archivePolicyUrl), "copied adapter must use the real source archive-policy module");
const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-backup-selftest-"));
const adapterFile = path.join(moduleDir, "TermuxBackupAdapter.mjs");
fs.writeFileSync(adapterFile, compiled, "utf8");
const { TermuxBackupAdapter } = await import(pathToFileURL(adapterFile).href);
const calls = [];
let archiveListing = "projects\nprojects/one.txt\n";
  const fakeEnv = {
    exec: async (command) => {
      calls.push(command);
      if (command.includes("tar -tzf ") && command.endsWith("| wc -l")) return { exitCode: 0, stdout: String(archiveListing.split(/\r?\n/).filter(Boolean).length) };
      if (command.includes("tar -xzf ") && command.includes("-O | wc -c")) return { exitCode: 0, stdout: "1" };
      if (command.includes("grep -a -i -E")) return { exitCode: 1, stdout: "" };
      if (command.startsWith("tar -tvzf ")) return { exitCode: 0, stdout: "drwxr-xr-x user/group 0 2026-01-01 00:00 projects\n-rw-r--r-- user/group 1 2026-01-01 00:00 projects/one.txt\n" };
      if (command.startsWith("tar -tzf ")) return { exitCode: 0, stdout: archiveListing };
    return { exitCode: 0, stdout: "" };
  },
  mkdir: async () => {},
};
const adapter = new TermuxBackupAdapter(fakeEnv, { root: "/termux/home" });
await adapter.restore("/tmp/backup's", ["/termux/home/projects"]);
const extraction = calls.find((command) => command.startsWith("tar -xzf ") && command.includes(" -C "));
assert.ok(extraction, "valid scoped archive should extract");
assert.ok(extraction.includes("'/tmp/backup'\\''s/ai-builder-data.tar.gz'"), "archive path must be shell-quoted");
assert.ok(extraction.includes("'projects/one.txt'"), "only validated member paths should reach tar");

archiveListing = "toolchains/bin/compiler\n";
await assert.rejects(
  adapter.restore("/tmp/archive", ["/termux/home/projects"]),
  /BACKUP_ARCHIVE_SCOPE_MISMATCH/,
);
archiveListing = "projects/../../outside.txt\n";
await assert.rejects(
  adapter.restore("/tmp/archive", ["/termux/home/projects"]),
  /BACKUP_ARCHIVE_UNSAFE_PATH/,
);
await assert.rejects(
  adapter.snapshot(["/termux/home-evil/projects"], "/tmp/out"),
  /BACKUP_PATH_OUTSIDE_HOME/,
);
assert.equal(calls.filter((command) => command.startsWith("tar -xzf ") && command.includes(" -C ")).length, 1, "invalid archives must not extract");
fs.rmSync(moduleDir, { recursive: true, force: true });
console.log("AIB_PHASE_D_BACKUP_SELFTEST_OK scope=confined traversal=blocked quoting=safe");
