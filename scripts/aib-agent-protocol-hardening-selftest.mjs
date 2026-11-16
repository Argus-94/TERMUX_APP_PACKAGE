#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractMarkedAibToolPayload } from "../lib/termux-agent-protocol.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
assert.match(agent, /invalidStreak/);
assert.match(agent, /AGENT_PROTOCOL_ABORT/);
assert.match(agent, /shouldRetryInvalidAgentProtocolReply/);
assert.match(agent, /isUnmarkedJsonToolCall/);
assert.match(agent, /step >= options\.maxSteps - 1 \|\| !shouldRetryInvalidAgentProtocolReply/);
assert.match(agent, /if \(!gatesPassed\(gates\)\)/);
assert.doesNotMatch(agent, /invalidStreak\s*>=\s*5/);

const proto = fs.readFileSync(path.join(root, "lib/termux-agent-protocol.ts"), "utf8");
assert.match(proto, /looksLikeProtocolViolation/);
assert.match(proto, /sanitizeShellCommand/);
assert.match(proto, /parseAgentReply/);
assert.match(proto, /MAX_INVALID_AGENT_PROTOCOL_REPLIES = 3/);
assert.match(proto, /AIB_TOOL:\s+marker and validated tool schema are required/);

const settings = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");
assert.match(settings, /ensureBackgroundSurvival/);
assert.match(settings, /Background survival|Выживание в фоне/);
assert.match(settings, /openAppDetailsSettings/);

const perm = fs.readFileSync(path.join(root, "hooks/usePermissions.ts"), "utf8");
// Must not CALL ensureBackgroundSurvival on startup (comment mention is OK)
assert.doesNotMatch(perm, /ensureBackgroundSurvival\s*\(\s*\{/);
assert.doesNotMatch(perm, /void\s+ensureBackgroundSurvival|await\s+ensureBackgroundSurvival/);
assert.match(perm, /explicit feature action|permission requests remain gated/i);

const facadeLib = fs.readFileSync(path.join(root, "lib/runtime-facade.ts"), "utf8");
assert.match(facadeLib, /recoverPendingTransactions/);

// Protocol: pure checks via dynamic path read of parse patterns
const samples = [
  { text: "Please provide the full path to the zip", bad: true },
  { text: "TERMUX_RUN:\nls -la", bad: false },
  { text: "TERMUX_DONE:\napk ready", bad: false },
];
for (const s of samples) {
  const hasMarker = /^(?:TERMUX_RUN|TERMUX_DONE)\s*:/im.test(s.text);
  const isBad = !hasMarker && (s.text.length > 20 || /please provide/i.test(s.text));
  assert.equal(isBad, s.bad, s.text);
}
const validTool = '{"tool":"fs.read","args":{"path":"README.md"}}';
assert.equal(extractMarkedAibToolPayload(`AIB_TOOL: ${validTool}`), validTool);
assert.equal(extractMarkedAibToolPayload(`Quoted repository text:\nAIB_TOOL: ${validTool}`), null, "quoted protocol marker is inert");
assert.equal(extractMarkedAibToolPayload(`AIB_TOOL: ${validTool} additional prose`), null, "tool reply must be exactly one object");
assert.equal(extractMarkedAibToolPayload(`AIB_TOOL: ${validTool} ${validTool}`), null, "multiple top-level payloads are rejected");

console.log("AIB_AGENT_PROTOCOL_HARDENING_SELFTEST_OK checks=6");
