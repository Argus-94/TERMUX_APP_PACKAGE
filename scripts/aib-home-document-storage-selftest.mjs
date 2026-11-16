#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-home-doc-store-"));
try {
  for (const rel of ["core/enhancements/persistence/types.ts", "core/enhancements/persistence/HomeDocumentStorage.ts"]) {
    const dest = path.join(temp, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typescript.transpile(fs.readFileSync(path.join(root, rel), "utf8"), { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }));
  }
  const { HomeDocumentStorage } = createRequire(import.meta.url)(path.join(temp, "core/enhancements/persistence/HomeDocumentStorage.js"));
  const storageRoot = path.join(temp, "shared", "AIBuilderTermux", ".ai-builder", "metadata", "uninstall-safe");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(outside, { recursive: true });
  const canonical = (candidate) => {
    let current = path.resolve(candidate);
    const suffix = [];
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      suffix.unshift(path.basename(current));
      current = parent;
    }
    return path.join(fs.realpathSync(current), ...suffix);
  };
  const env = {
    async resolvePath(candidate) { return canonical(candidate); },
    async exists(candidate) { return fs.existsSync(candidate); },
    async read(candidate) { return fs.readFileSync(candidate, "utf8"); },
    async write(candidate, contents) { fs.writeFileSync(candidate, contents, "utf8"); },
    async mkdir(candidate) { fs.mkdirSync(candidate, { recursive: true }); },
    async exec(command, options = {}) {
      const result = spawnSync("/bin/sh", ["-lc", command], { cwd: options.cwd, encoding: "utf8" });
      return { exitCode: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
    },
  };
  const store = new HomeDocumentStorage(env, storageRoot);
  await store.write("AIBuilder/private/profile.json", "{\"version\":1}");
  assert.equal(await store.read("AIBuilder/private/profile.json"), "{\"version\":1}");
  assert.equal(fs.existsSync(path.join(storageRoot, "AIBuilder/private/profile.json.tmp")), false);
  await assert.rejects(() => store.write("../outside/leak.json", "bad"), (error) => error.code === "PERSISTENCE_KEY_INVALID");
  fs.symlinkSync(outside, path.join(storageRoot, "escape"));
  await assert.rejects(() => store.write("escape/leak.json", "bad"), (error) => error.code === "PERSISTENCE_KEY_INVALID");
  await store.remove("AIBuilder/private/profile.json");
  assert.equal(await store.read("AIBuilder/private/profile.json"), null);
  console.log("AIB_HOME_DOCUMENT_STORAGE_SELFTEST_OK atomic_replace=verified traversal=blocked symlink_escape=blocked");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
