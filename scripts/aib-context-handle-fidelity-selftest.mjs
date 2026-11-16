#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const file = path.join(root, "lib/context-engine.ts");
const require = createRequire(import.meta.url);
const mod = new Module(file);
mod.filename = file;
mod.paths = Module._nodeModulePaths(path.dirname(file));
mod.require = (request) => request === "@react-native-async-storage/async-storage" ? { getItem: async () => null, setItem: async () => {} } : require(request);
const js = typescript.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: file,
}).outputText;
mod._compile(js, file);
const { maybeCompressToHandle, expandHandle } = mod.exports;
const text = "x".repeat(120_001);
const stub = maybeCompressToHandle("file", text);
assert.match(stub, /truncated=true/);
assert.match(stub, /storedChars=120000/);
assert.match(stub, /omitted content is unavailable/);
assert.doesNotMatch(stub, /Use ctx\.expand .*for full content/);
const id = stub.match(/\[CTX_HANDLE id=([^ ]+)/)?.[1];
const expanded = expandHandle(id);
assert.equal(expanded.originalChars, text.length);
assert.equal(expanded.content.length, 120_000);
assert.equal(expanded.truncated, true);
console.log("AIB_CONTEXT_HANDLE_FIDELITY_SELFTEST_OK oversized=explicitly_truncated reversible_claim=none");
