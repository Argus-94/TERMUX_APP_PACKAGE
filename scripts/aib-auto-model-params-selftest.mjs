#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const dp = fs.readFileSync(path.join(root, "lib/device-profile.ts"), "utf8");
assert.match(dp, /analyzeGgufModel/);
assert.match(dp, /ModelAnalysis/);
assert.match(dp, /temperature/);
assert.match(dp, /maxTokens/);
assert.match(dp, /weightGb|freeAfterModel|paramsB/);

const lm = fs.readFileSync(path.join(root, "lib/local-model.ts"), "utf8");
assert.match(lm, /getOnDiskModelInfo/);

const settings = fs.readFileSync(path.join(root, "hooks/useAppSettings.ts"), "utf8");
assert.match(settings, /applyOptimalLocalSettings/);
assert.match(settings, /computeOptimalSettings/);
assert.match(settings, /localParamsAuto\) \{\s*applyOptimalLocalSettings/);

const i18n = fs.readFileSync(path.join(root, "lib/i18n.ts"), "utf8");
assert.match(i18n, /Авто \(телефон \+ модель\)|Auto \(device \+ model\)/);

console.log("aib-auto-model-params-selftest: OK");
