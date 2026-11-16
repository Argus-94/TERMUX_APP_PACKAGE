#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AIB_USER_SCRIPT_PATH, materializeUserScript, shellPathExpr } from "../lib/builtin-build-script.ts";

assert.equal(AIB_USER_SCRIPT_PATH, "$PREFIX/tmp/aibuilder-scripts/aib-user-script.sh");
const body = "#!/bin/sh\necho local-fixture\n";
const successCalls = [];
const storedAt = await materializeUserScript(body, async (command) => {
  successCalls.push(command);
  if (command.includes("echo PREP_OK")) return { exitCode: 0, stdout: "PREP_OK", stderr: "" };
  if (command.includes("printf 'SIZE=%s")) return { exitCode: 0, stdout: `SIZE=${Buffer.byteLength(body)}`, stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
});
assert.equal(storedAt, AIB_USER_SCRIPT_PATH);
assert.ok(successCalls.some((command) => command.includes('"$PREFIX"') && command.includes("'/tmp/aibuilder-scripts/aib-user-script.sh'")));
assert.ok(successCalls.every((command) => !command.includes("/storage/emulated/0/AIBuilderTermux")), "user script materialization must not write into shared storage");

const deniedCalls = [];
await assert.rejects(
  materializeUserScript(body, async (command) => {
    deniedCalls.push(command);
    return { exitCode: 1, stdout: "", stderr: "permission denied" };
  }),
  /Cannot prepare private Termux script file/,
);
assert.equal(deniedCalls.length, 1, "private-path denial fails closed instead of trying a shared-storage fallback");
assert.ok(deniedCalls.every((command) => !command.includes("/storage/emulated/0/AIBuilderTermux")));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "aib-script-path-quote-"));
try {
  const injectedPath = "$HOME/aibuilder-scripts/$(touch INJECTED).sh";
  const quotedPath = shellPathExpr(injectedPath);
  const expanded = spawnSync("/bin/sh", ["-c", `printf '%s\\n' ${quotedPath}`], {
    cwd: sandbox,
    env: { ...process.env, HOME: sandbox },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(expanded.status, 0, expanded.stderr);
  assert.equal(expanded.stdout.trim(), path.join(sandbox, "aibuilder-scripts/$(touch INJECTED).sh"));
  assert.equal(fs.existsSync(path.join(sandbox, "INJECTED")), false, "command substitution remains a literal path segment");

  const executeShell = async (command) => {
    const r = spawnSync("/bin/sh", ["-c", command], { cwd: sandbox, env: { ...process.env, HOME: sandbox }, encoding: "utf8", timeout: 5000 });
    return { exitCode: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
  };
  const materialized = await materializeUserScript(body, executeShell, { scriptPath: injectedPath });
  assert.equal(materialized, injectedPath);
  assert.equal(fs.existsSync(path.join(sandbox, "INJECTED")), false, "materialization never executes path metacharacters");
  assert.equal(fs.readFileSync(path.join(sandbox, "aibuilder-scripts/$(touch INJECTED).sh"), "utf8"), body);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log("AIB_SCRIPT_MATERIALIZATION_PATH_SELFTEST_OK private_home=PASS no_shared_fallback=PASS denial_fails_closed=PASS shell_metacharacters=literal");
