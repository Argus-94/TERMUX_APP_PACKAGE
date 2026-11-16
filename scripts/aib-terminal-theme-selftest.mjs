#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { TerminalTheme } = loadRuntimeTs(path.join(root, "core/enhancements/terminal/TerminalTheme.ts"));
const { TerminalFont, TERMINAL_FONT_FAMILIES } = loadRuntimeTs(path.join(root, "core/enhancements/terminal/TerminalFont.ts"));
const values = new Map();
const store = { async get(key) { return values.get(key) ?? null; }, async set(key, value) { values.set(key, value); } };
const theme = new TerminalTheme(store);
assert.equal(theme.listThemes().length, 15);
for (const entry of theme.listThemes()) assert.equal(entry.ansi.length, 16, `ANSI palette: ${entry.id}`);
await theme.setActiveTheme("nord");
assert.equal(values.get("aib.terminal.theme.v1"), "nord");
assert.equal((await new TerminalTheme(store).getActiveTheme()).id, "nord");
await assert.rejects(() => theme.setActiveTheme("not-allowlisted"), (error) => error?.code === "INVALID_THEME");
const failingTheme = new TerminalTheme({ async get() { return null; }, async set() { throw new Error("disk full"); } });
await assert.rejects(() => failingTheme.setActiveTheme("nord"), (error) => error?.code === "STORE_FAILED");
assert.equal((await failingTheme.getActiveTheme()).id, "dark", "a failed preference write must not mutate visible theme state");

const font = new TerminalFont(store);
assert.ok(TERMINAL_FONT_FAMILIES.includes("monospace"));
const saved = await font.setPreferences({ family: "Roboto Mono", size: 22, lineHeight: 1.5, letterSpacing: 0.2 });
assert.equal(saved.size, 22);
assert.equal((await new TerminalFont(store).getPreferences()).family, "Roboto Mono");
let releaseFontRead; let fontReads = 0;
const fontReadGate = new Promise((resolve) => { releaseFontRead = resolve; });
const concurrentFont = new TerminalFont({ async get() { fontReads++; await fontReadGate; return JSON.stringify({ family: "Courier New", size: 18, lineHeight: 1.4, letterSpacing: 0 }); }, async set() {} });
const fontRead1 = concurrentFont.getPreferences(); const fontRead2 = concurrentFont.getPreferences();
await Promise.resolve(); releaseFontRead();
assert.deepEqual(await Promise.all([fontRead1, fontRead2]), [{ family: "Courier New", size: 18, lineHeight: 1.4, letterSpacing: 0 }, { family: "Courier New", size: 18, lineHeight: 1.4, letterSpacing: 0 }]);
assert.equal(fontReads, 1, "concurrent initial reads must not return competing defaults");
await assert.rejects(() => font.setPreferences({ size: 23 }), (error) => error?.code === "INVALID_FONT_SIZE");
console.log("AIB_TERMINAL_THEME_SELFTEST_OK");
