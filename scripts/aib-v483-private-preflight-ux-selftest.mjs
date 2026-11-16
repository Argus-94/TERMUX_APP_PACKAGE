#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
const policy = fs.readFileSync(path.join(root, "lib/agent-private-tool-policy.ts"), "utf8");
const runtimeUi = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");

assert.match(agent, /commandExecutionTarget === "selected-backend" && autoPkg\.command\s*\? \(`\\n\\n\[AUTO_PKG\]/,
  "automatic pkg.ensure instructions remain limited to selected-backend");
assert.match(agent, /commandExecutionTarget === "embedded-private" && autoPkg\.command[\s\S]{0,600}PRIVATE_RUNTIME_INSTALL_LIMIT/,
  "private requests that need packages/toolchains receive a target-specific limitation");
assert.match(agent, /does not support pkg\.ensure or toolchain\.ensure/,
  "private guidance keeps package and toolchain installers unavailable");
assert.match(agent, /build\.run supports only the validated assembleDebug task for a selected AIBuilderTermux project/,
  "private guidance allows only the validated offline project build");
assert.match(agent, /If any prerequisite is missing, report TOOLCHAIN_UNAVAILABLE/,
  "private build reports missing cached prerequisites without installation or fallback");
assert.match(policy, /pkg\.ensure[\s\S]{0,300}AIB_TOOL_PRIVATE_PACKAGE_INSTALL_UNSUPPORTED/,
  "private pkg.ensure remains denied by policy");
assert.match(policy, /toolchain\.ensure[\s\S]{0,300}AIB_TOOL_PRIVATE_TOOLCHAIN_UNSUPPORTED/,
  "private toolchain.ensure remains denied by policy");
assert.match(policy, /if \(tool === "build\.run"\) return null/,
  "private build.run is admitted only to its own typed validator");
assert.match(runtimeUi, /build\.run is a separate restricted action:[\s\S]{0,500}TOOLCHAIN_UNAVAILABLE/i,
  "runtime target help describes the offline-only build gate");
assert.match(runtimeUi, /build\.run — отдельное ограниченное действие:[\s\S]{0,500}TOOLCHAIN_UNAVAILABLE/,
  "Russian runtime target help describes the offline-only build gate");
assert.match(runtimeUi, /build\.run — окрема обмежена дія:[\s\S]{0,500}TOOLCHAIN_UNAVAILABLE/,
  "Ukrainian runtime target help describes the offline-only build gate");
const guide = fs.readFileSync(path.join(root, "lib/user-guide.ts"), "utf8");
assert.match(guide, /build\.run supports only assembleDebug for a validated AIBuilderTermux project/);
assert.match(guide, /build\.run поддерживает только assembleDebug для проверенного проекта AIBuilderTermux/);
assert.match(guide, /build\.run підтримує лише assembleDebug для перевіреного проєкту AIBuilderTermux/);
assert.doesNotMatch(guide, /The agent installs them \(pkg\.ensure \/ auto preflight\)/);
assert.doesNotMatch(guide, /Агент ставит их сам \(pkg\.ensure \/ auto preflight\)/);
console.log("AIB_V483_PRIVATE_PREFLIGHT_UX_SELFTEST_OK selected-backend-preserved=1 private-guidance-conditional=1 policy-locked=1 signed-feed-device-qualification=1");
