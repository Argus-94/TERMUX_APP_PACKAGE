#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const priv = fs.readFileSync(path.join(root, "core/privilege/PrivilegeProvider.ts"), "utf8");
assert.match(priv, /execElevated/);

const det = fs.readFileSync(path.join(root, "core/privilege/DevicePrivilegeDetection.ts"), "utf8");
assert.match(det, /rish/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /Rebind providers/);
assert.match(facade, /new ShizukuProvider/);

const repair = fs.readdirSync(path.join(root, "scripts/repair")).filter((f) => f.endsWith(".sh"));
assert.ok(repair.length >= 15, `expected >=15 scripts, got ${repair.length}`);
for (const need of ["wget-curl.sh", "gradle-wrapper.sh", "local-properties.sh"]) {
  assert.ok(repair.includes(need), need);
}

const hard = fs.readFileSync(path.join(root, "docs/HARDENING_1_4_x.md"), "utf8");
assert.match(hard, /1\.6\.x closeout/);

console.log("aib-shizuku-repair-catalog-selftest: OK", { scripts: repair.length });
