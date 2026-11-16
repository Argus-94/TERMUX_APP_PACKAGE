#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const doc = path.join(root, "docs", "DEVICE_SMOKE.md");
const errors = [];
if (!fs.existsSync(doc)) errors.push("missing docs/DEVICE_SMOKE.md");
else {
  const t = fs.readFileSync(doc, "utf8");
  for (const n of ["TERMUX_MIRRORS", "termux-change-repo", "Gradle", "Flutter", "Maven", "AUTO_REPAIR"]) {
    if (!t.includes(n)) errors.push("DEVICE_SMOKE missing: " + n);
  }
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("AIB_DEVICE_SMOKE_DOC_SELFTEST_OK");
