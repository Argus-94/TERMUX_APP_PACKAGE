import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!context.parentURL || !(specifier.startsWith(".") || specifier.startsWith("/"))) throw error;
    let base;
    try {
      base = specifier.startsWith("/")
        ? specifier
        : path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    } catch {
      throw error;
    }
    const candidates = path.extname(base)
      ? [base]
      : [`${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
    const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!found) throw error;
    return { url: pathToFileURL(found).href, shortCircuit: true };
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:")) return nextLoad(url, context);
  const file = fileURLToPath(url);
  if (!/\.tsx?$/.test(file)) return nextLoad(url, context);
  const source = fs.readFileSync(file, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactNative,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  return { format: "module", source: transpiled, shortCircuit: true };
}
