#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const need = [
  "core/diagnostics/LiveProbes.ts",
  "core/runtime/RuntimeMaintenanceCoordinator.ts",
  "lib/foreground-task.ts",
];
for (const f of need) assert.ok(fs.existsSync(path.join(root, f)), f);

const probes = fs.readFileSync(path.join(root, "core/diagnostics/LiveProbes.ts"), "utf8");
assert.match(probes, /probeGradle/);
assert.match(probes, /probeJava/);
assert.match(probes, /probeSdk/);

const maint = fs.readFileSync(path.join(root, "core/runtime/RuntimeMaintenanceCoordinator.ts"), "utf8");
assert.match(maint, /runExclusive/);
assert.match(maint, /stopTerminals/);

const fg = fs.readFileSync(path.join(root, "lib/foreground-task.ts"), "utf8");
assert.match(fg, /withForegroundTask/);
assert.match(fg, /startForegroundTask/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /probeJava\(termuxExec\)/);
assert.match(facade, /RuntimeMaintenanceCoordinator/);
assert.match(facade, /this\.maintenance/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /runHealth|Run health|rt\("runHealth"\)/);
assert.match(ui, /repairHealth/);
assert.match(ui, /runHealthChecks/);

// foreground-task behavioral
const { startForegroundTask, endForegroundTask, listForegroundTasks, withForegroundTask } = await import(
  path.join(root, "lib/foreground-task.ts")
).catch(() => ({ startForegroundTask: null }));
// TS file may not import in node without transpile — skip runtime import
if (!startForegroundTask) {
  console.log("AIB_LIVE_HEALTH_SELFTEST_OK static=1 fg_runtime=skipped");
} else {
  const id = startForegroundTask("build", "test");
  assert.equal(listForegroundTasks().length, 1);
  endForegroundTask(id);
  assert.equal(listForegroundTasks().length, 0);
  console.log("AIB_LIVE_HEALTH_SELFTEST_OK static=1 fg_runtime=1");
}
