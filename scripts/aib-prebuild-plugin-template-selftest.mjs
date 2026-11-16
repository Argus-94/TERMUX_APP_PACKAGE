#!/usr/bin/env node
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const root = process.cwd();
const checks = [
  ["plugins/withTermuxBridge.js", ["moduleKotlin", "packageKotlin"]],
  ["plugins/withAibNativeAccel.js", ["moduleKotlin", "packageKotlin"]],
  ["plugins/withAibDeviceWatchdog.js", ["moduleKotlin", "packageKotlin"]],
  ["plugins/withGithubTool.js", ["bridgeKotlin"]],
];

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`MISSING_FUNCTION:${name}`);
  const next = source.indexOf("\nfunction ", start + 10);
  return source.slice(start, next < 0 ? source.length : next);
}

for (const [relative, functions] of checks) {
  const file = path.join(root, relative);
  const source = fs.readFileSync(file, "utf8");
  const context = {};
  vm.createContext(context);
  for (const name of functions) {
    vm.runInContext(extractFunction(source, name), context, { filename: file });
    const fn = context[name];
    if (typeof fn !== "function") throw new Error(`NOT_FUNCTION:${relative}:${name}`);
    const generated = fn("com.karat.aibuilder");
    if (typeof generated !== "string" || generated.length < 100) {
      throw new Error(`EMPTY_GENERATED_KOTLIN:${relative}:${name}`);
    }
  }
}

const termux = fs.readFileSync(path.join(root, "plugins/withTermuxBridge.js"), "utf8");
if (!termux.includes('private fun nativeLogTag(): String = "AIB-TermuxBridge"')) {
  throw new Error("NATIVE_LOG_TAG_MUST_BE_STATIC:withTermuxBridge.nativeLogTag");
}
console.log("AIB_PREBUILD_PLUGIN_TEMPLATE_SELFTEST_OK templates=7 native_log_tag=static");
