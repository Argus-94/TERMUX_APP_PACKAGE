import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typescript } from "./load-typescript.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cache = new Map();
const importMocks = new Map();

function absolutePath(file) {
  return path.isAbsolute(file) ? path.resolve(file) : path.resolve(projectRoot, file);
}

function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function setTsModuleMocks(file, mocks) {
  importMocks.set(absolutePath(file), mocks);
}

export function loadTs(file) {
  const filename = absolutePath(file);
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  cache.set(filename, mod);
  const mocks = importMocks.get(filename) ?? {};
  mod.require = (request) => {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    const resolved = request.startsWith(".") ? resolveTs(filename, request) : null;
    return resolved ? loadTs(resolved) : createRequire(filename)(request);
  };
  const output = typescript.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  mod._compile(output, filename);
  return mod.exports;
}
