#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Module = require("node:module");
const appConfig = fs.readFileSync(path.join(root, "app.config.ts"), "utf8");
const orderedPlugins = [
  ["withTermuxBridge", "TermuxBridgePackage"],
  ["withGithubTool", "GithubToolPackage"],
  ["withAibDeviceWatchdog", "AibDeviceWatchdogPackage"],
  ["withAibAccessibility", "AibAccessibilityPackage"],
];
let previousPosition = -1;
for (const [pluginName] of orderedPlugins) {
  const position = appConfig.indexOf(`    ${pluginName},`);
  assert.ok(position > previousPosition, `${pluginName} must appear in app.config.ts plugin order`);
  previousPosition = position;
}
assert.ok(appConfig.indexOf("    withAibAccessibility,") < appConfig.indexOf("    withAibNativeAccel,"),
  "the test plugin sequence must reflect the app.config.ts order");

const callbacksByPlugin = new Map();
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "@expo/config-plugins") {
    return {
      withDangerousMod(config) { return config; },
      withAndroidManifest(config) { return config; },
      withMainApplication(config, callback) {
        const callbacks = callbacksByPlugin.get(parent?.filename) || [];
        callbacks.push(callback);
        callbacksByPlugin.set(parent?.filename, callbacks);
        return config;
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

let pluginCallbacks;
try {
  pluginCallbacks = orderedPlugins.map(([pluginName]) => {
    const pluginPath = path.join(root, "plugins", `${pluginName}.js`);
    const before = callbacksByPlugin.get(pluginPath)?.length || 0;
    const plugin = require(pluginPath);
    plugin({});
    const callbacks = callbacksByPlugin.get(pluginPath) || [];
    assert.equal(callbacks.length - before, 1, `${pluginName} must register one MainApplication callback`);
    return callbacks.at(-1);
  });
} finally {
  Module._load = originalLoad;
}

const cases = [
  {
    name: "kotlin-original-apply-from-app-config",
    language: "kt",
    contents: "override fun getPackages(): List<ReactPackage> =\n  PackageList(this).packages.apply {\n  }",
  },
  {
    name: "kotlin-packages-assignment",
    language: "kt",
    contents: "val packages = PackageList(this).packages\nreturn packages",
  },
  {
    name: "kotlin-direct-return",
    language: "kt",
    contents: "return PackageList(this).packages",
  },
  {
    name: "java-packages-assignment",
    language: "java",
    contents: "List<ReactPackage> packages = new PackageList(this).getPackages();\nreturn packages;",
  },
  {
    name: "java-direct-return",
    language: "java",
    contents: "return new PackageList(this).getPackages();",
  },
];
const nativePackages = [
  "TermuxBridgePackage",
  "GithubToolPackage",
  "AibDeviceWatchdogPackage",
  "AibAccessibilityPackage",
  "AibMemoryPressurePackage",
];
function applyAll(contents, language, callbacks = pluginCallbacks) {
  const modConfig = { modResults: { language, contents } };
  for (const callback of callbacks) callback(modConfig);
  return modConfig.modResults.contents;
}
function assertOneRegistration(contents, packageName, testName) {
  const uncommented = contents
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/(\s)\/\/.*$/gm, "$1");
  const registration = new RegExp(`\\badd\\s*\\(\\s*(?:new\\s+)?${packageName}\\s*\\(\\s*\\)\\s*\\)`, "g");
  assert.equal((uncommented.match(registration) || []).length, 1,
    `${testName} must register ${packageName} exactly once`);
}

for (const fixture of cases) {
  const output = applyAll(fixture.contents, fixture.language);
  for (const packageName of nativePackages) assertOneRegistration(output, packageName, fixture.name);
  const repeated = applyAll(output, fixture.language);
  assert.equal(repeated, output, `${fixture.name} plugin callbacks must be idempotent`);
  if (fixture.name === "kotlin-original-apply-from-app-config") {
    assert.match(output, /PackageList\(this\)\.packages\.toMutableList\(\)\.apply\s*\{/,
      "TermuxBridge must first transform the app.config.ts legacy apply form to the mutable-list apply form");
  }
}

for (const callback of pluginCallbacks) {
  const unsupported = { modResults: { language: "kt", contents: "class MainApplication {}" } };
  assert.throws(() => callback(unsupported), undefined,
    "unsupported MainApplication shape must remain fail-closed");
}

console.log(`AIB_V502_MAIN_APPLICATION_PACKAGE_REGISTRATION_OK callbacks=${pluginCallbacks.length} fixtures=${cases.length} packages=${nativePackages.length} idempotent=1 fail_closed=1 prebuild=NOT_RUN`);
