#!/usr/bin/env node
/**
 * Catches CBE/Metro failure:
 *   'shell...' +
 *   # bare comment
 *   'more...'
 *
 * Scans lib/, app/, components/, core/.
 * Also asserts buildFlutterAssembleCmd uses // not # for the known fixed site.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    if (n === "node_modules" || n === ".git") continue;
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

const files = [
  ...walk(path.join(root, "lib")),
  ...walk(path.join(root, "app")),
  ...walk(path.join(root, "components")),
  ...walk(path.join(root, "core")),
];

for (const file of files) {
  const rel = path.relative(root, file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trimStart();
    if (!stripped.startsWith("#") || stripped.startsWith("#!")) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j--;
    if (j < 0 || !lines[j].trimEnd().endsWith("+")) continue;
    let k = i + 1;
    while (k < lines.length && lines[k].trim() === "") k++;
    const next = k < lines.length ? lines[k].trimStart() : "";
    if (next.startsWith("'") || next.startsWith('"') || next.startsWith("`")) {
      errors.push(`${rel}:${i + 1}: bare # between string concat (Metro SyntaxError)`);
    }
  }
}

const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
if (/^\s*#\s*PROJ may be/m.test(agent)) {
  errors.push("termux-agent still has bare # PROJ may be");
}
if (!/\/\/\s*PROJ may be/.test(agent)) {
  errors.push("termux-agent missing // PROJ may be fix");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("AIB_TS_SHELL_COMMENT_SYNTAX_SELFTEST_OK files=" + files.length);
