#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LEGACY_SIGNER_SHA256 = "b5dacc6f9c37adceace5c0d715eecb2762b5a0417468e221ec9c534ea1e6328e";
export const CURRENT_SIGNER_SHA256 = "661e5c868dbb38f8fe57d380e5c9b35e594e79bedb72d9ad2ad0113665c80418";
export const LINEAGE_SHA256 = "b0dc785c921d6a53d2b834f57d11affbff9cd234298674cb37ab6f6d19f1f41e";

function normalizeSha256(value) {
  return String(value ?? "").replace(/[^a-f0-9]/gi, "").toLowerCase();
}

export function validateLineageOutput(output) {
  const digests = [...String(output).matchAll(/Signer #\d+ in lineage certificate SHA-256 digest:\s*([a-f0-9:]{64,95})/gi)]
    .map((match) => normalizeSha256(match[1]));
  if (digests.length !== 2 || digests[0] !== LEGACY_SIGNER_SHA256 || digests[1] !== CURRENT_SIGNER_SHA256) {
    throw new Error("AIB_RELEASE_LINEAGE_CERTIFICATES_INVALID");
  }
  return digests;
}

export function validateApkVerificationOutput(output, { expectedSigner, v1, v2, v3 }) {
  const text = String(output);
  const v1Result = text.match(/Verified using v1 scheme \(JAR signing\): (true|false)/i)?.[1]?.toLowerCase();
  const v2Result = text.match(/Verified using v2 scheme \(APK Signature Scheme v2\): (true|false)/i)?.[1]?.toLowerCase();
  const v3Result = text.match(/Verified using v3 scheme \(APK Signature Scheme v3\): (true|false)/i)?.[1]?.toLowerCase();
  const signerCount = Number(text.match(/Number of signers:\s*(\d+)/i)?.[1] ?? 0);
  const signerDigests = [...text.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9:]{64,95})/gi)]
    .map((match) => normalizeSha256(match[1]));
  const actual = `v1=${v1Result ?? "missing"},v2=${v2Result ?? "missing"},v3=${v3Result ?? "missing"},signers=${signerCount},digests=${signerDigests.join(",") || "missing"}`;
  if (v1Result !== String(v1) || v2Result !== String(v2) || v3Result !== String(v3) || signerCount !== 1 ||
      signerDigests.length !== 1 || signerDigests[0] !== expectedSigner) {
    throw new Error(`AIB_RELEASE_LINEAGE_APK_SIGNATURE_POLICY_INVALID:${actual}`);
  }
  return { signerSha256: signerDigests[0], v1: v1Result === "true", v2: v2Result === "true", v3: v3Result === "true" };
}

export function buildApksignerSignArgs({ input, output, lineage, legacyStore, currentStore }) {
  return [
    "sign",
    "--out", output,
    "--lineage", lineage,
    "--min-sdk-version", "24",
    "--rotation-min-sdk-version", "28",
    "--v1-signing-enabled", "true",
    "--v2-signing-enabled", "true",
    "--v3-signing-enabled", "true",
    "--v4-signing-enabled", "false",
    "--ks", legacyStore,
    "--ks-type", "JKS",
    "--ks-key-alias", "karat",
    "--ks-pass", "env:AIB_RELEASE_LEGACY_STORE_PASSWORD",
    "--key-pass", "env:AIB_RELEASE_LEGACY_KEY_PASSWORD",
    "--next-signer",
    "--ks", currentStore,
    "--ks-type", "JKS",
    "--ks-key-alias", "karat",
    "--ks-pass", "env:AIB_RELEASE_CURRENT_STORE_PASSWORD",
    "--key-pass", "env:AIB_RELEASE_CURRENT_KEY_PASSWORD",
    input,
  ];
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`AIB_RELEASE_SIGNING_ENV_MISSING:${name}`);
  return value;
}

function redact(text) {
  let output = String(text ?? "");
  for (const name of [
    "AIB_RELEASE_LEGACY_STORE_PASSWORD", "AIB_RELEASE_LEGACY_KEY_PASSWORD",
    "AIB_RELEASE_CURRENT_STORE_PASSWORD", "AIB_RELEASE_CURRENT_KEY_PASSWORD",
  ]) {
    const value = process.env[name];
    if (value) output = output.split(value).join("[redacted]");
  }
  return output.replace(/\s+/g, " ").trim().slice(0, 220);
}

function runTool(binary, args, label) {
  const result = spawnSync(binary, args, { encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const code = result.error ? "spawn" : `exit_${result.status ?? 1}`;
    const detail = redact(`${result.stderr ?? ""} ${result.stdout ?? ""}`);
    throw new Error(`AIB_RELEASE_LINEAGE_${label}_FAILED:${code}${detail ? `:${detail}` : ""}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function resolveApksigner() {
  if (process.env.AIB_APKSIGNER) return path.resolve(process.env.AIB_APKSIGNER);
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!sdk) throw new Error("AIB_APKSIGNER_PATH_REQUIRED");
  const buildTools = path.join(sdk, "build-tools");
  if (!fs.existsSync(buildTools)) throw new Error("AIB_APKSIGNER_PATH_REQUIRED");
  const versions = fs.readdirSync(buildTools).filter((name) => fs.existsSync(path.join(buildTools, name, "apksigner")));
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!versions.length) throw new Error("AIB_APKSIGNER_PATH_REQUIRED");
  return path.join(buildTools, versions[0], "apksigner");
}

function requireFile(value, code) {
  const resolved = path.resolve(value);
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw new Error(code); }
  if (!stat.isFile()) throw new Error(code);
  return resolved;
}

function verifyApk(apksigner, apkPath, minApi, maxApi, expectedSigner, v1, v2, v3, label) {
  const output = runTool(apksigner, [
    "verify", "--verbose", "--print-certs", "--min-sdk-version", String(minApi),
    "--max-sdk-version", String(maxApi), apkPath,
  ], `VERIFY_${label}`);
  return validateApkVerificationOutput(output, { expectedSigner, v1, v2, v3 });
}

export function validateJarsignerVerificationOutput(output) {
  const text = String(output);
  if (!/^jar verified\.$/im.test(text) || /jar is unsigned/i.test(text)) {
    throw new Error("AIB_RELEASE_LINEAGE_V1_JARSIGNER_INVALID");
  }
  return true;
}

function verifyV1WithJarsigner(apkPath) {
  const output = runTool("jarsigner", ["-verify", "-certs", apkPath], "V1_JARSIGNER");
  return validateJarsignerVerificationOutput(output);
}

function signRelease(inputArg, outputArg) {
  const input = requireFile(inputArg, "AIB_RELEASE_SIGNING_INPUT_APK_INVALID");
  const output = path.resolve(outputArg);
  if (input === output) throw new Error("AIB_RELEASE_SIGNING_OUTPUT_MUST_BE_DISTINCT");
  const legacyStore = requireFile(requiredEnv("AIB_RELEASE_LEGACY_STORE_FILE"), "AIB_RELEASE_LEGACY_KEYSTORE_INVALID");
  const currentBks = requireFile(requiredEnv("AIB_RELEASE_CURRENT_STORE_FILE"), "AIB_RELEASE_CURRENT_KEYSTORE_INVALID");
  const bcProviderJar = requireFile(requiredEnv("AIB_RELEASE_BCPROV_JAR"), "AIB_RELEASE_BCPROV_JAR_INVALID");
  const lineage = requireFile(process.env.AIB_RELEASE_LINEAGE_FILE || path.join(ROOT, "assets/signing/karat-old-to-new.lineage"), "AIB_RELEASE_LINEAGE_FILE_INVALID");
  const apksigner = resolveApksigner();
  requireFile(apksigner, "AIB_APKSIGNER_PATH_INVALID");

  requiredEnv("AIB_RELEASE_LEGACY_STORE_PASSWORD");
  requiredEnv("AIB_RELEASE_LEGACY_KEY_PASSWORD");
  requiredEnv("AIB_RELEASE_CURRENT_STORE_PASSWORD");
  requiredEnv("AIB_RELEASE_CURRENT_KEY_PASSWORD");

  const lineageDigest = crypto.createHash("sha256").update(fs.readFileSync(lineage)).digest("hex");
  if (lineageDigest !== LINEAGE_SHA256) throw new Error("AIB_RELEASE_LINEAGE_FILE_HASH_INVALID");
  const lineageOutput = runTool(apksigner, ["lineage", "--in", lineage, "--print-certs"], "LINEAGE");
  validateLineageOutput(lineageOutput);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-release-lineage-"));
  fs.chmodSync(tempDir, 0o700);
  const outputDir = path.dirname(output);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputTempDir = fs.mkdtempSync(path.join(outputDir, ".aib-lineage-"));
  fs.chmodSync(outputTempDir, 0o700);
  const currentJks = path.join(tempDir, "current-karat.jks");
  const signedApk = path.join(outputTempDir, "signed.apk");

  try {
    runTool("keytool", [
      "-importkeystore",
      "-srckeystore", currentBks,
      "-srcstoretype", "BKS",
      "-srcstorepass", requiredEnv("AIB_RELEASE_CURRENT_STORE_PASSWORD"),
      "-srckeypass", requiredEnv("AIB_RELEASE_CURRENT_KEY_PASSWORD"),
      "-srcalias", "karat",
      "-destkeystore", currentJks,
      "-deststoretype", "JKS",
      "-deststorepass", requiredEnv("AIB_RELEASE_CURRENT_STORE_PASSWORD"),
      "-destkeypass", requiredEnv("AIB_RELEASE_CURRENT_KEY_PASSWORD"),
      "-destalias", "karat",
      "-noprompt",
      "-providerclass", "org.bouncycastle.jce.provider.BouncyCastleProvider",
      "-providerpath", bcProviderJar,
    ], "KEYSTORE_CONVERSION");

    runTool(apksigner, buildApksignerSignArgs({ input, output: signedApk, lineage, legacyStore, currentStore: currentJks }), "SIGN");
    verifyApk(apksigner, signedApk, 18, 23, LEGACY_SIGNER_SHA256, true, false, false, "API18_23_V1");
    verifyApk(apksigner, signedApk, 24, 27, LEGACY_SIGNER_SHA256, false, true, false, "API24_27_V2");
    verifyApk(apksigner, signedApk, 28, 36, CURRENT_SIGNER_SHA256, false, false, true, "API28_36_V3");
    verifyV1WithJarsigner(signedApk);
    fs.chmodSync(signedApk, 0o644);
    fs.renameSync(signedApk, output);
    console.log(`AIB_RELEASE_LINEAGE_SIGNING_OK api18_23_v1=${LEGACY_SIGNER_SHA256} jarsigner=true api24_27_v2=${LEGACY_SIGNER_SHA256} api28_36_v3=${CURRENT_SIGNER_SHA256} lineage_sha256=${lineageDigest} output=${path.basename(output)}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputTempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("USAGE:aib-sign-android-release-lineage.mjs <gradle-apk> <final-apk>");
    signRelease(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "AIB_RELEASE_LINEAGE_SIGNING_FAILED");
    process.exitCode = 1;
  }
}
