#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /clearSupervisorQuarantine/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /clearSupervisorQuarantine/);
assert.match(ui, /Clear quarantine|Сброс quarantine/);

const agent = fs.readFileSync(path.join(root, "lib/script-runner-agent.ts"), "utf8");
assert.match(agent, /markAgentHealth/);
assert.match(agent, /health: "ok"/);
assert.match(agent, /"failed", "exhausted"/);

console.log("aib-quarantine-agent-health-selftest: OK");
