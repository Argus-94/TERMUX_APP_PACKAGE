#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-workspace-backup-"));
try {
  for (const rel of ["core/workspace/PersistentAIWorkspace.ts", "core/project-manager.ts", "lib/secret-archive-policy.ts"]) {
    const dest = path.join(out, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typescript.transpile(fs.readFileSync(path.join(root, rel), "utf8"), {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    }));
  }
  const require = createRequire(import.meta.url);
  const { PersistentAIWorkspace } = require(path.join(out, "core/workspace/PersistentAIWorkspace.js"));
  const home = {
    root: path.join(out, "home"),
    projects: path.join(out, "home", "projects"),
    cache: path.join(out, "home", "cache"),
  };
  const project = path.join(home.projects, "demo");
  fs.mkdirSync(project, { recursive: true });
  const bridgeToken = "aib_ab12cd34ef561700000000000";
  fs.writeFileSync(path.join(project, "config.json"), JSON.stringify({ bridge: bridgeToken }));

  const env = {
    async mkdir(target) { fs.mkdirSync(target, { recursive: true }); },
    async exists(target) { return fs.existsSync(target); },
    async read(target) { return fs.readFileSync(target, "utf8"); },
    async write(target, contents) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); },
    async exec(command, options = {}) {
      if (command.startsWith("git -C ")) {
        if (command.includes("rev-parse --is-inside-work-tree")) return { exitCode: 0, stdout: "true\n", stderr: "" };
        if (command.includes("rev-parse HEAD")) return { exitCode: 0, stdout: "synthetic-head\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const result = spawnSync("/bin/sh", ["-lc", command], { cwd: options.cwd, encoding: "utf8", timeout: options.timeoutMs || 300_000 });
      return { exitCode: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
    },
  };
  const workspace = new PersistentAIWorkspace(env, home);
  await assert.rejects(() => workspace.snapshot("demo", "bridge-secret"), /WORKSPACE_SNAPSHOT_SECRET_CONTENT_FORBIDDEN/);
  const snapshotsDir = path.join(project, ".aib-snapshots");
  assert.deepEqual(fs.existsSync(snapshotsDir) ? fs.readdirSync(snapshotsDir) : [], [], "secret-bearing UI snapshots are not committed and temp archives are removed");

  fs.writeFileSync(path.join(project, "config.json"), JSON.stringify({ mode: "safe" }));
  fs.writeFileSync(path.join(project, "index.js"), "preserve-current\n");
  const valid = await workspace.snapshot("demo", "safe");
  assert.ok(fs.existsSync(valid.archivePath), "safe workspace snapshot is committed after scan");

  const stage = path.join(out, "restore-stage");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "config.json"), JSON.stringify({ bridge: bridgeToken }));
  const evilArchive = path.join(snapshotsDir, "evil.tar.gz");
  const created = spawnSync("tar", ["-czf", evilArchive, "-C", stage, "."], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  await assert.rejects(() => workspace.restoreSnapshot("demo", "evil"), /WORKSPACE_SNAPSHOT_SECRET_CONTENT_FORBIDDEN/);
  assert.equal(fs.readFileSync(path.join(project, "index.js"), "utf8"), "preserve-current\n", "secret archive is rejected before restore mutates the workspace");

  console.log("AIB_WORKSPACE_BACKUP_SELFTEST_OK ui_snapshot_scan=verified bridge_token=blocked restore_scan=verified");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
