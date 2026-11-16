import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runtime = readFileSync(new URL("../app/runtime.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../app/termux-settings.tsx", import.meta.url), "utf8");

// A successful probe with ready=false means the probe ran, not that the runtime is ready.
assert.match(runtime, /phase:\s*ready\.ready\s*\?\s*"ready"\s*:\s*"missing"/);
assert.match(runtime, /if \(currentPhase === "missing"\)[\s\S]*?stepId === "host-check" \? "done" : stepId === "ready" \? "active"/);
assert.match(runtime, /const status = ready\.ready \? "Termux: готов" : ready\.probeDetail/);
// Settings must describe the embedded app-private runtime rather than require another app.
assert.match(settings, /Embedded runtime architecture|Архитектура встроенной среды/);
assert.doesNotMatch(settings, /openPackage\(["']com\.termux|com\.termux\.app/i);
// The requested label is not an implemented navigation route in current UI; avoid a fake external-app deep link.
assert.doesNotMatch(runtime + settings, /Вернуться в Termux/);
console.log("AIB_V492_UI_RUNTIME_SELFTEST_OK readiness phases, embedded runtime messaging, no external Termux route");
