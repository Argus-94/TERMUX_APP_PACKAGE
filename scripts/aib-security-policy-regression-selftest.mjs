#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { typescript as ts } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const policySource = fs.readFileSync(path.join(root, "lib/security-policy.ts"), "utf8");
const compiled = ts.transpileModule(policySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const policyModule = { exports: {} };
const mockRequire = (name) => {
  if (name === "./persistent-logger") return { persistentLogger: { add() {} } };
  if (name === "./agent-unrestricted.ts") return { catastrophicCommandReason: () => null, isAgentUnrestrictedShell: () => false };
  throw new Error(`unexpected import in policy test: ${name}`);
};
vm.runInNewContext(compiled, {
  require: mockRequire,
  module: policyModule,
  exports: policyModule.exports,
});
const { evaluateCommandPolicy } = policyModule.exports;

assert.equal(evaluateCommandPolicy("id", "shizuku").ok, true);
assert.equal(evaluateCommandPolicy("echo 'literal ; | text'", "shizuku").ok, true);
for (const command of [
  "ls; touch /tmp/aib-policy-probe",
  "ls && touch /tmp/aib-policy-probe",
  "id; uname -a | head -1",
  "echo \"$(touch /tmp/aib-policy-probe)\"",
  "bash -c 'touch /tmp/aib-policy-probe'",
  "node -e 'require(\"fs\").writeFileSync(\"/tmp/aib-policy-probe\", \"x\")'",
  "find /tmp -exec touch /tmp/aib-policy-probe \\;",
  "awk 'BEGIN { system(\"touch /tmp/aib-policy-probe\") }'",
  "tar -xf x.tar --to-command='touch /tmp/aib-policy-probe'",
]) {
  assert.equal(evaluateCommandPolicy(command, "shizuku").ok, false, `Shizuku accepted: ${command}`);
}
assert.equal(evaluateCommandPolicy("ls; touch /tmp/aib-policy-probe", "plugin").ok, false);
for (const command of [
  "bash -c 'touch /tmp/aib-policy-probe'",
  "node -e 'require(\"fs\").writeFileSync(\"/tmp/aib-policy-probe\", \"x\")'",
  "python3 -c 'import os; os.remove(\"/tmp/aib-policy-probe\")'",
  "find /tmp -exec touch /tmp/aib-policy-probe \\;",
]) assert.equal(evaluateCommandPolicy(command, "plugin").ok, false, `Plugin accepted: ${command}`);
assert.equal(evaluateCommandPolicy("ls; touch /tmp/aib-policy-probe", "termux", { interactive: true }).ok, true);
for (const command of [
  "adb devices",
  "/usr/bin/adb connect 127.0.0.1:5555",
  "env ADB_SERVER_SOCKET=tcp:localhost:5037 adb devices",
  "command adb install app.apk",
  "busybox adb devices",
  "echo ready; adb devices",
  "sh -c 'adb devices'",
  "echo $(adb devices)",
  "echo `adb devices`",
]) {
  assert.equal(evaluateCommandPolicy(command, "termux").ok, false, `generic Agent shell accepted ADB: ${command}`);
}
assert.equal(evaluateCommandPolicy("echo 'adb devices'", "termux").ok, true, "a harmless textual mention is not an ADB invocation");
assert.equal(evaluateCommandPolicy("adb devices", "termux", { interactive: true }).ok, true, "explicit interactive user shell remains available");

const shizuku = fs.readFileSync(path.join(root, "lib/shizuku-bridge.ts"), "utf8");
assert.match(shizuku, /function shellQuote\(value: string\)/);
assert.match(shizuku, /rish -c \$\{shellQuote\(command\)\}/);
assert.match(shizuku, /shizukuExec\("id"/);
console.log("AIB_SECURITY_POLICY_REGRESSION_OK compound=blocked substitutions=blocked plugin_interpreters=blocked generic_adb=blocked interactive_adb=preserved rish_quoting=single_arg");
