#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";
const root = process.cwd();
const ts = typescript;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-checkpoint-"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-checkpoint-js-"));
const rels = ["core/enhancements/checkpoint/types.ts", "core/enhancements/checkpoint/GitPrivateRef.ts", "core/enhancements/checkpoint/TaskCheckpointManager.ts"];
try {
  for (const rel of rels) { const dest = path.join(out, rel.replace(/\.ts$/, ".js")); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, ts.transpile(fs.readFileSync(path.join(root, rel), "utf8"), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 })); }
  const home = path.join(temp, "home"); const repo = path.join(home, "projects", "demo"); fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n"); git("add", "tracked.txt"); git("-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "base");
  const initialHead = git("rev-parse", "HEAD"); const userIndexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
  fs.writeFileSync(path.join(repo, "tracked.txt"), "checkpoint\n"); fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
  const { GitPrivateRef } = createRequire(import.meta.url)(path.join(out, "core/enhancements/checkpoint/GitPrivateRef.js"));
  const runner = async (cwd, command, env) => { try { const stdout = execFileSync("/bin/sh", ["-c", command], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...env }, encoding: "utf8" }); return { exitCode: 0, stdout, stderr: "" }; } catch (e) { return { exitCode: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" }; } };
  const refs = new GitPrivateRef(home, runner);
  const sha = await refs.createCheckpoint(repo, "task-1");
  assert.match(sha, /^[a-f0-9]{40,64}$/);
  assert.equal(git("rev-parse", "HEAD"), initialHead);
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), userIndexBefore);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "changed\n"); fs.writeFileSync(path.join(repo, "new.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, "user-created-after-checkpoint.txt"), "keep this user data\n");
  await refs.restoreCheckpoint(repo, "task-1");
  assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "checkpoint\n");
  assert.equal(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "new\n");
  assert.equal(fs.readFileSync(path.join(repo, "user-created-after-checkpoint.txt"), "utf8"), "keep this user data\n");
  assert.equal(git("rev-parse", "HEAD"), initialHead);
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), userIndexBefore);
  assert.equal((await refs.listCheckpoints(repo))[0].taskId, "task-1");
  const conflictRepo = path.join(home, "projects", "conflict"); fs.mkdirSync(conflictRepo, { recursive: true });
  const conflictGit = (...args) => execFileSync("git", args, { cwd: conflictRepo, encoding: "utf8" }).trim();
  conflictGit("init", "-q"); fs.writeFileSync(path.join(conflictRepo, "target.txt"), "checkpoint file\n");
  conflictGit("add", "target.txt"); conflictGit("-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "base");
  const conflictRefs = new GitPrivateRef(home, runner); await conflictRefs.createCheckpoint(conflictRepo, "conflict-1");
  fs.rmSync(path.join(conflictRepo, "target.txt")); fs.mkdirSync(path.join(conflictRepo, "target.txt"));
  fs.writeFileSync(path.join(conflictRepo, "target.txt", "user.txt"), "conflicting user data\n");
  await assert.rejects(() => conflictRefs.restoreCheckpoint(conflictRepo, "conflict-1"), (error) => error.code === "GIT_COMMAND_FAILED");
  assert.equal(fs.readFileSync(path.join(conflictRepo, "target.txt", "user.txt"), "utf8"), "conflicting user data\n");
  console.log("AIB_TASK_CHECKPOINT_SELFTEST_OK assertions=12 untracked=preserved file-directory-conflict=preserved HEAD-index=unchanged");
} finally { fs.rmSync(temp, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
