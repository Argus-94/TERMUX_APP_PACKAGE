#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const file = path.join(root, "plugins", "withTermuxBridge.js");
const source = fs.readFileSync(file, "utf8");

const appDecl = 'const application = manifest.application[0];';
const receiverAccess = 'if (!Array.isArray(application.receiver)) application.receiver = [];';
const appDeclAt = source.indexOf(appDecl);
const receiverAt = source.indexOf(receiverAccess);
if (appDeclAt < 0 || receiverAt < 0 || appDeclAt > receiverAt) {
  throw new Error("withTermuxBridge must initialize manifest.application before accessing application.receiver");
}

const duplicateDecls = (source.match(/const application = manifest\.application\[0\];/g) || []).length;
if (duplicateDecls !== 1) {
  throw new Error(`Expected exactly one application declaration, found ${duplicateDecls}`);
}

if (!source.includes('addPermission("com.termux.permission.RUN_COMMAND")')) {
  throw new Error("Termux RUN_COMMAND permission declaration is missing");
}
if (!source.includes('addPermission("android.permission.REQUEST_INSTALL_PACKAGES")')) {
  throw new Error("REQUEST_INSTALL_PACKAGES declaration is missing");
}
if (!source.includes('android:name": ".TermuxResultReceiver"')) {
  throw new Error("Private Termux result receiver declaration is missing");
}
if (!source.includes('android:exported": "false"')) {
  throw new Error("Termux result receiver must remain private");
}

console.log("AIB_V295_TERMUX_PREBUILD_SELFTEST_OK");
