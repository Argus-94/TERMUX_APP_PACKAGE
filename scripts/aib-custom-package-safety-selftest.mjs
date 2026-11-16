#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const policySource = fs.readFileSync(path.join(root, "lib/custom-packages.ts"), "utf8");
const uiSource = fs.readFileSync(path.join(root, "components/PackagesRightMenu.tsx"), "utf8");
const start = policySource.indexOf("const PACKAGE_PATTERNS");
const end = policySource.indexOf("export async function loadCustomTools", start);
assert.ok(start >= 0 && end > start, "pure custom package policy remains locatable");
const fragment = policySource.slice(start, end);
const compiled = typescript.transpileModule(
  `${fragment}\nmodule.exports = { buildCommandsFromKind, normalizeStoredTool };`,
  { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } },
).outputText;
const policyModule = { exports: {} };
new Function("module", "exports", compiled)(policyModule, policyModule.exports);
const { buildCommandsFromKind, normalizeStoredTool } = policyModule.exports;

for (const attack of [
  "git; touch /tmp/aib-custom-injection",
  "git $(touch /tmp/aib-custom-injection)",
  "git | sh",
  "../outside",
  "git\nrm -rf /",
]) {
  assert.throws(() => buildCommandsFromKind("pkg", attack), /CUSTOM_PACKAGE_NAME_INVALID/);
}

const pkg = buildCommandsFromKind("pkg", "git zip");
assert.match(pkg.installCmd, /apt-get install -y 'git' 'zip'/);
assert.match(pkg.checkCmd, /command -v 'git'/);
assert.match(pkg.checkCmd, /command -v 'zip'/, "every requested system package is verified");
assert.match(pkg.installCmd, /command -v 'git'[\s\S]*&& \(command -v 'zip'/, "partial multi-package install cannot report success from the first package alone");
assert.match(pkg.removeCmd, /apt-get remove -y 'git' 'zip'/);
const pip = buildCommandsFromKind("pip", "requests>=2.31");
assert.match(pip.installCmd, /pip install 'requests>=2\.31'/);
assert.match(pip.checkCmd, /pip show 'requests'/, "Python distributions are verified by distribution metadata, not guessed module names");
const pipAliases = buildCommandsFromKind("pip", "Pillow beautifulsoup4");
assert.match(pipAliases.checkCmd, /pip show 'Pillow'[\s\S]*&& python3 -m pip show 'beautifulsoup4'/);
const npm = buildCommandsFromKind("npm", "@scope/sample-tool");
assert.match(npm.installCmd, /npm install -g '@scope\/sample-tool'/);
assert.match(npm.checkCmd, /npm ls -g --depth=0 '@scope\/sample-tool'/, "installed distribution need not expose a same-named CLI executable");
const npmMulti = buildCommandsFromKind("npm", "@scope/library-one library-two@2");
assert.match(npmMulti.checkCmd, /npm ls -g --depth=0 '@scope\/library-one'[\s\S]*&& npm ls -g --depth=0 'library-two'/);
for (const command of [pkg.installCmd, pkg.checkCmd, pkg.removeCmd, pip.installCmd, pip.checkCmd, pip.removeCmd, npm.installCmd, npm.checkCmd, npm.removeCmd]) {
  const syntax = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
  assert.equal(syntax.status, 0, `generated shell must parse: ${syntax.stderr}`);
}

const saved = {
  id: "custom-safe-tool", section: "compile", name: "Safe tool", nameEn: "Safe tool", installKind: "pkg",
  packageNames: "git", installCmd: "touch /tmp/should-not-run", checkCmd: "false", removeCmd: "rm -rf /",
  estimateSec: 60, order: 1, createdAt: 1, updatedAt: 1,
};
const normalized = normalizeStoredTool(saved);
assert.ok(normalized);
assert.match(normalized.installCmd, /apt-get install -y 'git'/, "persisted generated commands are rebuilt from validated package names");
assert.doesNotMatch(normalized.installCmd, /should-not-run/);
assert.equal(normalizeStoredTool({ ...saved, packageNames: "git; touch /tmp/inject" }), null);
assert.equal(normalizeStoredTool({ ...saved, id: "not-a-custom-id" }), null);
const raw = normalizeStoredTool({
  ...saved, id: "custom-raw-shell", installKind: "custom", packageNames: undefined,
  installCmd: "echo user-script", checkCmd: "test -f marker", removeCmd: "rm marker",
});
assert.equal(raw.installCmd, "echo user-script", "raw shell remains user-authored, but is never run without UI review");
assert.match(policySource, /allowRawCustom = false/);
assert.match(policySource, /CUSTOM_COMMAND_REQUIRES_USER_REVIEW/);
assert.match(uiSource, /const reviewRawCommand = useCallback/);
assert.match(uiSource, /showDialog\(title, body/);
assert.match(uiSource, /Custom check runs only after you review it\./);
assert.match(uiSource, /reviewRawCommand\(def, "install"/);
assert.match(uiSource, /reviewRawCommand\(def, "check"/);
assert.match(uiSource, /reviewRawCommand\(def, "remove"/);

console.log("AIB_CUSTOM_PACKAGE_SAFETY_SELFTEST_OK injection_denied=PASS quoted_args=PASS saved_commands_rebuilt=PASS raw_shell_review_gated=PASS shell_syntax=PASS");
