#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const apkPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!apkPath || !fs.statSync(apkPath, { throwIfNoEntry: false })?.isFile()) {
  throw new Error("Usage: node scripts/aib-apk-integrity-tamper-selftest.mjs <signed-apk>");
}

function resolveApksigner() {
  if (process.env.APKSIGNER && fs.existsSync(process.env.APKSIGNER)) return process.env.APKSIGNER;
  const lookup = spawnSync("bash", ["-lc", "command -v apksigner"], { encoding: "utf8", maxBuffer: 64 * 1024 });
  if (lookup.status === 0 && lookup.stdout.trim()) return lookup.stdout.trim();
  for (const base of ["/home/ubuntu/android-sdk/build-tools", "/opt/android-sdk/build-tools", "/usr/lib/android-sdk/build-tools"]) {
    if (!fs.existsSync(base)) continue;
    const versions = fs.readdirSync(base).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(base, version, "apksigner");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("APKSIGNER_NOT_FOUND");
}

function verify(apksigner, candidate, minSdkVersion) {
  const args = ["verify", "--verbose", "--print-certs"];
  if (minSdkVersion !== undefined) args.push("--min-sdk-version", String(minSdkVersion));
  args.push(candidate);
  return spawnSync(apksigner, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
}

const apksigner = resolveApksigner();
const original = verify(apksigner, apkPath);
assert.equal(original.status, 0, `release APK signature did not verify for its declared minSdk: ${(original.stderr || original.stdout || "").slice(-1200)}`);
const originalText = `${original.stdout || ""}\n${original.stderr || ""}`;
assert.match(originalText, /Verified using v2 scheme \(APK Signature Scheme v2\):\s*true/i, "the declared minSdk must verify the V2 signature");
assert.match(originalText, /Verified using v3 scheme \(APK Signature Scheme v3\):\s*true/i, "the declared minSdk must verify the V3 signature");

// minSdk 24 uses V2/V3 by default, so apksigner reports V1=false in that mode
// even when the valid JAR signature is present. Force API 21 to verify all
// three signature schemes as available legacy/platform alternatives.
const allSchemes = verify(apksigner, apkPath, 21);
assert.equal(allSchemes.status, 0, `release APK did not verify against legacy API 21: ${(allSchemes.stderr || allSchemes.stdout || "").slice(-1200)}`);
const verificationText = `${allSchemes.stdout || ""}\n${allSchemes.stderr || ""}`;
for (const [scheme, expression] of [
  ["V1", /Verified using v1 scheme \(JAR signing\):\s*true/i],
  ["V2", /Verified using v2 scheme \(APK Signature Scheme v2\):\s*true/i],
  ["V3", /Verified using v3 scheme \(APK Signature Scheme v3\):\s*true/i],
]) {
  assert.match(verificationText, expression, `final APK must verify with ${scheme}`);
}

const jarsigner = process.env.JARSIGNER || "jarsigner";
const jarVerification = spawnSync(jarsigner, ["-verify", "-verbose", apkPath], {
  encoding: "utf8",
  maxBuffer: 2 * 1024 * 1024,
  env: process.env,
});
const jarVerificationText = `${jarVerification.stdout || ""}\n${jarVerification.stderr || ""}`;
assert.equal(jarVerification.status, 0, `V1 JAR signature did not verify: ${jarVerificationText.slice(-1200)}`);
assert.match(jarVerificationText, /jar verified\./i, "the APK's V1 JAR signature must be valid");

const certificate = verificationText.match(/Signer #1 certificate SHA-256 digest:\s*([a-f0-9:]+)/i);
assert.ok(certificate, "apksigner must report the final APK signing certificate fingerprint");
const actualFingerprint = certificate[1].replace(/:/g, "").toLowerCase();
const policySource = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../lib/release-integrity-policy.ts"), "utf8");
const expectedFingerprint = policySource.match(/EXPECTED_RELEASE_CERT_SHA256\s*=\s*"([a-f0-9]{64})"/i)?.[1]?.toLowerCase();
assert.ok(expectedFingerprint, "release source must carry a valid pinned certificate fingerprint");
assert.equal(actualFingerprint, expectedFingerprint, "final APK must preserve the approved release certificate identity");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-apk-tamper-"));
const tamperedPath = path.join(tempDir, "altered.apk");
try {
  fs.copyFileSync(apkPath, tamperedPath);
  const fd = fs.openSync(tamperedPath, "r+");
  try {
    const byte = Buffer.alloc(1);
    const position = Math.max(0, fs.fstatSync(fd).size - 1);
    assert.equal(fs.readSync(fd, byte, 0, 1, position), 1, "APK must contain at least one byte");
    byte[0] ^= 0x01;
    fs.writeSync(fd, byte, 0, 1, position);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const altered = verify(apksigner, tamperedPath);
  assert.notEqual(altered.status, 0, "apksigner accepted a byte-altered release APK");
  console.log("AIB_APK_TAMPER_SELFTEST_OK schemes=v1,v2,v3 certificate_pin_match=true altered_artifact_rejected=true");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
