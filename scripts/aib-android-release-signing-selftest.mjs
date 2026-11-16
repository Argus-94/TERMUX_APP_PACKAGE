#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { transformBuildGradle } = require("../plugins/withAndroidReleaseSigning.js");
const fixture = `android {
    signingConfigs {
        debug { }
    }
    defaultConfig {
        applicationId "com.karat.aibuilder"
        versionCode 512
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;
const debugBlock = `debug {
            signingConfig signingConfigs.debug
        }`;

const output = transformBuildGradle(fixture);
assert.match(output, /AIB_RELEASE_SIGNING_ENV_V1/);
assert.match(output, /AIB_RELEASE_R8_HARDENING_V1/);
assert.match(output, /signingConfig signingConfigs\.release/);
assert.match(output, /enableV1Signing true/);
assert.match(output, /enableV2Signing true/);
assert.match(output, /enableV3Signing true/);
assert.match(output, /AIB_RELEASE_ABI_ARM64_ONLY_V1/);
assert.match(output, /abiFilters "arm64-v8a"/);
assert.equal((output.match(/^[\t ]*abiFilters\b/gm) || []).length, 1);
assert.match(output, /System\.getenv\("AIB_RELEASE_STORE_FILE"\)/);
assert.match(output, /System\.getenv\("AIB_RELEASE_STORE_PASSWORD"\)/);
assert.match(output, /System\.getenv\("AIB_RELEASE_KEY_ALIAS"\)/);
assert.match(output, /System\.getenv\("AIB_RELEASE_KEY_PASSWORD"\)/);
assert.match(output, /AIB_RELEASE_SIGNING_CREDENTIALS_REQUIRED/);
assert.match(output, /AIB_RELEASE_SIGNING_KEYSTORE_UNAVAILABLE/);
assert.match(output, /minifyEnabled true/);
assert.match(output, /shrinkResources true/);
assert.match(output, /getDefaultProguardFile\("proguard-android-optimize\.txt"\)/);
assert.match(output, /"proguard-rules\.pro"/);
assert.ok(output.includes(debugBlock), "the debug buildType must remain byte-for-byte unchanged");
assert.equal((output.match(/AIB_RELEASE_SIGNING_ENV_V1/g) || []).length, 1);
assert.equal((output.match(/AIB_RELEASE_R8_HARDENING_V1/g) || []).length, 1);
assert.equal(transformBuildGradle(output), output, "transformation must be idempotent");
assert.doesNotMatch(output, /storePassword\s*["'][^"']+["']|keyPassword\s*["'][^"']+["']|storepass=[^\s]+|keypass=[^\s]+|\{\{secret:/i);
const staleScheme = transformBuildGradle(output.replace("enableV3Signing true", "enableV3Signing false"));
assert.match(staleScheme, /enableV3Signing true/, "older marked Gradle files must be upgraded to V1/V2/V3 signing");
assert.equal(transformBuildGradle(staleScheme), staleScheme, "scheme repair must remain idempotent");
assert.throws(
  () => transformBuildGradle(output.replace("enableV2Signing true", "enableV2Signing true\n            enableV2Signing false")),
  /AIB_RELEASE_R8_DUPLICATE_ENABLEV2SIGNING/
);

const existingFlags = fixture.replace(
  "minifyEnabled false",
  'minifyEnabled enableProguardInReleaseBuilds\n            shrinkResources false\n            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"'
);
const existingOutput = transformBuildGradle(existingFlags);
assert.match(existingOutput, /minifyEnabled true/);
assert.match(existingOutput, /shrinkResources true/);
assert.match(existingOutput, /proguard-android-optimize\.txt/);
assert.doesNotMatch(existingOutput, /proguard-android\.txt/);

const multiAbiFixture = fixture.replace(
  'versionCode 512',
  'ndk {\n            abiFilters "armeabi-v7a", "arm64-v8a", "x86_64"\n        }'
);
const arm64Only = transformBuildGradle(multiAbiFixture);
assert.match(arm64Only, /abiFilters "arm64-v8a"/);
assert.doesNotMatch(arm64Only, /abiFilters[^\n]*(?:armeabi-v7a|x86_64)/);
assert.equal((arm64Only.match(/^[\t ]*abiFilters\b/gm) || []).length, 1);
assert.equal(transformBuildGradle(arm64Only), arm64Only, "ABI normalization must be idempotent");

assert.throws(
  () => transformBuildGradle("android { buildTypes { debug {} } }") ,
  /AIB_RELEASE_SIGNING_RELEASE_BUILD_TYPE_MISSING|AIB_RELEASE_SIGNING_CONFIGS_MISSING/
);
assert.throws(
  () => transformBuildGradle(fixture.replace("buildTypes {", "otherTypes {")),
  /AIB_RELEASE_SIGNING_BUILD_TYPES_MISSING/
);
const unknown = fixture.replace(
  "signingConfig signingConfigs.debug\n            minifyEnabled",
  "signingConfig signingConfigs.custom\n            minifyEnabled"
);
assert.throws(() => transformBuildGradle(unknown), /AIB_RELEASE_SIGNING_CONFIG_UNEXPECTED/);
const duplicate = fixture.replace("minifyEnabled false", "minifyEnabled false\n            minifyEnabled true");
assert.throws(() => transformBuildGradle(duplicate), /AIB_RELEASE_R8_DUPLICATE_MINIFYENABLED/);
const corruptedMarker = output.replace("shrinkResources true", "shrinkResources false");
assert.throws(() => transformBuildGradle(corruptedMarker), /AIB_RELEASE_R8_HARDENING_MARKER_CONTENT_INVALID/);
const integrityPolicy = spawnSync(process.execPath, [new URL("./aib-app-integrity-policy-selftest.mjs", import.meta.url).pathname], {
  encoding: "utf8",
  maxBuffer: 2 * 1024 * 1024,
});
if (integrityPolicy.stdout) process.stdout.write(integrityPolicy.stdout);
if (integrityPolicy.stderr) process.stderr.write(integrityPolicy.stderr);
assert.equal(integrityPolicy.status, 0, "production release signing audit must include the app-integrity policy suite");
console.log("AIB_ANDROID_RELEASE_HARDENING_SELFTEST_OK env_only=true release_r8=true resource_shrinking=true schemes=v1,v2,v3 arm64_only=true debug_unchanged=true idempotent=true fail_closed=true integrity_policy=true source_secrets=absent");
