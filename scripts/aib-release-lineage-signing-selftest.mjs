#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildApksignerSignArgs,
  CURRENT_SIGNER_SHA256,
  LEGACY_SIGNER_SHA256,
  LINEAGE_SHA256,
  validateApkVerificationOutput,
  validateJarsignerVerificationOutput,
  validateLineageOutput,
} from "./aib-sign-android-release-lineage.mjs";

const lineage = `Signer #1 in lineage certificate SHA-256 digest: ${LEGACY_SIGNER_SHA256}\nSigner #2 in lineage certificate SHA-256 digest: ${CURRENT_SIGNER_SHA256}\n`;
assert.deepEqual(validateLineageOutput(lineage), [LEGACY_SIGNER_SHA256, CURRENT_SIGNER_SHA256]);
assert.throws(() => validateLineageOutput(lineage.replace(CURRENT_SIGNER_SHA256, "0".repeat(64))), /AIB_RELEASE_LINEAGE_CERTIFICATES_INVALID/);

const v1Api = [
  "Verified using v1 scheme (JAR signing): true",
  "Verified using v2 scheme (APK Signature Scheme v2): false",
  "Verified using v3 scheme (APK Signature Scheme v3): false",
  "Number of signers: 1",
  `Signer #1 certificate SHA-256 digest: ${LEGACY_SIGNER_SHA256}`,
].join("\n");
const oldApi = [
  "Verified using v1 scheme (JAR signing): false",
  "Verified using v2 scheme (APK Signature Scheme v2): true",
  "Verified using v3 scheme (APK Signature Scheme v3): false",
  "Number of signers: 1",
  `Signer #1 certificate SHA-256 digest: ${LEGACY_SIGNER_SHA256}`,
].join("\n");
const newApi = [
  "Verified using v1 scheme (JAR signing): false",
  "Verified using v2 scheme (APK Signature Scheme v2): false",
  "Verified using v3 scheme (APK Signature Scheme v3): true",
  "Number of signers: 1",
  `Signer #1 certificate SHA-256 digest: ${CURRENT_SIGNER_SHA256}`,
].join("\n");
assert.deepEqual(validateApkVerificationOutput(v1Api, { expectedSigner: LEGACY_SIGNER_SHA256, v1: true, v2: false, v3: false }), {
  signerSha256: LEGACY_SIGNER_SHA256, v1: true, v2: false, v3: false,
});
assert.deepEqual(validateApkVerificationOutput(oldApi, { expectedSigner: LEGACY_SIGNER_SHA256, v1: false, v2: true, v3: false }), {
  signerSha256: LEGACY_SIGNER_SHA256, v1: false, v2: true, v3: false,
});
assert.deepEqual(validateApkVerificationOutput(newApi, { expectedSigner: CURRENT_SIGNER_SHA256, v1: false, v2: false, v3: true }), {
  signerSha256: CURRENT_SIGNER_SHA256, v1: false, v2: false, v3: true,
});
assert.throws(() => validateApkVerificationOutput(v1Api.replace("Verified using v1 scheme (JAR signing): true", "Verified using v1 scheme (JAR signing): false"), { expectedSigner: LEGACY_SIGNER_SHA256, v1: true, v2: false, v3: false }), /AIB_RELEASE_LINEAGE_APK_SIGNATURE_POLICY_INVALID/);
assert.throws(() => validateApkVerificationOutput(oldApi, { expectedSigner: CURRENT_SIGNER_SHA256, v1: false, v2: true, v3: false }), /AIB_RELEASE_LINEAGE_APK_SIGNATURE_POLICY_INVALID/);
assert.throws(() => validateApkVerificationOutput(newApi.replace("Number of signers: 1", "Number of signers: 2"), { expectedSigner: CURRENT_SIGNER_SHA256, v1: false, v2: false, v3: true }), /AIB_RELEASE_LINEAGE_APK_SIGNATURE_POLICY_INVALID/);

assert.equal(validateJarsignerVerificationOutput("jar verified.\n"), true);
assert.throws(() => validateJarsignerVerificationOutput("jar is unsigned."), /AIB_RELEASE_LINEAGE_V1_JARSIGNER_INVALID/);

const args = buildApksignerSignArgs({
  input: "build/app-release.apk", output: "out/app.apk", lineage: "assets/signing/karat-old-to-new.lineage",
  legacyStore: "/keys/legacy.jks", currentStore: "/tmp/current.jks",
});
assert.equal(args[args.indexOf("--rotation-min-sdk-version") + 1], "28");
assert.equal(args[args.indexOf("--v1-signing-enabled") + 1], "true");
assert.equal(args[args.indexOf("--v2-signing-enabled") + 1], "true");
assert.equal(args[args.indexOf("--v3-signing-enabled") + 1], "true");
assert.equal(args[args.indexOf("--v4-signing-enabled") + 1], "false");
assert.ok(args.indexOf("--ks", args.indexOf("--next-signer")) > args.indexOf("--next-signer"));
assert.ok(args.includes("env:AIB_RELEASE_LEGACY_STORE_PASSWORD"));
assert.ok(args.includes("env:AIB_RELEASE_CURRENT_STORE_PASSWORD"));
assert.ok(args.includes("assets/signing/karat-old-to-new.lineage"));
assert.equal(LINEAGE_SHA256, "b0dc785c921d6a53d2b834f57d11affbff9cd234298674cb37ab6f6d19f1f41e");

console.log("AIB_RELEASE_LINEAGE_SIGNING_SELFTEST_OK lineage=old-to-current api18_23=v1 api24_27=legacy-v2 api28_36=current-v3 jarsigner=true multi-signer-rejected=true credentials=env-only");
