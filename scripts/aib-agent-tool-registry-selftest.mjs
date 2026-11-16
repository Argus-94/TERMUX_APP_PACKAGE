#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const toolRoot = path.join(root, "lib/agent-tools");
const typesSource = fs.readFileSync(path.join(toolRoot, "types.ts"), "utf8");
const dispatcher = fs.readFileSync(path.join(toolRoot, "index.ts"), "utf8");
const checkpoint = fs.readFileSync(path.join(toolRoot, "mutation-checkpoint.ts"), "utf8");
const privacy = fs.readFileSync(path.join(root, "lib/log-redaction.ts"), "utf8");

const namesBlock = typesSource.match(/AGENT_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/);
assert.ok(namesBlock, "AGENT_TOOL_NAMES registry is missing");
const names = [...namesBlock[1].matchAll(/"([A-Za-z0-9_.]+)"/g)].map((match) => match[1]);
const definitionNames = [...dispatcher.matchAll(/^\s*"([A-Za-z0-9_.]+)"\s*:\s*\{\s*validate:/gm)].map((match) => match[1]);
const importMap = new Map([...dispatcher.matchAll(/^import \* as (\w+) from "(\.\/[^\"]+)";/gm)].map((match) => [match[1], `${match[2]}.ts`]));
const definitions = [...dispatcher.matchAll(/^\s*"([A-Za-z0-9_.]+)"\s*:\s*\{\s*validate:\s*(\w+)\.validate,\s*execute:\s*(?:\2\.execute|async\s*\([^)]*\)\s*=>\s*\2\.execute\(\s*\w+\s*\))\s*\}/gm)];
const mappedNames = definitions.map((match) => match[1]);
const mappedModules = new Set(definitions.map((match) => importMap.get(match[2])).filter(Boolean));

assert.equal(new Set(names).size, names.length, "duplicate agent tool name");
assert.equal(new Set(definitionNames).size, definitionNames.length, "duplicate dispatcher definition");
assert.deepEqual([...names].sort(), [...definitionNames].sort(), "tool names and dispatcher definitions must match exactly");
assert.deepEqual([...names].sort(), [...mappedNames].sort(), "every registered tool must map to one imported validator/executor pair");
assert.equal(mappedModules.size, names.length, "every registered tool must use a distinct source module");
for (const relative of mappedModules) {
  assert.ok(relative, "tool module import missing");
  assert.ok(fs.existsSync(path.join(toolRoot, relative.slice(2))), `registered module missing: ${relative}`);
}

function listTypes(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTypes(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path.relative(toolRoot, full).split(path.sep).join("/")] : [];
  });
}
const helpers = new Set(["common.ts", "index.ts", "mutation-checkpoint.ts", "github-mutations.ts", "posix-path.ts", "types.ts", "fs/path-guard.ts", "interceptor/common.ts", "pkg-bootstrap.ts", "hardware-probe.ts"]);
const sourceModules = new Set(listTypes(toolRoot).filter((file) => !helpers.has(file)));
const registeredFiles = new Set([...mappedModules].map((file) => file.slice(2)));
assert.deepEqual([...sourceModules].sort(), [...registeredFiles].sort(), "agent-tool source files must not be orphaned or unregistered");

const mutationBlock = checkpoint.match(/MUTATING_TOOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
assert.ok(mutationBlock, "mutation checkpoint registry is missing");
const mutating = [...mutationBlock[1].matchAll(/"([A-Za-z0-9_.]+)"/g)].map((match) => match[1]);
assert.deepEqual([...mutating].sort(), ["ast.edit", "fs.create", "fs.delete", "fs.replace", "fs.replaceRange", "workspace.write"].sort());
assert.ok(mutating.every((name) => names.includes(name)), "mutation checkpoint contains an unregistered tool");
assert.match(dispatcher, /executeAfterMutationCheckpoint\(/, "dispatcher must enforce durable mutation checkpoints");
assert.match(dispatcher, /ALLOW_DANGEROUS_NOT_ALLOWED/);
assert.match(dispatcher, /GITHUB_TOKEN_MUST_REMAIN_IN_SECURE_VAULT/);
assert.match(privacy, /normalizedTag === "agenttool"/, "persistent AgentTool payloads must be projected to metadata");

const groups = Object.fromEntries([...new Set(names.map((name) => name.split(".")[0]))].sort().map((group) => [group, names.filter((name) => name.startsWith(`${group}.`)).length]));
console.log(`AIB_AGENT_TOOL_REGISTRY_SELFTEST_OK names=${names.length} definitions=${definitionNames.length} modules=${mappedModules.size} mutations=${mutating.length} groups=${JSON.stringify(groups)}`);
