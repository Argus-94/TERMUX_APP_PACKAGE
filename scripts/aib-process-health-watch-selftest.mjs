#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const reg = fs.readFileSync(path.join(root, "core/process/ProcessRegistry.ts"), "utf8");
assert.match(reg, /patchMetadata/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /health: "failed"/);
assert.match(facade, /health: "ok"/);

const sup = fs.readFileSync(path.join(root, "core/runtime/RuntimeSupervisor.ts"), "utf8");
assert.match(sup, /metadata\?\.health !== "failed"/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /loadLastAdbSerial/);

console.log("aib-process-health-watch-selftest: OK");
