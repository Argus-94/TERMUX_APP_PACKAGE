#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.doesNotMatch(ui, /setMessage\("Укажите путь/);
assert.doesNotMatch(ui, /setBootMsg\("Стадии сброшены"\)/);
assert.match(ui, /Сброс карантина|Clear quarantine/);
assert.match(ui, /Open unrepaired entries/);

const fg = fs.readFileSync(path.join(root, "lib/foreground-task.ts"), "utf8");
assert.match(fg, /Math\.min\(1, Math\.max\(0/);

const loader = fs.readFileSync(path.join(root, "core/runtime/native-accel-loader.ts"), "utf8");
assert.match(loader, /await mod\.isAvailable\(\)/);
assert.match(loader, /await mod\.probe\(\)/);

const agent = fs.readFileSync(path.join(root, "lib/script-runner-agent.ts"), "utf8");
assert.match(agent, /markAgentHealth\("failed", "aborted"\)/);

const ri = fs.readFileSync(path.join(root, "lib/runtime-i18n.ts"), "utf8");
assert.match(ri, /Канарейка/);

console.log("aib-audit-i18n-selftest: OK");
