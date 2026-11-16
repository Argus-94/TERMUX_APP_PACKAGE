#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { parseAnsiText } = loadRuntimeTs(path.join(root, "core/enhancements/terminal/AnsiParser.ts"));
const palette = Array.from({ length: 16 }, (_, index) => `#${index.toString(16).padStart(6, "0")}`);
const segments = parseAnsiText("plain \u001b[31mred\u001b[1;4m bold\u001b[0m normal\u001b[38;2;1;2;255m rgb\u001b[48;5;196m bg\u001b[2K tail\u001b]0;title\u0007\r\nnext\u0007", palette, "#ffffff", "#000000");
assert.equal(segments.map((item) => item.text).join(""), "plain red bold normal rgb bg tail\nnext");
assert.equal(segments.find((item) => item.text === "red")?.style?.color, palette[1]);
assert.equal(segments.find((item) => item.text === " bold")?.style?.fontWeight, "700");
assert.equal(segments.find((item) => item.text === " bold")?.style?.textDecorationLine, "underline");
assert.equal(segments.find((item) => item.text === " rgb")?.style?.color, "#0102ff");
assert.equal(segments.find((item) => item.text.startsWith(" bg"))?.style?.backgroundColor, "#ff0000");
assert.ok(segments.every((item) => !item.text.includes("\u001b")), "escape sequences are never rendered as text");
console.log("AIB_TERMINAL_ANSI_SELFTEST_OK assertions=7");
