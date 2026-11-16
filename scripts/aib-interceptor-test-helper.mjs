import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
require.extensions[".ts"] = (module, filename) => {
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Node10, esModuleInterop: true } }).outputText;
  module._compile(output, filename);
};
export function loadTs(path) { return require(resolve(projectRoot, path)); }
export function memoryAdapter(initial = null) {
  let value = initial;
  return { async read() { return value; }, async write(next) { value = next; }, get value() { return value; } };
}
export function request(id, url = "https://example.test/api/data", method = "GET", body) {
  return { id, startedAt: 1000, url, method, protocol: new URL(url).protocol, requestHeaders: { accept: "application/json" }, ...(body === undefined ? {} : { requestBody: body }) };
}
