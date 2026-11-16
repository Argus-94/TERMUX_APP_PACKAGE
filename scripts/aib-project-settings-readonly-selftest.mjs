#!/usr/bin/env node
import fs from "node:fs";
const files = ["lib/termux-agent.ts","lib/build-loop.ts","lib/script-runner-agent.ts"];
// local.properties (sdk.dir) is intentionally written for the *target* project being built — not AI Builder itself.
const bad = /(?:>|>>|sed\s+-i|mv\s+-f|touch)\s*(?:[^\n]*\/)?(?:gradle\.properties|gradle\/wrapper\/gradle-wrapper\.properties|gradle\/gradle-daemon-jvm\.properties)/i;
for (const file of files) {
  const src = fs.readFileSync(file,"utf8");
  if (bad.test(src)) throw new Error(`AIB_PROJECT_SETTINGS_MUTATION_PRESENT:${file}`);
  if (/gradle-8\.10\.2-bin\.zip|distributionSha256Sum=31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26/.test(src)) throw new Error(`AIB_PROJECT_GRADLE_PIN_PRESENT:${file}`);
}
const builtinSource = fs.readFileSync("lib/builtin-build-script.ts","utf8");
if (/delete p\.packageManager|gradle-8\.10\.2-bin\.zip/.test(builtinSource)) throw new Error("AIB_BUILTIN_PROJECT_SETTINGS_MUTATION_PRESENT");
console.log("AIB_PROJECT_SETTINGS_READONLY_SELFTEST_OK");
