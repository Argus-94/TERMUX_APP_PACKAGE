#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /failureJournal\.record/);
assert.match(facade, /HEALTH_ERROR/);
assert.match(facade, /async runHealthChecks/);

const sr = fs.readFileSync(path.join(root, "lib/script-runner-agent.ts"), "utf8");
assert.match(sr, /recipes\.push\("java-install"\)/);
assert.match(sr, /runRepairRecipe\(recipeId, \{ allowMedium: true \}\)/);
assert.doesNotMatch(sr, /pkg install -y openjdk-17/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /heart-outline/);
assert.match(ui, /Исправить всё|allowlisted recipes/);

console.log("AIB_FAILURE_JOURNAL_SELFTEST_OK");
