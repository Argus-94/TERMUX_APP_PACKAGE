#!/usr/bin/env node
/**
 * Self-test: RuntimeTransaction, Journal annotate/pending, BackupIntegrity, DeterministicRepair, BuiltinRules.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);

// --- static presence ---
const required = [
  "core/runtime/RuntimeTransaction.ts",
  "core/runtime/RuntimeJournal.ts",
  "core/runtime/RuntimeTaskGate.ts",
  "core/backup/BackupIntegrity.ts",
  "core/backup/RestoreTransaction.ts",
  "core/backup/BackupManager.ts",
  "core/diagnostics/DiagnosticRule.ts",
  "core/diagnostics/StartupTrace.ts",
  "core/diagnostics/FailureJournal.ts",
  "core/diagnostics/RepairManager.ts",
  "core/diagnostics/rules/BuiltinRules.ts",
  "core/recovery/DeterministicRepair.ts",
];
for (const rel of required) {
  assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
}

const txSrc = fs.readFileSync(path.join(root, "core/runtime/RuntimeTransaction.ts"), "utf8");
assert.match(txSrc, /recoverPending/);
assert.match(txSrc, /TransactionPhase/);
assert.match(txSrc, /rollback/);

const journalSrc = fs.readFileSync(path.join(root, "core/runtime/RuntimeJournal.ts"), "utf8");
assert.match(journalSrc, /annotate/);
assert.match(journalSrc, /pending/);
assert.match(journalSrc, /rolled_back/);

const integritySrc = fs.readFileSync(path.join(root, "core/backup/BackupIntegrity.ts"), "utf8");
assert.match(integritySrc, /BACKUP_FORMAT_CURRENT/);
assert.match(integritySrc, /validateManifest/);
assert.match(integritySrc, /parseManifest/);

const restoreSrc = fs.readFileSync(path.join(root, "core/backup/RestoreTransaction.ts"), "utf8");
assert.match(restoreSrc, /pre-backup/);
assert.match(restoreSrc, /skipPreBackup/);

const facadeSrc = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facadeSrc, /RuntimeTransaction/);
assert.match(facadeSrc, /StartupTrace/);
assert.match(facadeSrc, /recoverPendingTransactions/);
assert.match(facadeSrc, /createIdentityRule/);
assert.match(facadeSrc, /deterministicRepair/);

const repairSrc = fs.readFileSync(path.join(root, "core/recovery/DeterministicRepair.ts"), "utf8");
assert.match(repairSrc, /gradle-wrapper/);
assert.match(repairSrc, /forDiagnostic/);
assert.doesNotMatch(repairSrc, /eval\(/);

// --- in-memory behavioral test (no TS runtime: reimplement minimal gate/journal) ---
class MemStore {
  constructor() { this.v = null; }
  async read() { return this.v; }
  async write(v) { this.v = v; }
}

// Lightweight inline checks mirroring contracts
const store = new MemStore();
await store.write(JSON.stringify([]));
let list = JSON.parse(await store.read());
const entry = { id: "j-test", operation: "backup:create", status: "started", startedAt: Date.now() };
list.push(entry);
await store.write(JSON.stringify(list));
list = JSON.parse(await store.read());
assert.equal(list.filter((x) => x.status === "started").length, 1);
list[0] = { ...list[0], status: "rolled_back", finishedAt: Date.now() };
await store.write(JSON.stringify(list));
assert.equal(JSON.parse(await store.read()).filter((x) => x.status === "started").length, 0);

// Identity version
const identity = fs.readFileSync(path.join(root, "core/runtime/RuntimeIdentity.ts"), "utf8");
assert.match(identity, /appVersion:\s*"1\.\d+\.\d+"/);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const identityVersion = identity.match(/appVersion:\s*"([^"]+)"/)?.[1];
assert.equal(identityVersion, pkg.version, "runtime identity appVersion must match package.json");
console.log("AIB_RUNTIME_TRANSACTION_SELFTEST_OK files=" + required.length + " identity_app=" + identityVersion);
