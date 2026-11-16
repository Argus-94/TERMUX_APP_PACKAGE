#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { typescript as ts } from "./test-helpers/load-typescript.mjs";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const menu = read("components/PackagesRightMenu.tsx");
const policySource = read("lib/private-package-install-policy.ts");
const policy = ts.transpileModule(policySource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const policyModule = { exports: {} };
vm.runInNewContext(policy, { exports: policyModule.exports, module: policyModule });
const { getPrivatePackageMutationAvailability } = policyModule.exports;
const offlinePackageMutationGateMessage = () => "Ordinary catalog install/update/removal is disabled.";
const panel = read("components/FullCandidatePackagesPanel.tsx");
const dialogs = read("components/DialogContext.tsx");
const layout = read("app/_layout.tsx");
// Qualification informs labels/styles, but must never disable ordinary install/reinstall/remove.
assert.match(menu, /disabled=\{!!busyId \|\| isChecking\}/);
assert.match(menu, /disabled=\{!!busyId\}/);
assert.match(menu, /disabled=\{!!busyId \|\| isChecking \|\| !termuxOk\}/);
assert.match(menu, /packageMutationAllowed \? \(isInstalled \? "Переуст\." : "Установить"\) : \(language === "en" \? "Unavailable" : "Недоступно"\)/);
assert.match(menu, /!packageMutationAllowed[\s\S]{0,200}"Недоступно"/);
assert.equal((menu.match(/offlinePackageMutationGateMessage\(language\)/g) || []).length, 4, "all four catalog mutation callbacks use the current offline gate");
assert.match(menu, /Ordinary catalog changes remain disabled/);
assert.match(menu, /function offlinePackageMutationGateMessage\(language:[\s\S]*?Ordinary catalog install\/update\/removal is disabled/);
assert.doesNotMatch(menu, /!packageMutationAllowed && \(\s*<View style=\{\{ marginTop: 8/);
assert.match(menu, /onPress=\{\(\) => void runInstall\(def\.id as AnyPkgId, kind\)\}/);
assert.match(policySource, /complete signed feed and tools for AI Builder's private Android runtime have not been qualified/i);

// Execute the actual extracted production callback arrows with the transpiled production policy.
// Each blocked action must produce one explanation and return before every installer/native spy.
const sourceFile = ts.createSourceFile("PackagesRightMenu.tsx", menu, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const actions = ["runInstall", "runRemove", "handleInstallCustom", "handleRemoveCustom"];
function findArrow(name) {
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === name && ts.isCallExpression(node.initializer) && ts.isArrowFunction(node.initializer.arguments[0])) result = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(result, `could not extract ${name}`);
  return result.getText(sourceFile);
}
for (const name of actions) {
  const callbackTs = findArrow(name);
  assert.match(callbackTs, /getPrivatePackageMutationAvailability\(\)\.allowed/);
  const callbackJs = ts.transpileModule(`globalThis.action = ${callbackTs};`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  let explanations = 0, installers = 0;
  const context = {
    getPrivatePackageMutationAvailability,
    offlinePackageMutationGateMessage,
    showDialog: (_title, message) => { explanations++; assert.match(message, /disabled/); },
    backendLabel: "Private runtime", language: "en", termuxOk: true,
    busyIdRef: { current: null },
    installCompilePackage: () => { installers++; }, installReversePackage: () => { installers++; },
    installCustomTool: () => { installers++; }, removeCompilePackage: () => { installers++; },
    removeReversePackage: () => { installers++; }, removeCustomToolPkg: () => { installers++; },
    setOne: () => { throw new Error("side effect before qualification guard"); },
    setBusyId: () => { throw new Error("side effect before qualification guard"); },
    persistBusyInstall: () => { throw new Error("side effect before qualification guard"); },
    abortRef: { current: false }, persistentLogger: { add: () => { throw new Error("side effect before qualification guard"); } },
  };
  vm.runInNewContext(callbackJs, context);
  const action = context.action;
  if (name === "runInstall" || name === "runRemove") await action("item", "compile");
  else await action({ id: "item", installKind: "custom", name: "Item" });
  assert.equal(explanations, 1, `${name}: one blocked explanation per tap`);
  assert.equal(installers, 0, `${name}: no installer/native action`);
}
// Candidate is distinct and test-only; the other agent's panel remains unmodified by this task.
assert.match(panel, /BATCH_WARNING[\s\S]*весь согласованный набор из 82 пакетов/);
assert.match(panel, /const runFullCohortAction = \(action: "install" \| "reinstall"\) => \{\s*const selected = CANDIDATE_PACKAGES\.map\(p => p\.name\);[\s\S]*?Alert\.alert\(labels\[action\], BATCH_WARNING,[\s\S]*?void run\(action, selected, attempt\)/);
assert.match(panel, /Install full cohort \(82\)/);
assert.match(panel, /Reinstall full cohort \(82\)/);
assert.doesNotMatch(panel, /rowAction\(["'](?:install|reinstall)["']/);
assert.match(panel, /disabled=\{!sessionEnabled \|\| !!busy \|\| !CANDIDATE_BOOTSTRAP_COMPATIBLE\}/);
assert.match(panel, /CANDIDATE_INSTALL_BLOCKER/);
assert.match(dialogs, /<AppDialog[\s\S]*visible=\{state\.visible\}/);
assert.match(layout, /<DialogProvider>/);
console.log("v495-menu-actions PASS: four extracted callbacks block dynamically with one explanation and zero installer calls; ordinary controls remain dispatchable; candidate session gate and duplicate-banner checks retained");
