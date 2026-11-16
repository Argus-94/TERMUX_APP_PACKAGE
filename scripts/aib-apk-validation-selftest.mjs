#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Module from "node:module";
import { createRequire } from "node:module";
import { typescript as ts } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const file = path.join(root, "lib/apk-validation.ts");
const mod = new Module(file);
mod.filename = file;
mod.paths = Module._nodeModulePaths(path.dirname(file));
mod._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: file,
}).outputText, file);
const { buildApkValidationCommand, parseApkValidation } = mod.exports;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-apk-validation-"));
try {
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  const isolatedHome = path.join(temp, "home");
  fs.mkdirSync(isolatedHome);
  const certDigest = "a".repeat(64);
  const signer = path.join(bin, "apksigner");
  const aapt2 = path.join(bin, "aapt2");
  const emitSigned = ({ schemes = "true", certificate = certDigest } = {}) => {
    const certLine = certificate ? `printf '%s\\n' 'Signer #1 certificate SHA-256 digest: ${certificate}'\n` : "";
    fs.writeFileSync(signer,
      `#!/bin/sh\nprintf '%s\\n' 'Verifies' 'Verified using v1 scheme (JAR signing): ${schemes}' 'Verified using v2 scheme (APK Signature Scheme v2): ${schemes}' 'Verified using v3 scheme (APK Signature Scheme v3): ${schemes}'\n${certLine}`,
      { mode: 0o755 },
    );
  };
  fs.writeFileSync(aapt2, `#!/bin/sh
if [ "$1" != dump ] || [ "$2" != badging ]; then exit 2; fi
PKG="\${AIB_TEST_PACKAGE:-test.app}"
VER="\${AIB_TEST_VERSION_NAME:-1.8.99}"
printf "package: name='%s' versionCode='42' versionName='%s'\\n" "$PKG" "$VER"
`, { mode: 0o755 });
  const run = (apk, {
    pathValue = `${bin}:/usr/bin:/bin`,
    backend = "termux",
    packageName = "test.app",
    versionName = "1.8.99",
    env = {},
  } = {}) => spawnSync("/bin/bash", ["-c", buildApkValidationCommand(apk, backend, {
    expectedPackageName: packageName,
    expectedVersionName: versionName,
  })], {
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: pathValue, HOME: isolatedHome, PREFIX: `${temp}/prefix`, ANDROID_HOME: "", ANDROID_SDK_ROOT: "" },
  });
  const output = (r) => `${r.stdout || ""}\n${r.stderr || ""}`;

  const validDir = path.join(temp, "valid");
  fs.mkdirSync(validDir);
  fs.writeFileSync(path.join(validDir, "AndroidManifest.xml"), "binary manifest fixture\n");
  const validApk = path.join(temp, "valid app.apk");
  const zip = spawnSync("zip", ["-q", validApk, "AndroidManifest.xml"], { cwd: validDir, encoding: "utf8" });
  assert.equal(zip.status, 0, `APK ZIP fixture creation failed: ${zip.stderr}`);
  emitSigned();
  const valid = run(validApk);
  assert.equal(valid.status, 0, output(valid));
  assert.match(output(valid), /AIB_APK_VERIFIED/);
  assert.ok(output(valid).includes("AIB_APK_PACKAGE=test.app"));
  assert.ok(output(valid).includes(`AIB_APK_CERT_SHA256=${certDigest}`));
  const parsedValid = parseApkValidation(output(valid), valid.status);
  assert.equal(parsedValid.ok, true);
  assert.equal(parsedValid.packageName, "test.app");
  assert.equal(parsedValid.versionCode, "42");
  assert.equal(parsedValid.certificateSha256, certDigest);

  const ubuntuCommand = buildApkValidationCommand(validApk, "ubuntu-proot");
  assert.match(ubuntuCommand, /unset PREFIX/);
  assert.match(ubuntuCommand, /\/usr\/lib\/android-sdk/);
  assert.doesNotMatch(ubuntuCommand, /\/data\/data\/com[.]termux|PREFIX[/]opt[/]aibuilder-toolpack/);
  const ubuntuValid = run(validApk, { pathValue: `${bin}:/usr/bin:/bin`, backend: "ubuntu-proot" });
  assert.equal(ubuntuValid.status, 0, `Ubuntu guest validation failed: ${output(ubuntuValid)}`);
  assert.match(output(ubuntuValid), /AIB_APK_VALIDATION_BACKEND=ubuntu-proot/);

  const apostropheApk = path.join(temp, "owner's app.apk");
  fs.copyFileSync(validApk, apostropheApk);
  assert.equal(run(apostropheApk).status, 0, "quoted APK path must pass");

  const noSignerBin = path.join(temp, "no-signer-bin");
  const noAaptBin = path.join(temp, "no-aapt-bin");
  const noUnzipBin = path.join(temp, "no-unzip-bin");
  fs.mkdirSync(noSignerBin);
  fs.mkdirSync(noAaptBin);
  fs.mkdirSync(noUnzipBin);
  fs.symlinkSync(aapt2, path.join(noSignerBin, "aapt2"));
  fs.symlinkSync(signer, path.join(noAaptBin, "apksigner"));
  for (const utility of ["wc", "tr", "grep", "head", "sed"]) {
    fs.symlinkSync(`/usr/bin/${utility}`, path.join(noUnzipBin, utility));
  }
  fs.symlinkSync(signer, path.join(noUnzipBin, "apksigner"));
  fs.symlinkSync(aapt2, path.join(noUnzipBin, "aapt2"));
  assert.match(output(run(validApk, { pathValue: `${noSignerBin}:/usr/bin:/bin` })), /AIB_APK_APKSIGNER_MISSING/);
  assert.match(output(run(validApk, { pathValue: `${noAaptBin}:/usr/bin:/bin` })), /AIB_APK_AAPT2_MISSING/);
  assert.match(output(run(validApk, { pathValue: noUnzipBin })), /AIB_APK_ZIP_TOOL_MISSING/);

  const unreadableApk = path.join(temp, "unreadable.apk");
  fs.copyFileSync(validApk, unreadableApk);
  fs.chmodSync(unreadableApk, 0);
  const unreadable = run(unreadableApk);
  fs.chmodSync(unreadableApk, 0o600);
  assert.notEqual(unreadable.status, 0, "unreadable artifact must fail closed");
  assert.match(output(unreadable), /AIB_APK_EMPTY|AIB_APK_ARCHIVE_CORRUPT/);

  const symlinkApk = path.join(temp, "linked.apk");
  fs.symlinkSync(validApk, symlinkApk);
  const symlinkResult = run(symlinkApk);
  assert.notEqual(symlinkResult.status, 0);
  assert.match(output(symlinkResult), /AIB_APK_MISSING_OR_NOT_REGULAR/);

  const wrongPackage = run(validApk, { env: { AIB_TEST_PACKAGE: "com.foreign.app" } });
  assert.notEqual(wrongPackage.status, 0);
  assert.match(output(wrongPackage), /AIB_APK_PACKAGE_MISMATCH/);
  const wrongVersion = run(validApk, { env: { AIB_TEST_VERSION_NAME: "0.0.1" } });
  assert.notEqual(wrongVersion.status, 0);
  assert.match(output(wrongVersion), /AIB_APK_VERSION_NAME_MISMATCH/);

  const noManifestDir = path.join(temp, "no-manifest");
  fs.mkdirSync(noManifestDir);
  fs.writeFileSync(path.join(noManifestDir, "not-manifest.txt"), "not an apk\n");
  const noManifestApk = path.join(temp, "no-manifest.apk");
  assert.equal(spawnSync("zip", ["-q", noManifestApk, "not-manifest.txt"], { cwd: noManifestDir }).status, 0);
  const noManifest = run(noManifestApk);
  assert.notEqual(noManifest.status, 0);
  assert.match(output(noManifest), /AIB_APK_MANIFEST_MISSING/);

  const aabDir = path.join(temp, "aab");
  fs.mkdirSync(path.join(aabDir, "base", "manifest"), { recursive: true });
  fs.writeFileSync(path.join(aabDir, "base", "manifest", "AndroidManifest.xml"), "bundle manifest\n");
  const aabPath = path.join(temp, "valid.aab");
  assert.equal(spawnSync("zip", ["-q", "-r", aabPath, "base"], { cwd: aabDir }).status, 0);
  const jarSigner = path.join(bin, "jarsigner");
  fs.writeFileSync(jarSigner, "#!/bin/sh\necho 'jar verified.'\nexit 0\n", { mode: 0o755 });
  const validAab = run(aabPath, { packageName: "", versionName: "" });
  assert.equal(validAab.status, 0, output(validAab));
  assert.match(output(validAab), /AIB_AAB_SIGNATURE_VERIFIED/);
  assert.equal(parseApkValidation(output(validAab), validAab.status).ok, true);
  fs.writeFileSync(jarSigner, "#!/bin/sh\necho 'jar verification failed.'\nexit 1\n", { mode: 0o755 });
  const invalidAab = run(aabPath, { packageName: "", versionName: "" });
  assert.notEqual(invalidAab.status, 0);
  assert.match(output(invalidAab), /AIB_AAB_SIGNATURE_INVALID/);

  const corruptApk = path.join(temp, "corrupt.apk");
  fs.writeFileSync(corruptApk, "not a ZIP archive\n");
  const corrupt = run(corruptApk);
  assert.notEqual(corrupt.status, 0);
  assert.match(output(corrupt), /AIB_APK_ARCHIVE_CORRUPT/);
  assert.equal(parseApkValidation(output(corrupt), corrupt.status).ok, false);

  const emptyApk = path.join(temp, "empty.apk");
  fs.writeFileSync(emptyApk, "");
  const empty = run(emptyApk);
  assert.notEqual(empty.status, 0);
  assert.match(output(empty), /AIB_APK_EMPTY/);

  emitSigned({ schemes: "false" });
  const unsigned = run(validApk);
  assert.notEqual(unsigned.status, 0);
  assert.match(output(unsigned), /AIB_APK_SIGNATURE_INVALID|AIB_APK_V1_SIGNATURE_MISSING/);
  assert.equal(parseApkValidation(output(unsigned), unsigned.status).ok, false);

  emitSigned({ certificate: "" });
  const noCertificateDigest = run(validApk);
  assert.notEqual(noCertificateDigest.status, 0);
  assert.match(output(noCertificateDigest), /AIB_APK_CERTIFICATE_DIGEST_MISSING/);

  const truncatedOrForged = parseApkValidation("AIB_APK_SIZE=12000\\nAIB_APK_VERIFIED\\n", 0);
  assert.equal(truncatedOrForged.ok, false, "terminal marker without identity/signature evidence must be rejected");

  console.log("AIB_APK_VALIDATION_SELFTEST_OK valid_signed=PASS package_version=PASS cert_digest=PASS symlink=REJECT missing_manifest=REJECT corrupt=REJECT empty=REJECT unsigned=REJECT aab=PASS");
  console.log("NOTE: the signed APK case uses a fake apksigner to test gate control flow, not cryptographic/device verification.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
