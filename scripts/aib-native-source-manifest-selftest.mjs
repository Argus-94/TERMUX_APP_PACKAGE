#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { REQUIRED_NATIVE_SOURCE_ASSETS, missingNativeSourceAssets, nativeSourceChecksumErrors, assertRequiredNativeSourceAssets } =
  require("../plugins/native-source-manifest.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aib-native-manifest-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aib-native-outside-"));
try {
  const manifestPaths = new Set(["plugins/android/SHA256SUMS", "plugins/android/ADDITIONAL-SHA256SUMS"]);
  for (const relative of REQUIRED_NATIVE_SOURCE_ASSETS) {
    if (manifestPaths.has(relative)) continue;
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "// fixture source\n", { mode: 0o644 });
  }
  for (const [manifest, files] of [
    ["plugins/android/SHA256SUMS", ["AibAccessibilityService.kt", "AibAccessibilityModule.kt", "AibAccessibilityPackage.kt", "aib_accessibility_service.xml", "AibLoopbackServer.kt"]],
    ["plugins/android/ADDITIONAL-SHA256SUMS", ["AibMemoryPressureModule.kt", "AibMemoryPressurePackage.kt"]],
  ]) {
    const lines = files.map((name) => {
      const bytes = fs.readFileSync(path.join(root, "plugins/android", name));
      return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`;
    });
    fs.writeFileSync(path.join(root, manifest), `${lines.join("\n")}\n`, { mode: 0o644 });
  }
  assert.deepEqual(missingNativeSourceAssets(root), []);
  assert.deepEqual(nativeSourceChecksumErrors(root), []);
  assert.doesNotThrow(() => assertRequiredNativeSourceAssets(root));

  const integrityProbe = path.join(root, "plugins/android/AibAccessibilityService.kt");
  fs.appendFileSync(integrityProbe, "// tamper\n");
  assert.ok(nativeSourceChecksumErrors(root).some((item) => item.includes("SHA-256 mismatch")), "changed canonical source must fail pinned digest verification");
  fs.writeFileSync(integrityProbe, "// fixture source\n");

  const unreadable = path.join(root, REQUIRED_NATIVE_SOURCE_ASSETS[0]);
  fs.chmodSync(unreadable, 0o000);
  assert(missingNativeSourceAssets(root).some((item) => item.includes("unreadable")));
  fs.chmodSync(unreadable, 0o644);

  const empty = path.join(root, REQUIRED_NATIVE_SOURCE_ASSETS[1]);
  fs.writeFileSync(empty, "");
  assert(missingNativeSourceAssets(root).some((item) => item.includes("empty or unreadable")));
  fs.writeFileSync(empty, "// restored fixture\n");

  const symlink = path.join(root, REQUIRED_NATIVE_SOURCE_ASSETS[2]);
  fs.unlinkSync(symlink);
  fs.writeFileSync(path.join(outside, "external.kt"), "// outside fixture\n");
  fs.symlinkSync(path.join(outside, "external.kt"), symlink);
  assert(missingNativeSourceAssets(root).some((item) => item.includes("regular in-project file")));

  const missing = path.join(root, REQUIRED_NATIVE_SOURCE_ASSETS[3]);
  fs.unlinkSync(missing);
  assert(missingNativeSourceAssets(root).some((item) => item === REQUIRED_NATIVE_SOURCE_ASSETS[3]));
  const checksums = path.join(root, "plugins/android/SHA256SUMS");
  fs.unlinkSync(checksums);
  assert(missingNativeSourceAssets(root).some((item) => item === "plugins/android/SHA256SUMS"), "the canonical SHA256SUMS file is required by preinstall/prebuild preflight");
  console.log(`AIB_NATIVE_SOURCE_MANIFEST_SELFTEST_OK assets=${REQUIRED_NATIVE_SOURCE_ASSETS.length} cases=present,digest-tamper,empty,unreadable,symlink,missing,sha256-manifest`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
