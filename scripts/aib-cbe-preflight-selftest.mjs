#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = fs.readFileSync(path.join(root, "scripts/aib-cbe-preflight.mjs"), "utf8");
assert.match(source, /const activePluginsBlock = pluginsBlock[\s\S]*?const lastPlugin = activePluginsBlock\.split\(","\)[\s\S]*?at\(-1\)/);
assert.ok(source.includes('.replace(/\\/\\/.*$/gm, "")'), "CBE must ignore line comments when checking plugin order");
assert.ok(source.includes('!/^withFixGradleProperties\\s*$/.test(lastPlugin)'), "CBE must reject any plugin after withFixGradleProperties");
console.log("AIB_CBE_PREFLIGHT_SELFTEST_OK final-plugin-position=enforced");
