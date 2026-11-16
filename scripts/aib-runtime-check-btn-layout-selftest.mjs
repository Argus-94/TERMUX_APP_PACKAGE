#!/usr/bin/env node
import fs from "node:fs";
const src = fs.readFileSync("app/runtime.tsx", "utf8");
const fail = (m) => { console.error("AIB_RUNTIME_CHECK_BTN_LAYOUT_FAIL", m); process.exit(1); };
if (!src.includes("maxHeight: 52")) fail("missing_maxHeight");
if (!src.includes("height: 48")) fail("missing_fixed_height");
if (!src.includes("flexGrow: runtimeProjection.settingsPath ? 1 : 0")) fail("missing_flexGrow_gate");
const idx = src.indexOf("  action: {\n    // flex is set by callers");
if (idx < 0) fail("action_style_comment_missing");
const slice = src.slice(idx, idx + 280);
const beforeInRow = slice.split("actionInRow")[0];
if (/^\s*flex:\s*1/m.test(beforeInRow)) fail("action_still_has_default_flex_1");
console.log("AIB_RUNTIME_CHECK_BTN_LAYOUT_SELFTEST_OK");
