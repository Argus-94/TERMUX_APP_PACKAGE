#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const layout = fs.readFileSync(path.join(root, "app/_layout.tsx"), "utf8");
assert.match(layout, /startupTrace\.begin/);
assert.match(layout, /recoverPendingTransactions/);
assert.match(layout, /markReady/);
assert.match(layout, /getRuntimeFacade/);

const hook = fs.readFileSync(path.join(root, "hooks/useRuntime.ts"), "utf8");
assert.match(hook, /runHealthChecks/);
assert.match(hook, /repairHealth/);
assert.match(hook, /initUserspace/);

const doc = fs.readFileSync(path.join(root, "docs/HARDENING_1_4_x.md"), "utf8");
assert.match(doc, /1\.4\.8/);
assert.match(doc, /AibUserspaceRuntime/);

// Ensure no auto survival in permissions
const perm = fs.readFileSync(path.join(root, "hooks/usePermissions.ts"), "utf8");
assert.doesNotMatch(perm, /void\s+ensureBackgroundSurvival|await\s+ensureBackgroundSurvival/);

console.log("AIB_BOOTSTRAP_TRACE_SELFTEST_OK");
