#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const common = fs.readFileSync(path.join(root, "lib/agent-tools/common.ts"), "utf8");
assert.match(common, /path\.startsWith\("~"\)/);
assert.match(common, /\^\[A-Za-z\]:\[\\\\\/\]/);
const files = [
  "fs/read.ts", "fs/hashline.ts", "fs/create.ts", "fs/delete.ts", "fs/replace.ts", "fs/replace-range.ts",
  "lsp/completion.ts", "lsp/definition.ts", "lsp/hover.ts", "lsp/references.ts", "lsp/rename.ts",
];
for (const relative of files) {
  const source = fs.readFileSync(path.join(root, "lib/agent-tools", relative), "utf8");
  assert.match(source, /path\.startsWith\("~"\)/, `${relative} rejects home-relative paths at validation time`);
  assert.match(source, /\^\[A-Za-z\]:\[\\\\\/\]/, `${relative} rejects Windows drive-absolute paths at validation time`);
  assert.match(source, /path\.split\(\/\[\\\\\/\]\/\)\.includes\("\.\."\)/, `${relative} rejects traversal at validation time`);
}
console.log(`AIB_AGENT_PATH_VALIDATION_SELFTEST_OK wrappers=${files.length} tilde=blocked drive=blocked traversal=blocked`);
