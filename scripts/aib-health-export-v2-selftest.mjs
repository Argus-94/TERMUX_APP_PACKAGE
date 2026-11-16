#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /version: 2/);
assert.match(facade, /supervisor: this\.supervisor\.snapshot\(\)/);
assert.match(facade, /openFailures/);
assert.match(facade, /bootstrap: await this\.bootstrapPipeline/);

const agent = fs.readFileSync(path.join(root, "lib/script-runner-agent.ts"), "utf8");
assert.match(agent, /script-agent-/);
assert.match(agent, /processRegistry\.unregister\(watchId\)/);

const layout = fs.readFileSync(path.join(root, "app/_layout.tsx"), "utf8");
assert.doesNotMatch(layout, /ensureBackgroundSurvival/);

console.log("aib-health-export-v2-selftest: OK");
