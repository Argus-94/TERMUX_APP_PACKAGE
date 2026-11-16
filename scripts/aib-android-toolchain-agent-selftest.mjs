#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  ANDROID_TOOLCHAIN_PRESETS,
  runAndroidToolchainCoordinator,
} from '../core/enhancements/toolchain/AndroidToolchainCoordinator.ts';
import {
  createAndroidToolchainProductionAdapter,
  readAndroidProjectIdentity,
} from '../core/enhancements/toolchain/AndroidToolchainProductionAdapter.ts';

const root = '/workspace/demo';
const rawApk = `${root}/app/build/outputs/apk/debug/app-debug.apk`;
const signedApk = `${root}/app/build/outputs/apk/debug/app-debug-signed.apk`;
const identity = Object.freeze({
  applicationId: 'com.example.demo',
  appName: 'Demo',
  slug: 'demo',
  buildSettings: Object.freeze({ versionCode: '8', versionName: '1.2.0', minSdk: '23' }),
});
const successfulVerification = (artifactPath) => ({
  verified: true,
  artifactPath,
  regularFile: true,
  sha256: 'a'.repeat(64),
  applicationId: identity.applicationId,
  errors: [],
});

function adapter(overrides = {}, calls = []) {
  return {
    readIdentity: async () => identity,
    validateManifest: async (_context) => {
      calls.push('manifest');
      return { valid: true, errors: [], identity };
    },
    build: async (context) => {
      calls.push(`build:${context.preset.variant}`);
      return { ok: true, artifactPath: rawApk };
    },
    repair: async () => { calls.push('repair'); },
    verifyArtifact: async (_context, artifactPath) => {
      calls.push(`verify:${artifactPath}`);
      return successfulVerification(artifactPath);
    },
    sign: async (_context, verified) => {
      calls.push('sign');
      assert.equal(verified.artifactPath, rawApk);
      return { ok: true, artifactPath: signedApk };
    },
    install: async (_context, verified) => {
      calls.push('install');
      assert.equal(verified.artifactPath, signedApk);
      return { ok: true, installedApplicationId: identity.applicationId };
    },
    ...overrides,
  };
}

async function run(adapterImpl, changes = {}) {
  return runAndroidToolchainCoordinator(adapterImpl, {
    projectRoot: root,
    expectedIdentity: identity,
    variant: 'debug',
    maxRepairAttempts: 1,
    install: true,
    installPermission: true,
    installConsent: true,
    ...changes,
  });
}

// Success: validate -> build -> verify -> sign -> verify signed artifact -> install.
{
  const calls = [];
  const result = await run(adapter({}, calls));
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'complete');
  assert.equal(result.buildAttempts, 1);
  assert.equal(result.artifactPath, signedApk);
  assert.deepEqual(calls, [
    'manifest', `build:debug`, `verify:${rawApk}`, 'sign', `verify:${signedApk}`, 'install',
  ]);
}

// Missing required capability fails closed and later stages are not called.
{
  const calls = [];
  const impl = adapter({ verifyArtifact: undefined }, calls);
  const result = await run(impl);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ADAPTER_MISSING:verifyArtifact');
  assert.equal(calls.some((call) => call === 'sign' || call === 'install'), false);
}

// A failed earlier stage halts progression.
{
  const calls = [];
  const result = await run(adapter({
    validateManifest: async () => {
      calls.push('manifest');
      return { valid: false, errors: ['missing application id'], identity };
    },
  }, calls));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'manifest-validation');
  assert.equal(calls.includes('build:debug'), false);
  assert.equal(calls.includes('install'), false);
}

// Build repair is bounded: two repairs permit exactly three build attempts.
{
  let builds = 0;
  let repairs = 0;
  const result = await run(adapter({
    build: async () => { builds += 1; return { ok: false, failureCode: 'compile-failed' }; },
    repair: async (_context, info) => {
      repairs += 1;
      assert.equal(info.attempt, repairs);
      assert.equal(info.maxAttempts, 2);
    },
  }), { maxRepairAttempts: 2, install: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BUILD_FAILED_REPAIR_LIMIT_REACHED');
  assert.equal(builds, 3);
  assert.equal(repairs, 2);
  assert.equal(result.repairAttempts, 2);
}

// Production explicitly disables unsafe automatic repair when no verified host repair pipeline exists.
{
  const result = await run(adapter({ build: async () => ({ ok: false, failureCode: 'offline-cache-miss' }) }), {
    maxRepairAttempts: 0,
    install: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'AUTOMATIC_REPAIR_UNAVAILABLE_SAFE_HOST');
  assert.match(result.detail, /isolated worktree\/temp-patch staging/);
  assert.match(result.detail, /atomic compare-and-swap apply\/revert/);
  assert.equal(result.repairAttempts, 0);
  assert.equal(result.buildAttempts, 1);
}

// Model offline dependency cache, SDK/license permission and Gradle task failures without treating diagnostics as success.
for (const failureCode of ['GRADLE_DISTRIBUTION_NOT_CACHED_OFFLINE', 'AIB_SDK_LICENSES_NOT_ACCEPTED', 'GRADLE_TASK_FAILED']) {
  let signed = false;
  const failedBuild = await run(adapter({
    build: async () => ({ ok: false, failureCode }),
    sign: async () => { signed = true; return { ok: true, artifactPath: signedApk }; },
  }), { maxRepairAttempts: 0, install: false });
  assert.equal(failedBuild.ok, false);
  assert.equal(failedBuild.error, 'AUTOMATIC_REPAIR_UNAVAILABLE_SAFE_HOST');
  assert.equal(failedBuild.events.find((event) => event.stage === 'build' && !event.ok)?.detail, failureCode);
  assert.equal(signed, false);
}

// A reported successful Gradle task without an artifact is not enough to sign.
{
  const result = await run(adapter({ build: async () => ({ ok: true }) }), { install: false });
  assert.equal(result.error, 'BUILD_ARTIFACT_PATH_MISSING');
}

// A missing or broken repair callback fails closed; a no-op repair is never reported as a successful build.
{
  const missing = await run(adapter({ build: async () => ({ ok: false, failureCode: 'compile-failed' }), repair: undefined }), { install: false });
  assert.equal(missing.error, 'ADAPTER_MISSING:repair');
  let builds = 0;
  const noDiff = await run(adapter({ build: async () => { builds += 1; return { ok: false, failureCode: 'same-error' }; }, repair: async () => {} }), { install: false });
  assert.equal(noDiff.ok, false);
  assert.equal(noDiff.error, 'BUILD_FAILED_REPAIR_LIMIT_REACHED');
  assert.equal(builds, 2, 'no-op repair is followed by a bounded rebuild and cannot become a false success');
  const broken = await run(adapter({ build: async () => ({ ok: false, failureCode: 'compile-failed' }), repair: async () => { throw new Error('repair regression'); } }), { install: false });
  assert.equal(broken.error, 'REPAIR_ADAPTER_ERROR');
  assert.equal(broken.buildAttempts, 1);
}

// Non-finite caller values cannot disable the coordinator's retry ceiling.
{
  let builds = 0;
  let repairs = 0;
  const result = await run(adapter({
    build: async () => { builds += 1; return { ok: false, failureCode: 'still-failing' }; },
    repair: async () => { repairs += 1; },
  }), { maxRepairAttempts: Number.NaN, install: false });
  assert.equal(result.ok, false);
  assert.equal(builds, 2);
  assert.equal(repairs, 1);
}

// Build output outside the injected project root is rejected before verification.
{
  let verified = false;
  const result = await run(adapter({
    build: async () => ({ ok: true, artifactPath: '/workspace/other/evil.apk' }),
    verifyArtifact: async (_context, path) => {
      verified = true;
      return successfulVerification(path);
    },
  }), { install: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BUILD_ARTIFACT_OUTSIDE_PROJECT');
  assert.equal(verified, false);
}

// A verifier cannot bless an out-of-root or mismatched artifact path.
{
  const result = await run(adapter({
    verifyArtifact: async () => successfulVerification('/workspace/elsewhere/malicious.apk'),
  }), { install: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ARTIFACT_VERIFICATION_FAILED');
}

// Installation is blocked absent both explicit permission and user consent.
{
  let installed = false;
  const result = await run(adapter({
    install: async () => { installed = true; return { ok: true, installedApplicationId: identity.applicationId }; },
  }), { installPermission: true, installConsent: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INSTALL_REQUIRES_EXPLICIT_PERMISSION_AND_CONSENT');
  assert.equal(installed, false);
}

// Corrupt artifacts and signing failures cannot reach install.
{
  let signed = false;
  const corrupt = await run(adapter({
    verifyArtifact: async (_context, artifactPath) => ({ ...successfulVerification(artifactPath), verified: false, errors: ['bad APK'] }),
    sign: async () => { signed = true; return { ok: true, artifactPath: signedApk }; },
  }));
  assert.equal(corrupt.error, 'ARTIFACT_VERIFICATION_FAILED');
  assert.equal(signed, false);
  let installed = false;
  const signingFailed = await run(adapter({
    sign: async () => ({ ok: false, failureCode: 'APK_V1_V2_V3_SIGNING_FAILED' }),
    install: async () => { installed = true; return { ok: true, installedApplicationId: identity.applicationId }; },
  }));
  assert.equal(signingFailed.error, 'APK_V1_V2_V3_SIGNING_FAILED');
  assert.equal(installed, false);
}

// Unauthorized ADB and cancellation fail closed before installation starts.
{
  const unauthorized = await run(adapter({
    install: async () => ({ ok: false, failureCode: 'DEVICE_ADB_UNAUTHORIZED' }),
  }));
  assert.equal(unauthorized.error, 'DEVICE_ADB_UNAUTHORIZED');
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  let started = false;
  const preCancelled = await run(adapter({ build: async () => { started = true; return { ok: true, artifactPath: rawApk }; } }), { signal: alreadyCancelled.signal });
  assert.equal(preCancelled.error, 'ABORTED');
  assert.equal(started, false);

  const duringBuild = new AbortController();
  let signedDuringBuildCancel = false;
  const buildCancelled = await run(adapter({
    build: async () => { duringBuild.abort(); return { ok: true, artifactPath: rawApk }; },
    sign: async () => { signedDuringBuildCancel = true; return { ok: true, artifactPath: signedApk }; },
  }), { signal: duringBuild.signal, install: false });
  assert.equal(buildCancelled.error, 'ABORTED');
  assert.equal(signedDuringBuildCancel, false);

  const beforeInstall = new AbortController();
  let installed = false;
  const cancelled = await run(adapter({
    sign: async () => { beforeInstall.abort(); return { ok: true, artifactPath: signedApk }; },
    install: async () => { installed = true; return { ok: true, installedApplicationId: identity.applicationId }; },
  }), { signal: beforeInstall.signal });
  assert.equal(cancelled.error, 'ABORTED');
  assert.equal(installed, false, 'cancellation during signing stops before device install');

  const duringInstall = new AbortController();
  const installResult = await run(adapter({
    install: async () => { duringInstall.abort(); return { ok: true, installedApplicationId: identity.applicationId }; },
  }), { signal: duringInstall.signal });
  assert.equal(installResult.error, 'ABORTED_INSTALL_OUTCOME_UNKNOWN', 'cancellation during non-abortable install is reported as an unknown outcome');
}

// Android preset invariants: task/variant coupling, manifest identity requirements,
// immutable preset records, and no preset-supplied app identity/build settings.
{
  assert.equal(ANDROID_TOOLCHAIN_PRESETS.debug.platform, 'android');
  assert.equal(ANDROID_TOOLCHAIN_PRESETS.debug.gradleTask, 'assembleDebug');
  assert.equal(ANDROID_TOOLCHAIN_PRESETS.release.gradleTask, 'assembleRelease');
  assert.deepEqual(ANDROID_TOOLCHAIN_PRESETS.debug.requiredManifestIdentity, ['applicationId', 'appName', 'slug']);
  assert.equal(Object.isFrozen(ANDROID_TOOLCHAIN_PRESETS), true);
  assert.equal(Object.isFrozen(ANDROID_TOOLCHAIN_PRESETS.debug), true);
  assert.equal(Object.isFrozen(ANDROID_TOOLCHAIN_PRESETS.debug.requiredManifestIdentity), true);
  assert.equal('applicationId' in ANDROID_TOOLCHAIN_PRESETS.debug, false);
  assert.equal('buildSettings' in ANDROID_TOOLCHAIN_PRESETS.debug, false);
  assert.deepEqual(identity.buildSettings, { versionCode: '8', versionName: '1.2.0', minSdk: '23' });
}

// The production adapter reads literal/JSON configuration without evaluating app code,
// locks exact identity inputs, and drives only the host-owned stage methods.
{
  const productionRoot = '/workspace/production-demo';
  const productionRaw = `${productionRoot}/app/build/outputs/apk/debug/app-debug.apk`;
  const productionSigned = `${productionRoot}/app/build/outputs/apk/debug/app-debug-signed.apk`;
  const files = new Map([
    [`${productionRoot}/AI_BUILDER_ANDROID_IDENTITY.json`, JSON.stringify({ applicationId: 'com.example.demo', namespace: 'com.example.demo' })],
    [`${productionRoot}/app.json`, JSON.stringify({ expo: { name: 'Demo', slug: 'demo', version: '1.2.0', android: { package: 'com.example.demo' } } })],
    [`${productionRoot}/package.json`, JSON.stringify({ name: 'demo', version: '1.2.0' })],
    [`${productionRoot}/app/build.gradle`, 'android { namespace "com.example.demo"; defaultConfig { applicationId "com.example.demo"; versionCode 8; versionName "1.2.0" } }'],
  ]);
  const calls = [];
  const v123 = [];
  const host = {
    resolvePath: async (path) => path,
    exists: async (path) => path === `${productionRoot}/gradlew` || files.has(path),
    readText: async (path) => { if (!files.has(path)) throw new Error('missing'); return files.get(path); },
    build: async (context) => { calls.push(`build:${context.preset.gradleTask}`); return { ok: true, artifactPath: productionRaw }; },
    sign: async (_context, artifact) => { calls.push(`sign:${artifact.artifactPath}`); return { ok: true, artifactPath: productionSigned }; },
    verify: async (context, artifactPath, requireV123) => {
      calls.push(`verify:${artifactPath}`); v123.push(requireV123);
      return { verified: true, artifactPath, regularFile: true, sha256: 'b'.repeat(64), applicationId: context.expectedIdentity.applicationId, errors: [] };
    },
    install: async (_context, artifact) => { calls.push(`install:${artifact.artifactPath}`); return { ok: true, installedApplicationId: 'com.example.demo' }; },
  };
  const expected = await readAndroidProjectIdentity(productionRoot, host);
  assert.equal(expected.applicationId, 'com.example.demo');
  assert.equal(expected.appName, 'Demo');
  assert.equal(expected.slug, 'demo');
  assert.equal(expected.buildSettings['app.version'], '1.2.0');
  assert.equal(expected.buildSettings['source.package.json'], files.get(`${productionRoot}/package.json`));
  const prodAdapter = createAndroidToolchainProductionAdapter(host);
  const result = await runAndroidToolchainCoordinator(prodAdapter, {
    projectRoot: productionRoot,
    expectedIdentity: expected,
    variant: 'debug',
    maxRepairAttempts: 0,
    install: true,
    installPermission: true,
    installConsent: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.artifactPath, productionSigned);
  assert.deepEqual(calls, [
    'build:assembleDebug', `verify:${productionRaw}`, `sign:${productionRaw}`,
    `verify:${productionSigned}`, `install:${productionSigned}`,
  ]);
  assert.deepEqual(v123, [false, true]);
  assert.equal(Object.keys(host).some((key) => /shell|network|key|secret/i.test(key)), false);
}

// A build-time mutation of a protected package manifest is detected before signing/install.
{
  const productionRoot = '/workspace/mutable-demo';
  const raw = `${productionRoot}/app/build/outputs/apk/debug/app-debug.apk`;
  const files = new Map([
    [`${productionRoot}/AI_BUILDER_ANDROID_IDENTITY.json`, JSON.stringify({ applicationId: 'com.example.demo' })],
    [`${productionRoot}/app.json`, JSON.stringify({ expo: { name: 'Demo', slug: 'demo', version: '1.2.0', android: { package: 'com.example.demo' } } })],
    [`${productionRoot}/package.json`, JSON.stringify({ version: '1.2.0' })],
    [`${productionRoot}/app/build.gradle`, 'android { defaultConfig { applicationId "com.example.demo" } }'],
  ]);
  let signed = false;
  const host = {
    resolvePath: async (path) => path,
    exists: async (path) => path === `${productionRoot}/gradlew` || files.has(path),
    readText: async (path) => { if (!files.has(path)) throw new Error('missing'); return files.get(path); },
    build: async () => { files.set(`${productionRoot}/package.json`, JSON.stringify({ version: '2.0.0' })); return { ok: true, artifactPath: raw }; },
    sign: async () => { signed = true; return { ok: true, artifactPath: `${productionRoot}/app/build/outputs/apk/debug/app-debug-signed.apk` }; },
    verify: async (_context, artifactPath) => ({ verified: true, artifactPath, regularFile: true, sha256: 'c'.repeat(64), applicationId: 'com.example.demo', errors: [] }),
    install: async () => ({ ok: true, installedApplicationId: 'com.example.demo' }),
  };
  const expected = await readAndroidProjectIdentity(productionRoot, host);
  const result = await runAndroidToolchainCoordinator(createAndroidToolchainProductionAdapter(host), {
    projectRoot: productionRoot, expectedIdentity: expected, variant: 'debug', maxRepairAttempts: 0, install: true, installPermission: true, installConsent: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'PROJECT_IDENTITY_CHANGED');
  assert.equal(signed, false);
}

console.log('AIB_ANDROID_TOOLCHAIN_AGENT_SELFTEST_OK');
