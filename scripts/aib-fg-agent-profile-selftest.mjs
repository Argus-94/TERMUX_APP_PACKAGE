#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const agent = fs.readFileSync(path.join(root, "lib/script-runner-agent.ts"), "utf8");
assert.match(agent, /withForegroundTask\("agent"/);
assert.match(agent, /runScriptWithAgentInner/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /withForegroundTask\("backup", "Export profile"/);
assert.match(ui, /withForegroundTask\("restore", "Import profile"/);

const plan = fs.readFileSync(path.join(root, "docs/plan-dsha-parity.md"), "utf8");
assert.match(plan, /1\.6\.15|FG agent/);

console.log("aib-fg-agent-profile-selftest: OK");
