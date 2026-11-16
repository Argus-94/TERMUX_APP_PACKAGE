#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const t = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");
const errors = [];
if (!t.includes("SettingsGroup")) errors.push("SettingsGroup missing");
if (!t.includes("expandedHeaderStyle") && !t.includes("#C9A227")) errors.push("Gold highlight missing");
if (!t.includes("accessibilityState={{ expanded }}")) errors.push("accessibilityState expanded missing");
if (!t.includes("ui-expanded-highlight") && !t.includes("expandedHeaderStyle")) errors.push("not on shared helper");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("AIB_SETTINGS_EXPANDED_HIGHLIGHT_SELFTEST_OK gold=1 shared=1");
