#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const about = fs.readFileSync(path.join(root, "lib/about-content.ts"), "utf8");
assert.match(about, /id: "what"[\s\S]*?uk: "Що це"[\s\S]*?ru: "Что это"[\s\S]*?en: "What it is"/);
assert.match(about, /Середовище|Среда|Runtime screen/);
const guide = fs.readFileSync(path.join(root, "lib/settings-guide.ts"), "utf8");
assert.match(guide, /id: "start"/);
assert.match(guide, /id: "custom-2"/);
assert.match(guide, /id: "offline-params"[\s\S]*?«Авто» подстраивает|id: "offline-params"[\s\S]*?Auto tunes/);
assert.match(guide, /id: "runtime-screen"/);
assert.match(guide, /id: "quick-checklist"/);
assert.match(guide, /Завантажити в пам’ять|Загрузить в память|Load into memory/);
assert.match(guide, /id: "agent-intelligence"[\s\S]*?balanced \/ coder \/ careful/);
console.log("aib-about-guide-selftest: OK");
