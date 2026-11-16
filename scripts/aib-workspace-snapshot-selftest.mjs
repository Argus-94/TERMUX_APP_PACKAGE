#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const require = createRequire(import.meta.url);
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-snapshot-"));

function octalField(buffer, offset, length, value) {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
function tarHeader(name, { type = "0", linkName = "", size = 0 } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octalField(header, 100, 8, 0o644);
  octalField(header, 108, 8, 0);
  octalField(header, 116, 8, 0);
  octalField(header, 124, 12, size);
  octalField(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}
function makeTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "", "utf8");
    const type = entry.type ?? "0";
    blocks.push(tarHeader(entry.name, { type, linkName: entry.linkName ?? "", size: type === "0" ? content.length : 0 }));
    if (type === "0" && content.length) {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
function addRecord(metadataPath, record) {
  const records = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  records.push(record);
  fs.writeFileSync(metadataPath, JSON.stringify(records));
}

try {
  for (const rel of [
    "core/environment/ExecutionEnvironment.ts",
    "core/home/HomeLayout.ts",
    "core/project-manager.ts",
    "core/runtime/RuntimeStores.ts",
    "core/enhancements/snapshot/SnapshotExclude.ts",
    "core/enhancements/snapshot/WorkspaceSnapshot.ts",
    "lib/secret-archive-policy.ts",
  ]) {
    const dest = path.join(out, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typescript.transpile(fs.readFileSync(path.join(root, rel), "utf8"), {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    }));
  }

  const { WorkspaceSnapshot } = require(path.join(out, "core/enhancements/snapshot/WorkspaceSnapshot.js"));
  const { SnapshotExcludeError, parseSnapshotExcludeFile } = require(path.join(out, "core/enhancements/snapshot/SnapshotExclude.js"));
  const { createHomeLayout } = require(path.join(out, "core/home/HomeLayout.js"));
  assert.throws(() => parseSnapshotExcludeFile("-rf /"), (error) => error instanceof SnapshotExcludeError && error.code === "SNAPSHOT_EXCLUDE_PATTERN_INVALID");

  const homeRoot = path.join(out, "home");
  const home = createHomeLayout(homeRoot);
  const rootProject = path.join(home.projects, "demo");
  fs.mkdirSync(rootProject, { recursive: true });
  fs.mkdirSync(path.join(rootProject, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(rootProject, "dist"), { recursive: true });
  fs.mkdirSync(path.join(rootProject, ".aib"), { recursive: true });
  fs.writeFileSync(path.join(rootProject, "index.js"), "v1\n");
  fs.writeFileSync(path.join(rootProject, "node_modules/pkg/index.js"), "cache\n");
  fs.writeFileSync(path.join(rootProject, "dist/out.js"), "build\n");
  fs.writeFileSync(path.join(rootProject, ".env"), "OPENROUTER_API_KEY=should-not-snapshot\n");
  fs.writeFileSync(path.join(rootProject, "private.txt"), "private\n");
  fs.writeFileSync(path.join(rootProject, ".aib/snapshot-exclude"), "# project-specific\nprivate.txt\n");

  const env = {
    getHome: () => homeRoot,
    resolvePath: async (value) => path.resolve(value),
    exists: async (value) => fs.existsSync(value),
    mkdir: async (value) => fs.mkdirSync(value, { recursive: true }),
    read: async (value) => fs.readFileSync(value, "utf8"),
    write: async (value, contents) => { fs.mkdirSync(path.dirname(value), { recursive: true }); fs.writeFileSync(value, contents); },
    exec: async (command, options = {}) => {
      const result = spawnSync("/bin/sh", ["-lc", command], { cwd: options.cwd, encoding: "utf8", timeout: options.timeoutMs || 300_000 });
      return { exitCode: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
    },
  };
  let time = 1000;
  const snapshot = new WorkspaceSnapshot(env, home, { now: () => ++time });
  const record = await snapshot.createSnapshot(rootProject, "before work");
  assert.equal(record.projectId, "demo");
  assert.ok(fs.existsSync(record.archivePath));
  const listing = spawnSync("tar", ["-tzf", record.archivePath], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(listing.stdout.includes("index.js"));
  assert.ok(!listing.stdout.includes("node_modules"));
  assert.ok(!listing.stdout.includes("dist/"));
  assert.ok(!listing.stdout.includes(".env"));
  assert.ok(!listing.stdout.includes("private.txt"));
  assert.doesNotMatch(fs.readFileSync(record.archivePath).toString("latin1"), /should-not-snapshot/);

  const secretConfig = path.join(rootProject, "config.json");
  fs.writeFileSync(secretConfig, JSON.stringify({ OPENROUTER_API_KEY: "sk-SYNTHETICTESTFIXTURE01XXXXX6789" }));
  await assert.rejects(() => snapshot.createSnapshot(rootProject, "secret-bearing"), (error) => error.code === "SNAPSHOT_CREATE_FAILED");
  assert.equal(fs.readdirSync(path.join(home.backups, "workspace-snapshots", "demo")).filter((name) => name.endsWith(".tmp")).length, 0, "rejected secret archives are not left behind");
  fs.unlinkSync(secretConfig);

  fs.writeFileSync(path.join(rootProject, "index.js"), "v2\n");
  fs.writeFileSync(path.join(rootProject, "added.txt"), "new\n");
  const safety = await snapshot.restoreSnapshot(rootProject, record.id);
  assert.equal(fs.readFileSync(path.join(rootProject, "index.js"), "utf8"), "v1\n");
  assert.equal(fs.existsSync(path.join(rootProject, "added.txt")), false);
  assert.equal(safety.label, `pre-restore-${record.id}`);
  const preservedDirs = fs.readdirSync(home.projects).filter((name) => name.startsWith(".aib-before-restore-"));
  assert.equal(preservedDirs.length, 1, "the pre-restore workspace is retained rather than deleted");
  assert.equal(fs.readFileSync(path.join(home.projects, preservedDirs[0], ".env"), "utf8"), "OPENROUTER_API_KEY=should-not-snapshot\n");

  const fork = await snapshot.forkSnapshot(record.id, "forked");
  assert.equal(fs.readFileSync(path.join(fork, "index.js"), "utf8"), "v1\n");
  assert.equal(fs.existsSync(path.join(fork, ".env")), false);
  assert.equal((await snapshot.listSnapshots("forked")).length, 1);
  assert.equal((await snapshot.listSnapshots("demo")).length, 2);
  await assert.rejects(() => snapshot.createSnapshot(path.join(out, "outside")), (error) => error.code === "PROJECT_PATH_INVALID");
  await assert.rejects(() => snapshot.forkSnapshot(record.id, "../escape"));

  const snapshotDir = path.join(home.backups, "workspace-snapshots", "demo");
  fs.mkdirSync(snapshotDir, { recursive: true });
  const metadataPath = path.join(home.metadata, "workspace-snapshots.json");
  const outsideSentinel = path.join(home.projects, "outside-sentinel.txt");
  fs.writeFileSync(outsideSentinel, "must survive\n");
  const adversarial = [
    { id: "snap-traversal", name: "traversal.tar.gz", data: makeTarGz([{ name: "../outside-sentinel.txt", content: "overwritten\n" }]) },
    { id: "snap-symlink", name: "symlink.tar.gz", data: makeTarGz([{ name: "pivot", type: "2", linkName: "../../outside" }, { name: "pivot/payload.txt", content: "escape" }]) },
    { id: "snap-secret-content", name: "secret-content.tar.gz", data: makeTarGz([{ name: "config.json", content: JSON.stringify({ api_key: "sk-SYNTHETICTESTFIXTURE02XXXX6789" }) }]) },
    { id: "snap-empty", name: "empty.tar.gz", data: gzipSync(Buffer.alloc(1024)) },
    { id: "snap-corrupt", name: "corrupt.tar.gz", data: Buffer.from("not a gzip archive") },
  ];
  for (const item of adversarial) {
    const archivePath = path.join(snapshotDir, item.name);
    fs.writeFileSync(archivePath, item.data);
    addRecord(metadataPath, { id: item.id, projectId: "demo", archivePath, createdAt: ++time });
    await assert.rejects(
      () => snapshot.restoreSnapshot(rootProject, item.id),
      (error) => error.code === "SNAPSHOT_ARCHIVE_UNSAFE",
      `${item.id} must fail closed before extraction`,
    );
  }
  await assert.rejects(() => snapshot.forkSnapshot("snap-traversal", "evil"), (error) => error.code === "SNAPSHOT_ARCHIVE_UNSAFE");
  assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "must survive\n", "archive traversal must not write outside the project stage");
  assert.equal(fs.readFileSync(path.join(rootProject, "index.js"), "utf8"), "v1\n", "failed restore leaves the active workspace unchanged");

  console.log("AIB_WORKSPACE_SNAPSHOT_SELFTEST_OK secret-excludes=checked restore-safety-copy=retained corrupt=blocked empty=blocked traversal=blocked symlink=blocked");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
