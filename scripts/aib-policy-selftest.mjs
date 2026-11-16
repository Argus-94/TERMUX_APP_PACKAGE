#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aib-policy-"));
const hashline = path.resolve(path.dirname(process.argv[1]), "aib-hashline.mjs");
const sample = path.join(root, "x.ts");
fs.writeFileSync(sample, "one\ntwo\nthree\n");
function run(...args){ return spawnSync(process.execPath,[hashline,...args],{cwd:root,encoding:"utf8"}); }
let r=run("read","x.ts","1","3"); if(r.status!==0) throw new Error("hashline read");
const rows=r.stdout.trim().split(/\n/); const h1=rows[0].split("|")[1], h3=rows[2].split("|")[1];
r=run("replace-range","x.ts","1","3",h1,h3,"alpha\\nbeta"); if(r.status!==0) throw new Error("range replace");
r=run("replace","x.ts","1",h1,"bad"); if(r.status===0 || !/HASHLINE_STALE/.test(r.stderr)) throw new Error("stale range protection");
const missing=path.join(root,"new.txt"); r=run("create","new.txt",Buffer.from("ok").toString("base64")); if(r.status!==0 || !fs.existsSync(missing)) throw new Error("create");
const sha=await import("node:crypto").then(c=>c.createHash("sha256").update(fs.readFileSync(missing)).digest("hex"));
r=run("delete","new.txt",sha); if(r.status!==0 || fs.existsSync(missing)) throw new Error("delete");
const tools=fs.readFileSync(path.resolve(path.dirname(process.argv[1]),"..","lib","agent-tools.ts"),"utf8");
for(const needle of ["validateAgentToolCall","PATH_NOT_ALLOWED","CONTENT_REQUIRED_OR_TOO_LARGE","LSP_NEW_NAME_INVALID","MEMORY_RETAIN_INVALID","BUILD_DEPENDENCY_MUTATION_NOT_ALLOWED","BUILD_DEPENDENCY_INSTALL_NOT_FROZEN"]){ if(!tools.includes(needle)) throw new Error(`missing policy ${needle}`); }
if(!/function dependencyMutationError\(command:string\)/.test(tools)) throw new Error("BUILD_DEPENDENCY_POLICY_HELPER_MISSING");
for(const forbidden of [
  "pnpm add react-native-test",
  "pnpm remove old-package",
  "pnpm update react",
  "npm install lodash",
  "npm uninstall lodash",
  "yarn add left-pad",
  "bun install",
  "pnpm install"
]) {
  if(!tools.includes(forbidden.split(/\s+/)[0])) throw new Error("package-manager-policy-source-missing");
}
if(!/pnpm\\s\+install\\b/.test(tools) || !tools.includes("--frozen-lockfile")) throw new Error("FROZEN_PNPM_POLICY_SOURCE_MISSING");
console.log("AIB_POLICY_SELFTEST_OK");
