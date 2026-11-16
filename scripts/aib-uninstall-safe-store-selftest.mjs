#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";
const root = process.cwd(), out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-uninstall-store-"));
try {
  for (const rel of ["core/enhancements/persistence/types.ts", "core/enhancements/persistence/UninstallSafeStore.ts"]) {
    const dest = path.join(out, rel.replace(/\.ts$/, ".js")); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typescript.transpile(fs.readFileSync(path.join(root, rel), "utf8"), { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }));
  }
  const require = createRequire(import.meta.url), { UninstallSafeStore } = require(path.join(out, "core/enhancements/persistence/UninstallSafeStore.js"));
  const values = new Map(); const links = [];
  const store = new UninstallSafeStore({ read: async (k) => values.get(k) ?? null, write: async (k,v) => values.set(k,v), remove: async (k) => values.delete(k), symlink: async (target,link) => links.push({target,link}) });
  await store.write("public/projects-index.json", "[]", "public"); await store.write("metadata.json", "private");
  await store.write("api-key", "must-not-store").then(() => assert.fail("credential accepted"), (e) => assert.equal(e.code, "PERSISTENCE_KEY_INVALID"));
  await store.write("api_key", "must-not-store").then(() => assert.fail("underscored credential accepted"), (e) => assert.equal(e.code, "PERSISTENCE_KEY_INVALID"));
  assert.deepEqual(await store.exportPublic(["public/projects-index.json", "metadata.json", "public/api-token"]), { "public/projects-index.json": "[]" });
  assert.equal(store.classify("bridge-token"), "never");
  await store.linkIntoSandbox("metadata.json", "/data/user/0/app/files", "/data/user/0/app/files/profile.json");
  assert.equal(links.length, 1);
  await assert.rejects(() => store.linkIntoSandbox("metadata.json", "/data/user/0/app/files", "/storage/shared/link"), (e) => e.code === "PERSISTENCE_LINK_UNSAFE");
  console.log("AIB_UNINSTALL_SAFE_STORE_SELFTEST_OK public_allowlist=verified secrets=refused sandbox_link=guarded");
} finally { fs.rmSync(out, { recursive: true, force: true }); }
