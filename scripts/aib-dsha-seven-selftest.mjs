#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const files = [
  "lib/security-policy.ts",
  "docs/SECURITY_POLICY.md",
  "lib/backup-secrets-policy.ts",
  "lib/agent-presets.ts",
  "lib/aib-plugins.ts",
  "lib/terminal-tabs.ts",
  "lib/lan-status-bridge.ts",
  "components/RuntimeStatusOverlay.tsx",
];
for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f);

const pol = fs.readFileSync(path.join(root, "lib/security-policy.ts"), "utf8");
assert.match(pol, /evaluateCommandPolicy/);
assert.match(pol, /assertCommandAllowed/);

const ex = fs.readFileSync(path.join(root, "lib/termux-executor.ts"), "utf8");
assert.match(ex, /assertCommandAllowed/);

const sh = fs.readFileSync(path.join(root, "lib/shizuku-bridge.ts"), "utf8");
assert.match(sh, /assertCommandAllowed/);

const ctx = fs.readFileSync(path.join(root, "components/TermuxConsoleContext.tsx"), "utf8");
assert.match(ctx, /addTab/);
assert.match(ctx, /createTerminalTab/);

const lay = fs.readFileSync(path.join(root, "app/_layout.tsx"), "utf8");
assert.match(lay, /RuntimeStatusOverlay/);

const settings = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");
assert.match(settings, /applyAgentPreset/);
assert.match(settings, /setPluginSafeMode/);
assert.match(settings, /setLanBridgeEnabled/);

console.log("aib-dsha-seven-selftest: OK");
