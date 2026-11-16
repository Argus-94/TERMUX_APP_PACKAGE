#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const hints = fs.readFileSync(path.join(root, "lib/agent-repair-hints.ts"), "utf8");
assert.match(hints, /collectHealthRepairHints/);
assert.match(hints, /formatProtocolAbortHint/);
assert.match(hints, /toolchain\.git/);
assert.match(hints, /proot-distro-pkg/);
const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
assert.match(agent, /formatProtocolAbortHint/);
assert.match(agent, /AGENT_PROTOCOL_ABORT/);
console.log("AIB_PHASE_F_AGENT_SELFTEST_OK");
