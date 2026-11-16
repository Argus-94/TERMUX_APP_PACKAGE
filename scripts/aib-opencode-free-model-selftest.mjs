#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const llm = fs.readFileSync(path.join(root, "hooks/useLLM.ts"), "utf8");
assert.doesNotMatch(llm, /бесплатная модель доступна только внутри OpenCode/);
assert.doesNotMatch(llm, /выберите платную модель OpenCode Zen/);

const settings = fs.readFileSync(path.join(root, "hooks/useAppSettings.ts"), "utf8");
assert.doesNotMatch(settings, /Migrated stale OpenCode free model/);
assert.doesNotMatch(settings, /Cleared stale OpenCode free model/);
assert.match(settings, /free models \(\*-free, big-pickle\) are kept|Free and paid OpenCode|no longer forces paid/i);

console.log("AIB_OPENCODE_FREE_MODEL_SELFTEST_OK");
