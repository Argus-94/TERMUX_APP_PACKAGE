#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";
import { isAbsolutePosixPath, normalizeAbsolutePosixPath, resolvePosixPath } from "../lib/agent-tools/posix-path.ts";

const repo = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-agent-boundary-"));
const compiled = path.join(temp, "compiled");
const project = path.join(temp, "project");
const outside = path.join(temp, "outside");
fs.mkdirSync(compiled, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
try {
  for (const rel of [
    "lib/agent-tools/common.ts",
    "lib/agent-tools/fs/path-guard.ts",
    "lib/agent-tools/mutation-checkpoint.ts",
    "lib/agent-tools/runtime/terminal.ts",
    "lib/agent-tools/types.ts",
  ]) {
    const destination = path.join(compiled, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typescript.transpile(fs.readFileSync(path.join(repo, rel), "utf8"), {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    }));
  }
  const requireCompiled = createRequire(import.meta.url);
  const { projectPathGuardCommand } = requireCompiled(path.join(compiled, "lib/agent-tools/fs/path-guard.js"));
  fs.writeFileSync(path.join(project, "safe.txt"), "safe");
  fs.symlinkSync(outside, path.join(project, "alias"), "dir");

  const runGuard = (relativePath) => spawnSync("bash", ["-lc", `${projectPathGuardCommand(relativePath)} && printf ALLOWED`], {
    cwd: project,
    encoding: "utf8",
  });
  let result = runGuard("safe.txt");
  assert.equal(result.status, 0, `normal in-project path should pass: ${result.stderr}`);
  assert.match(result.stdout, /ALLOWED$/);
  result = runGuard("../outside/secret.txt");
  assert.notEqual(result.status, 0, "parent traversal must be denied");
  assert.match(result.stderr, /PROJECT_PATH_BLOCKED/);
  result = runGuard("alias/secret.txt");
  assert.notEqual(result.status, 0, "a symlinked parent alias must be denied");
  assert.match(result.stderr, /SYMLINK_COMPONENT/);
  result = runGuard("alias");
  assert.notEqual(result.status, 0, "a symlink leaf (including delete target) must be denied");
  assert.match(result.stderr, /SYMLINK_COMPONENT/);

  const { executeAfterMutationCheckpoint, isAgentToolMutation } = requireCompiled(path.join(compiled, "lib/agent-tools/mutation-checkpoint.js"));
  assert.equal(isAgentToolMutation("fs.create"), true);
  assert.equal(isAgentToolMutation("fs.delete"), true);
  assert.equal(isAgentToolMutation("fs.replace"), true);
  assert.equal(isAgentToolMutation("fs.replaceRange"), true);
  assert.equal(isAgentToolMutation("ast.edit"), true);
  const events = [];
  await assert.rejects(
    executeAfterMutationCheckpoint("fs.create", path.join(project, "new.txt"), undefined, async () => { events.push("mutation"); }),
    /FILE_WRITE_CHECKPOINT_UNAVAILABLE/,
  );
  assert.deepEqual(events, [], "mutation must not run when checkpoint hook is unavailable");
  await assert.rejects(
    executeAfterMutationCheckpoint("fs.delete", path.join(project, "safe.txt"), async () => { events.push("checkpoint-fail"); throw new Error("CHECKPOINT_FAILED"); }, async () => { events.push("mutation"); }),
    /CHECKPOINT_FAILED/,
  );
  assert.deepEqual(events, ["checkpoint-fail"], "a failed checkpoint must prevent mutation");
  events.length = 0;
  const value = await executeAfterMutationCheckpoint("fs.replace", path.join(project, "safe.txt"), async (target, tool) => { events.push(`checkpoint:${tool}:${target}`); }, async () => { events.push("mutation"); return "done"; });
  assert.equal(value, "done");
  assert.deepEqual(events, [`checkpoint:fs.replace:${path.join(project, "safe.txt")}`, "mutation"], "checkpoint must precede mutation");
  events.length = 0;
  await executeAfterMutationCheckpoint("ast.edit", project, async (target, tool) => { events.push(`checkpoint:${tool}:${target}`); }, async () => { events.push("mutation"); });
  assert.deepEqual(events, [`checkpoint:ast.edit:${project}`, "mutation"], "multi-file AST mutation checkpoints the exact project root before applying changes");

  const terminal = requireCompiled(path.join(compiled, "lib/agent-tools/runtime/terminal.js"));
  await assert.rejects(terminal.execute({ projectId: "demo" }), /ISOLATED_TERMINAL_UNAVAILABLE/);

  const source = fs.readFileSync(path.join(repo, "lib/agent-tools/index.ts"), "utf8");
  const runtimeFacade = fs.readFileSync(path.join(repo, "core/RuntimeFacade.ts"), "utf8");
  assert.match(source, /executeAfterMutationCheckpoint/);
  assert.match(source, /FILE_WRITE_CHECKPOINT_UNAVAILABLE|executeAfterMutationCheckpoint/);
  assert.doesNotMatch(source, /from\s+["']node:path["']/i, "production agent-tools must not import Node-only path in the React Native bundle");
  assert.match(source, /from\s+["']\.\/posix-path["']/);
  assert.match(runtimeFacade, /normalizeAbsolutePosixPath\(projectRoot\)/);
  assert.match(runtimeFacade, /canonicalTarget !== canonicalRoot && !canonicalTarget\.startsWith/);
  assert.equal(isAbsolutePosixPath("/data/user/0/app/files/project"), true);
  assert.equal(isAbsolutePosixPath("relative/project"), false);
  const projectRoot = normalizeAbsolutePosixPath("/data/user/0/app/files/./project/child/..");
  assert.equal(projectRoot, "/data/user/0/app/files/project");
  assert.equal(resolvePosixPath(projectRoot, "src/../src/App.tsx"), `${projectRoot}/src/App.tsx`);
  const escaped = resolvePosixPath(projectRoot, "../../outside/secret.txt");
  assert.equal(escaped.startsWith(`${projectRoot}/`), false, "normalized parent traversal must remain outside the project boundary and be denied");
  assert.equal(resolvePosixPath(projectRoot, "/etc/passwd"), "/etc/passwd", "absolute targets must not be re-rooted inside the project");
  assert.throws(() => resolvePosixPath(projectRoot, "bad\0path"), /PATH_NOT_ALLOWED/);
  console.log("AIB_AGENT_BOUNDARY_CHECKPOINT_SELFTEST_OK traversal=blocked symlink_alias=blocked checkpoint_order=verified missing_checkpoint=fail_closed mobile_node_path_import=none posix_path_boundary=verified");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
