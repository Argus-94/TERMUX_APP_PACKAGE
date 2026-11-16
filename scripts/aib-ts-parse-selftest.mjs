#!/usr/bin/env node
/**
 * Optional: parse all app TS/TSX with TypeScript if present on NODE_PATH / local.
 * Skips cleanly when typescript is not installed (host acceptance still OK).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);

let ts;
for (const cand of [
  path.join(root, "node_modules/typescript/lib/typescript.js"),
  "/tmp/tsparse/package/lib/typescript.js",
]) {
  try {
    if (fs.existsSync(cand)) {
      ts = require(cand);
      break;
    }
  } catch {
    /* continue */
  }
}
if (!ts) {
  console.log("AIB_TS_PARSE_SELFTEST_SKIP no-typescript");
  process.exit(0);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    if (n === "node_modules" || n === ".git") continue;
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

const files = [
  ...walk(path.join(root, "lib")),
  ...walk(path.join(root, "app")),
  ...walk(path.join(root, "components")),
  ...walk(path.join(root, "core")),
];
const errors = [];
for (const f of files) {
  const code = fs.readFileSync(f, "utf8");
  const kind = f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(f, code, ts.ScriptTarget.Latest, true, kind);
  for (const d of sf.parseDiagnostics || []) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start || 0);
    errors.push(
      `${path.relative(root, f)}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
  }
}
if (errors.length) {
  console.error(errors.slice(0, 30).join("\n"));
  process.exit(1);
}
console.log("AIB_TS_PARSE_SELFTEST_OK files=" + files.length + " parse_errors=0");
