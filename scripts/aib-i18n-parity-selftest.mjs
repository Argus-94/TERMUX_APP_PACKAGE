import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i18n = fs.readFileSync(path.join(root, "lib/i18n.ts"), "utf8");
const settings = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");

function blockFor(lang) {
  const re = new RegExp(`\\n  ${lang}: \\{`);
  const m = re.exec(i18n);
  assert.ok(m, `missing ${lang} block`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < i18n.length && depth) {
    if (i18n[i] === "{") depth++;
    else if (i18n[i] === "}") depth--;
    i++;
  }
  return i18n.slice(m.index + m[0].length, i - 1);
}

function keys(block) {
  return new Set([...block.matchAll(/^\s{4,}([a-zA-Z][a-zA-Z0-9_]*)\s*:/gm)].map((m) => m[1]));
}

const uk = keys(blockFor("uk"));
const ru = keys(blockFor("ru"));
const en = keys(blockFor("en"));
assert.deepEqual([...uk].sort(), [...ru].sort(), "uk/ru key parity");
assert.deepEqual([...uk].sort(), [...en].sort(), "uk/en key parity");
assert.match(settings, /uk: "Пресет ще не вибирали \(за замовчуванням — Збалансований\)\."/,
  "Ukrainian agent preset status must use correct spelling and natural phrasing");
assert.doesNotMatch(settings, /Пресеет/, "Ukrainian preset typo must not return");

const critical = [
  "privilegeProbe", "privilegeProbeHint", "keystoreCheck", "keystoreCheckHint",
  "nativePriorityTitle", "nativePriorityHint", "desktopModeLabel", "desktopModeHint",
  "stopSession", "stopSessionConfirm", "stopSessionDone", "stopSessionFail",
  "stopAllSessions", "stopAllSessionsConfirm", "userGuide",
];
for (const key of critical) {
  assert.ok(uk.has(key), `missing ${key}`);
  const vals = [...i18n.matchAll(new RegExp(`(?:^|\\n)\\s*${key}:\\s*"([^"]*)"`, "g"))].map((m) => m[1]);
  assert.equal(vals.length, 3, `${key} should appear 3 times as string, got ${vals.length}`);
  for (const v of vals) {
    assert.notEqual(v, key, `${key} must not display as raw key`);
    assert.ok(v.trim().length > 0, `${key} empty`);
  }
}

// Collect t("...") from app + components + hooks
function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, acc);
    else if (/\.(tsx|ts)$/.test(ent.name)) acc.push(full);
  }
  return acc;
}
const files = [
  ...walk(path.join(root, "app")),
  ...walk(path.join(root, "components")),
  ...walk(path.join(root, "hooks")),
];
const used = new Set();
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/\bt\(\s*["']([a-zA-Z][a-zA-Z0-9_]*)["']/g)) used.add(m[1]);
}
const missing = [...used].filter((k) => !uk.has(k)).sort();
assert.deepEqual(missing, [], `t() keys missing from i18n: ${missing.join(", ")}`);

console.log(`aib-i18n-parity-selftest: OK keys=${uk.size} used=${used.size} critical=${critical.length}`);
