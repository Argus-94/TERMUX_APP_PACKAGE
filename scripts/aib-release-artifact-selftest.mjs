/**
 * Release artifact contract checks that do not require node_modules, Expo, or adb.
 * These checks intentionally validate the source tree only; they never claim an
 * Android build/install succeeded.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const errors = [];
const pkg = JSON.parse(read('package.json'));
const app = read('app.config.ts');
const eas = JSON.parse(read('eas.json'));
const lock = read('pnpm-lock.yaml');
const termuxAgent = read('lib/termux-agent.ts');
const deterministicAgent = read('lib/agent-engine.ts');
const apkValidation = read('lib/apk-validation.ts');
const artifactGate = read('lib/build-artifact-gate.ts');

if (pkg.packageManager !== 'pnpm@9.15.0') {
  errors.push(`PACKAGE_MANAGER_MISMATCH expected=pnpm@9.15.0 actual=${pkg.packageManager || 'missing'}`);
}
if (!fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) errors.push('PNPM_LOCKFILE_MISSING');
if (fs.existsSync(path.join(root, 'package-lock.json'))) errors.push('NPM_LOCKFILE_FORBIDDEN');
if (!/^lockfileVersion:\s*'9\.0'$/m.test(lock) && !/^lockfileVersion:\s*9\.0$/m.test(lock)) {
  errors.push('PNPM_LOCKFILE_VERSION_UNEXPECTED');
}
if (!/version:\s*APP_VERSION\b/.test(app)) errors.push('APP_VERSION_NOT_DERIVED_FROM_PACKAGE');
if (!/android:\s*\{[\s\S]*?package:\s*["']com\.karat\.aibuilder["']/.test(app)) {
  errors.push('ANDROID_PACKAGE_ID_MISSING');
}
if (eas?.build?.preview?.android?.buildType !== 'apk') errors.push('PREVIEW_APK_PROFILE_MISSING');
if (eas?.build?.production?.android?.buildType !== 'app-bundle') errors.push('PRODUCTION_AAB_PROFILE_MISSING');
if (!fs.existsSync(path.join(root, 'gradlew'))) errors.push('GRADLEW_SHIM_MISSING');
if (!fs.existsSync(path.join(root, 'scripts/aib-android-e2e.mjs'))) errors.push('ANDROID_E2E_HARNESS_MISSING');
if (!termuxAgent.includes('evaluateBuildArtifactGate')) errors.push('PRODUCTION_ARTIFACT_GATE_NOT_CONNECTED');
if (!termuxAgent.includes('BUILD_STARTED_EPOCH=') || !termuxAgent.includes('ARTIFACT_BUILD_START_MARKER_MISSING')) errors.push('BUILD_PROVENANCE_MARKER_MISSING');
if (!termuxAgent.includes('clean ${String(assembleTask')) errors.push('PROJECT_GRADLE_CLEAN_BEFORE_BUILD_MISSING');
if (!deterministicAgent.includes('bash gradlew clean assembleDebug')) errors.push('NEW_PROJECT_GRADLE_CLEAN_BEFORE_BUILD_MISSING');
if (!apkValidation.includes('AIB_APK_IDENTITY_OK') || !apkValidation.includes('AIB_APK_CERT_SHA256=')) errors.push('APK_IDENTITY_OR_CERTIFICATE_GATE_MISSING');
if (!artifactGate.includes('APK_SIGNATURE_MARKER_MISSING_OR_MISMATCHED') || !artifactGate.includes('ON_DISK_ARTIFACT_VALIDATION_FAILED')) errors.push('FAIL_CLOSED_ARTIFACT_GATE_INCOMPLETE');

const gradleSources = [read('lib/termux-agent.ts'), read('lib/build-loop.ts')];
if (!gradleSources.some(src => src.includes('PROJECT_GRADLE_SETTINGS_PRESERVED=1') || src.includes('project_gradle_wrapper_properties=read-only'))) errors.push('PROJECT_GRADLE_SETTINGS_READONLY_GUARD_MISSING');
for (const src of gradleSources) {
  if (/gradle-8\.10\.2-bin\.zip/.test(src) || /distributionSha256Sum=31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26/.test(src)) { errors.push('PROJECT_GRADLE_VERSION_PIN_PRESENT'); }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`AIB_RELEASE_ARTIFACT_SELFTEST_OK version=${pkg.version} package=com.karat.aibuilder`);
