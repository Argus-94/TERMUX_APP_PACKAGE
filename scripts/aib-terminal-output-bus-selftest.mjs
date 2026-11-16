#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const bus = fs.readFileSync("core/terminal/TerminalOutputBus.ts", "utf8");
const bridge = fs.readFileSync("lib/termux-bridge.ts", "utf8");
const consumer = fs.readFileSync("components/TermuxConsoleContext.tsx", "utf8");
assert.match(bus, /stream: event\.stream === "stderr" \? "stderr" : "stdout"/);
assert.doesNotMatch(bus, /streamKind:/, "bus mirrors the TermuxCommandOutputEvent schema");
assert.match(bridge, /interface TermuxCommandOutputEvent[\s\S]*?stream\?: "stdout" \| "stderr"/);
assert.match(consumer, /String\(event\.stream \|\| ""\)/);
console.log("AIB_TERMINAL_OUTPUT_BUS_SELFTEST_OK bus_field=stream console_consumer=matched");
