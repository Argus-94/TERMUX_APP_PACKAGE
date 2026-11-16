#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const notif = fs.readFileSync(path.join(root, "lib/app-notifications.ts"), "utf8");
assert.match(notif, /Выгрузить из памяти/);
assert.match(notif, /wasSession/);
assert.match(notif, /user requested model unload/);

const ka = fs.readFileSync(path.join(root, "lib/keep-alive.ts"), "utf8");
assert.match(ka, /pinned in memory while session notification/);
assert.match(ka, /isPinned/);

const settings = fs.readFileSync(path.join(root, "hooks/useAppSettings.ts"), "utf8");
assert.match(settings, /Empty defaults — same as Custom #1/);

const i18n = fs.readFileSync(path.join(root, "lib/i18n.ts"), "utf8");
assert.match(i18n, /customProvider2Title: "Кастомный №2"/);

const ui = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");

for (const f of ["lib/shizuku-bridge.ts", "lib/profile-transfer.ts", "lib/foreground-task.ts", "lib/repair-script-runner.ts"]) {
  const t = fs.readFileSync(path.join(root, f), "utf8");
  assert.match(t, /persistentLogger/, f);
}

console.log("aib-model-pin-custom2-log-selftest: OK");
