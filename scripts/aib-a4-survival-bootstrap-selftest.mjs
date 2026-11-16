#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const survival = fs.readFileSync(path.join(root, "lib/background-survival.ts"), "utf8");
assert.match(survival, /notePossibleBuildKill/);
assert.match(survival, /maybeSurvivalReminder/);
assert.match(survival, /buildKillCount/);
assert.doesNotMatch(survival, /maybeSurvivalReminder[\s\S]{0,400}ensureBackgroundSurvival\(/);

const notif = fs.readFileSync(path.join(root, "lib/app-notifications.ts"), "utf8");
assert.match(notif, /notifyBootstrapProgress/);

const rt = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(rt, /withForegroundTask\("bootstrap"/);
assert.match(rt, /notifyBootstrapProgress/);
assert.match(rt, /notePossibleBuildKill/);
assert.match(rt, /exportHealthReport/);
// no double close after backup card
assert.doesNotMatch(rt, /<\/View>\s*<\/View>\s*\{lastBootInfo/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /exportHealthReport/);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
console.log("aib-a4-survival-bootstrap-selftest: OK", { version: pkg.version });
