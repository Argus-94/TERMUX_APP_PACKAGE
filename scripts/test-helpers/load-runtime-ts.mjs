import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./load-typescript.mjs";

const cache = new Map();
function resolveSource(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = path.extname(base) ? [base] : [`${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  for (const candidate of candidates) if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  throw new Error(`SELFTEST_MODULE_NOT_FOUND:${specifier}`);
}

/** Load a repository TS module and its relative TS imports without touching project config or installing tooling. */
export function loadRuntimeTs(entry) {
  const file = path.resolve(entry);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const source = fs.readFileSync(file, "utf8");
  const js = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, jsx: typescript.JsxEmit.ReactNative } }).outputText;
  const nativeRequire = createRequire(file);
  const localRequire = (specifier) => specifier.startsWith(".") ? loadRuntimeTs(resolveSource(file, specifier)) : nativeRequire(specifier);
  const run = new Function("require", "module", "exports", js);
  run(localRequire, module, module.exports);
  return module.exports;
}
