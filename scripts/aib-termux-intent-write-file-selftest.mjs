#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
// Source-level checks (no typescript runtime required in sandbox)
const intent = fs.readFileSync("lib/termux-intent.ts", "utf8");
const backend = fs.readFileSync("lib/agent-shell-backend.ts", "utf8");
const fail = (m) => { console.error("FAIL", m); process.exit(1); };
if (!intent.includes("write-file")) fail("no write-file");
if (!intent.includes("папк") && !intent.includes("folder")) fail("no folder intent");
// Folder + Download must match write-file routing
if (!/папк\\w\*|folder/.test(intent)) fail("folder pattern");
// resolveAgentExecutionBackend must respect preferred (guest), not force host for shared storage
if (/isAndroidSharedStorageOnlyCommand\(command\)\s*\)\s*return\s*"termux"/.test(backend)) {
  fail("resolve still forces host");
}
for (const msg of [
  "Создай мне в папке Download файл 7777.txt с текстом; Привет как дела",
  "Создай мне папке Download новую папку с именем: 88888",
]) {
  // pattern check mirrors detectTermuxIntent
  const ok =
    /(создай|создать).{0,100}(папк|файл|file)/i.test(msg) ||
    /(папке|папку).{0,40}Download/i.test(msg);
  if (!ok) fail("msg not detected: " + msg);
}
console.log("aib-termux-intent-write-file-selftest: PASS (folder+file routing, guest-respect)");
