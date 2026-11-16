#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const i18n = fs.readFileSync(path.join(root, "lib/i18n.ts"), "utf8");
const hints = [...i18n.matchAll(/settingsGuideHint:\s*"([^"]*)"/g)].map((m) => m[1]);
assert.equal(hints.length, 3);
assert.match(hints[0], /Покроково|Середовище/);
assert.match(hints[1], /Пошагово|Среда/);
assert.match(hints[2], /Step-by-step|Runtime/);
assert.doesNotMatch(i18n, /customProvider2Title: ".*DeepSeek/);
assert.doesNotMatch(i18n, /для модели 4B|for the 4B model/);
const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /Итоговая проверка: OK=/);
console.log("aib-audit-i18n-hints-selftest: OK", { hints: hints.map((h) => h.slice(0, 40)) });
