#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __AIB_VER = (await import("node:fs")).readFileSync(new URL("../core/runtime/RuntimeIdentity.ts", import.meta.url), "utf8").match(/appVersion: "([^"]+)"/)[1]; // v407: single source of truth (RuntimeIdentity == package.json)

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedId = ["com", "karat", "aibuilder"].join(".");
const retiredMarker = String.fromCharCode(115, 97, 107, 97, 110, 97);
const skipped = new Set(["node_modules", "android", ".git", ".expo", ".gradle", "build", ".cache", "__pycache__"]);
const scanIssues = [];
let textFilesScanned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (new RegExp(retiredMarker, "i").test(entry.name)) {
      scanIssues.push(`PATH:${path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/")}`);
    }
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) walk(path.join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
    } catch {
      continue;
    }
    textFilesScanned += 1;
    if (new RegExp(retiredMarker, "i").test(text)) {
      scanIssues.push(path.relative(root, file).split(path.sep).join("/"));
    }
  }
}

const appConfig = fs.readFileSync(path.join(root, "app.config.ts"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const identity = JSON.parse(fs.readFileSync(path.join(root, "AI_BUILDER_ANDROID_IDENTITY.json"), "utf8"));
assert.match(appConfig, new RegExp(`package:\\s*["']${expectedId.replaceAll(".", "\\.")}["']`), "Expo Android application ID must match the requested identity");
assert.match(appConfig, new RegExp(`bundleIdentifier:\\s*["']${expectedId.replaceAll(".", "\\.")}["']`), "Expo iOS bundle identifier must match the requested identity");
assert.equal(identity.applicationId, expectedId, "canonical applicationId mismatch");
assert.equal(identity.namespace, expectedId, "canonical namespace mismatch");
assert.match(appConfig, /name:\s*[\"']AI Builder[\"']/);
assert.match(appConfig, /slug:\s*[\"']ai-builder[\"']/);
assert.equal(packageJson.version, __AIB_VER, "application version must remain unchanged");

for (const relative of [
  "native/aib-credential-proxy/AibCredentialHttpProxyServer.java",
  "native/aib-credential-proxy/AibCredentialProxyModule.kt",
  "native/aib-credential-proxy/AibCredentialProxyPackage.kt",
  "native/aib-interceptor/AibInterceptorProxyServer.java",
  "native/aib-interceptor/AibInterceptorCertificateStore.kt",
  "native/aib-interceptor/AibInterceptorProxyModule.kt",
  "native/aib-interceptor/AibInterceptorProxyPackage.kt",
]) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  assert.match(source, new RegExp(`^package\\s+${expectedId.replaceAll(".", "\\.")};?\\s*$`, "m"), `native package mismatch: ${relative}`);
}

const jni = fs.readFileSync(path.join(root, "native/aib-native-accel/src/aib_accel_jni.c"), "utf8");
assert.ok(jni.includes("Java_com_karat_aibuilder_AibAccelNative_version"), "JNI version symbol mismatch");
assert.ok(jni.includes("Java_com_karat_aibuilder_AibAccelNative_mapPath"), "JNI mapPath symbol mismatch");
for (const relative of ["plugins/withAibCredentialProxy.js", "plugins/withAibInterceptor.js"]) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  assert.ok(source.includes("config.android?.package"), `package-derived path missing: ${relative}`);
  assert.ok(source.includes('pkg.split(".")'), `package segments are not used for native path: ${relative}`);
}
const nativeAccel = fs.readFileSync(path.join(root, "plugins/withAibNativeAccel.js"), "utf8");
assert.ok(nativeAccel.includes('"com.karat.aibuilder"'), "native accelerator fallback mismatch");
assert.ok(!nativeAccel.includes("com.anonymous.aibuilder"), "legacy anonymous fallback remains");

walk(root);
assert.deepEqual(scanIssues, [], "retired identity marker remains in UTF-8 source/archive text");
console.log(`AIB_APPLICATION_IDENTITY_SELFTEST_OK id=${expectedId} version=${packageJson.version} text_files=${textFilesScanned} retired_marker_matches=0`);
