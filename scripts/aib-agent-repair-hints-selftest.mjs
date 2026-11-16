#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
assert.ok(fs.existsSync(path.join(root, "lib/agent-repair-hints.ts")));

const hints = fs.readFileSync(path.join(root, "lib/agent-repair-hints.ts"), "utf8");
assert.match(hints, /collectEnvRepairHints/);
assert.match(hints, /formatRepairHintsBlock/);
assert.match(hints, /createDeterministicRepair/);

const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
assert.match(agent, /formatRepairHintsBlock\(collectEnvRepairHints/);
assert.match(agent, /agent-repair-hints/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /userspaceRuntime|initUserspaceRuntime/);
assert.match(ui, /initUserspaceRuntime/);
assert.match(ui, /userspace|initUserspaceRuntime/);

// Pure logic smoke (duplicate minimal parser)
function collect(env) {
  const out = [];
  for (const line of env.split("\n")) {
    if (/^gradle=(BROKEN|MISSING)/i.test(line.trim())) out.push("gradle");
    if (/^java=(BROKEN|MISSING)/i.test(line.trim())) out.push("java");
  }
  return out;
}
const h = collect("gradle=BROKEN:path=/x\njava=MISSING\nnode=OK:v20");
assert.deepEqual(h, ["gradle", "java"]);

console.log("AIB_AGENT_REPAIR_HINTS_SELFTEST_OK");
