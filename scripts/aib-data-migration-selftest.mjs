#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-migration-"));
try {
  for (const rel of [
    "core/enhancements/persistence/types.ts",
    "core/enhancements/persistence/UninstallSafeStore.ts",
    "core/enhancements/persistence/DataMigration.ts",
  ]) {
    const dest = path.join(out, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typescript.transpile(fs.readFileSync(path.join(root, rel), "utf8"), {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    }));
  }

  const require = createRequire(import.meta.url);
  const { UninstallSafeStore } = require(path.join(out, "core/enhancements/persistence/UninstallSafeStore.js"));
  const { DataMigration } = require(path.join(out, "core/enhancements/persistence/DataMigration.js"));
  const files = new Map([["AIBuilder/private/profile.json", "old"]]);
  const storage = {
    read: async (key) => files.get(key) ?? null,
    write: async (key, value) => { files.set(key, value); },
    remove: async (key) => { files.delete(key); },
  };
  const store = new UninstallSafeStore(storage);
  const migration = new DataMigration(store, () => 1234);
  const items = [
    { key: "profile.json", contents: "new", visibility: "private" },
    { key: "public/projects-index.json", contents: "[]", visibility: "public" },
  ];

  const receipt = await migration.migrate("p2-profile", items);
  assert.equal(receipt.committedAt, 1234);
  assert.equal(await store.read("profile.json"), "new");
  assert.equal(await migration.migrate("p2-profile", items), receipt, "same-process retry is idempotent");
  const afterRestart = new DataMigration(store);
  const durableReceipt = await afterRestart.migrate("p2-profile", items);
  assert.equal(durableReceipt.id, receipt.id, "durable receipt survives a new manager instance");
  await afterRestart.rollback(durableReceipt);
  assert.equal(await store.read("profile.json"), "old");
  assert.equal(await store.read("public/projects-index.json", "public"), null);
  assert.equal(await store.read("migrations/p2-profile"), null);
  assert.equal(await store.read("migrations/p2-profile.pending"), null);

  const parallelManager = new DataMigration(store);
  const [parallelA, parallelB] = await Promise.all([
    parallelManager.migrate("parallel-profile", items),
    parallelManager.migrate("parallel-profile", items),
  ]);
  assert.equal(parallelA, parallelB, "same-id concurrent calls serialize to a single receipt");
  await parallelManager.rollback(parallelA);

  for (const [id, invalid] of [
    ["bad-secret-key", [{ key: "api_key", contents: "secret", visibility: "private" }]],
    ["secret-content-assignment", [{ key: "profile.json", contents: '{"provider":{"apiKey":"synthetic-test-value"}}', visibility: "private" }]],
    ["secret-content-bearer", [{ key: "profile.json", contents: "Authorization: Bearer synthetic-token-value-1234567890", visibility: "private" }]],
    ["secret-content-private-key", [{ key: "profile.json", contents: "-----BEGIN " + "PRIVATE KEY-----\nTEST-ONLY INVALID FIXTURE\n-----END " + "PRIVATE KEY-----", visibility: "private" }]],
    ["bad-visibility", [{ key: "safe.json", contents: "x", visibility: "never" }]],
    ["reserved-journal-key", [{ key: "migrations/other", contents: "x", visibility: "private" }]],
    ["duplicate-destination", [
      { key: "same.json", contents: "one", visibility: "private" },
      { key: "same.json", contents: "two", visibility: "private" },
    ]],
  ]) {
    await assert.rejects(() => afterRestart.migrate(id, invalid), (error) => error.code === "MIGRATION_RECEIPT_INVALID");
  }
  assert.equal(await store.read("safe.json"), null);
  assert.equal(await store.read("profile.json"), "old", "secret-content rejection happens before any durable mutation");

  const oldSecretContent = `apiKey=${["SYNTHETIC", "MIGRATION", "VALUE"].join("-")}`;
  const protectedFiles = new Map([["AIBuilder/private/profile.json", oldSecretContent]]);
  let protectedWrites = 0;
  const protectedStore = new UninstallSafeStore({
    read: async (key) => protectedFiles.get(key) ?? null,
    write: async (key, value) => { protectedWrites += 1; protectedFiles.set(key, value); },
    remove: async (key) => { protectedFiles.delete(key); },
  });
  await assert.rejects(
    () => new DataMigration(protectedStore).migrate("preexisting-value-check", [{ key: "profile.json", contents: "new-safe-value", visibility: "private" }]),
    (error) => error.code === "MIGRATION_RECEIPT_INVALID",
  );
  assert.equal(protectedWrites, 0, "secret-like prior contents are not copied into a new journal");
  assert.equal(protectedFiles.get("AIBuilder/private/profile.json"), oldSecretContent, "existing source data is preserved on rejection");

  let unavailableWrites = 0;
  const unavailable = new UninstallSafeStore({
    read: async () => { throw new Error("SAF unavailable"); },
    write: async () => { unavailableWrites += 1; },
    remove: async () => {},
  });
  await assert.rejects(() => new DataMigration(unavailable).migrate("missing-saf", items), (error) => error.code === "MIGRATION_FAILED");
  assert.equal(unavailableWrites, 0, "missing SAF storage fails before any write");

  const crashFiles = new Map([["AIBuilder/private/profile.json", "old"]]);
  let failSecondWrite = true;
  let failFirstRollback = true;
  const crashStorage = {
    read: async (key) => crashFiles.get(key) ?? null,
    write: async (key, value) => {
      if (key === "AIBuilder/public/projects-index.json" && failSecondWrite) throw new Error("simulated provider crash");
      if (key === "AIBuilder/private/profile.json" && value === "old" && failFirstRollback) throw new Error("simulated rollback outage");
      crashFiles.set(key, value);
    },
    remove: async (key) => { crashFiles.delete(key); },
  };
  const crashStore = new UninstallSafeStore(crashStorage);
  await assert.rejects(() => new DataMigration(crashStore).migrate("crash-mid-write", items), (error) => error.code === "MIGRATION_FAILED");
  assert.equal(crashFiles.get("AIBuilder/private/profile.json"), "new", "fault injection leaves a partial write only while provider blocks rollback");
  assert.ok(crashFiles.has("AIBuilder/private/migrations/crash-mid-write.pending"), "recovery journal survives incomplete rollback");

  failSecondWrite = false;
  failFirstRollback = false;
  const recovered = await new DataMigration(crashStore).migrate("crash-mid-write", items);
  assert.equal(recovered.id, "crash-mid-write");
  assert.equal(crashFiles.get("AIBuilder/private/profile.json"), "new", "retry first restores original then reapplies complete migration");
  assert.equal(crashFiles.get("AIBuilder/public/projects-index.json"), "[]");
  assert.equal(crashFiles.has("AIBuilder/private/migrations/crash-mid-write.pending"), false);

  console.log("AIB_DATA_MIGRATION_SELFTEST_OK first-run=idempotent restart-rollback=verified missing-saf=fail-closed crash-journal=recovered reserved-keys=blocked");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
