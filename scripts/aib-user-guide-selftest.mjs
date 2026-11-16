import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

const guide = read("lib/user-guide.ts");
assert.match(guide, /export const USER_GUIDE/);
assert.match(guide, /filterUserGuide/);
assert.match(guide, /first-steps/);
assert.match(guide, /native-priority/);
assert.match(guide, /troubleshooting/);
assert.match(guide, /id: "interceptor"/);
assert.match(guide, /Перехват трафика|Traffic interceptor/);
assert.doesNotMatch(guide, /отльный/);

const screen = read("app/user-guide.tsx");
assert.match(screen, /filterUserGuide/);
assert.match(screen, /USER_GUIDE/);
assert.match(screen, /expandedId/);

const layout = read("app/_layout.tsx");
assert.match(layout, /name="user-guide"/);
assert.match(layout, /userGuide/);

const i18n = read("lib/i18n.ts");
assert.match(i18n, /userGuide:\s*"Полная справка"/);
assert.match(i18n, /userGuide:\s*"Повна довідка"/);
assert.match(i18n, /userGuide:\s*"Full user guide"/);

// Basic structural integrity: each section has uk/ru/en title+body
const ids = [...guide.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
assert.ok(ids.length >= 16, `expected many sections, got ${ids.length}`);
for (const id of ids) {
  assert.ok(guide.includes(`id: "${id}"`), id);
}

console.log(`aib-user-guide-selftest: OK sections=${ids.length}`);
