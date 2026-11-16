#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";

const archive = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.existsSync(archive)) {
  throw new Error("Usage: node scripts/aib-accessibility-source-archive-selftest.mjs <clean-source.zip>");
}
execFileSync("unzip", ["-tq", archive], { stdio: "pipe" });
const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
if (entries.some((name) => name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes(".."))) {
  throw new Error("SOURCE_ARCHIVE_UNSAFE_MEMBER");
}
const zipInfo = execFileSync("zipinfo", ["-l", archive], { encoding: "utf8" });
if (/^l[-rwx]{9}\s/m.test(zipInfo)) throw new Error("SOURCE_ARCHIVE_SYMLINK_FORBIDDEN");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aib-accessibility-source-archive-"));
try {
  execFileSync("unzip", ["-q", archive, "-d", tempRoot], { stdio: "pipe" });
  const roots = [tempRoot, ...fs.readdirSync(tempRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(tempRoot, entry.name))];
  const projectRoot = roots.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
  assert.ok(projectRoot, "clean ZIP must contain package.json at its project root");

  const nativeManifest = createRequire(import.meta.url)(path.join(projectRoot, "plugins", "native-source-manifest.cjs"));
  assert.deepEqual(nativeManifest.nativeSourceChecksumErrors(projectRoot), [], "all canonical Android assets must match their pinned SHA-256 manifests");
  const tamperProbe = path.join(projectRoot, "plugins", "android", "AibAccessibilityService.kt");
  const originalProbe = fs.readFileSync(tamperProbe);
  try {
    fs.appendFileSync(tamperProbe, "\n// isolated synthetic tamper probe\n");
    assert.ok(nativeManifest.nativeSourceChecksumErrors(projectRoot).some((error) => error.includes("SHA-256 mismatch")), "preflight checksum guard must detect modified canonical assets");
  } finally {
    fs.writeFileSync(tamperProbe, originalProbe);
  }

  const expectedAssetHashes = new Map([
    ["AibAccessibilityService.kt", "9d8450c2a74f84a4e5a08aabdd8d81aea30b193c634e2272f307c40ede7581a1"],
    ["AibAccessibilityModule.kt", "4c48ab667de407cbfb1f1ec0e18c12f67424b1db306fde38e81fa6d1109c15e6"],
    ["AibAccessibilityPackage.kt", "e3bcf77cf437a142c8064883b9c17a0f3df422125042ba1e497f2e55cbb36e58"],
    ["aib_accessibility_service.xml", "cb346c13d312193993026fcf52b2afc71554cdcda0b3a975451c898d3133a091"],
    ["AibLoopbackServer.kt", "a6549c82b46e8c02b396ba12cbed8f071b28d9233b12394fbaea765a0ae21ff9"],
  ]);
  const assetRoot = path.join(projectRoot, "plugins", "android");
  const checksumManifest = fs.readFileSync(path.join(assetRoot, "SHA256SUMS"), "utf8");
  const parsedHashes = new Map(checksumManifest.trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    assert.ok(match, `invalid canonical asset hash line: ${line}`);
    return [match[2], match[1]];
  }));
  assert.deepEqual([...parsedHashes].sort(), [...expectedAssetHashes].sort(), "asset hash manifest must match the cross-archive-verified canonical hashes");
  for (const [file, expectedHash] of expectedAssetHashes) {
    const source = path.join(assetRoot, file);
    assert.ok(fs.existsSync(source) && fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink(), `canonical asset must be a regular packaged file: ${file}`);
    const actualHash = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    assert.equal(actualHash, expectedHash, `canonical asset hash mismatch: ${file}`);
  }
  const additionalAssetHashes = new Map([
    ["AibMemoryPressureModule.kt", "a0aa164f9ceb07dd22f42d3d94b44f7691058958668c550385a0b5ddf026483e"],
    ["AibMemoryPressurePackage.kt", "f6735439c4a925e6412463ecd7dc3c2c01b058b6327850de5f720326b43838e9"],
  ]);
  const additionalManifest = fs.readFileSync(path.join(assetRoot, "ADDITIONAL-SHA256SUMS"), "utf8");
  const parsedAdditional = new Map(additionalManifest.trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    assert.ok(match, `invalid additional Android asset hash line: ${line}`);
    return [match[2], match[1]];
  }));
  assert.deepEqual([...parsedAdditional].sort(), [...additionalAssetHashes].sort(), "additional native memory module hashes must be pinned independently");
  for (const [file, expectedHash] of additionalAssetHashes) {
    const source = path.join(assetRoot, file);
    assert.ok(fs.existsSync(source) && fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink(), `additional native source must be a regular packaged file: ${file}`);
    assert.equal(createHash("sha256").update(fs.readFileSync(source)).digest("hex"), expectedHash, `additional native source hash mismatch: ${file}`);
  }
  const memoryModuleSource = fs.readFileSync(path.join(assetRoot, "AibMemoryPressureModule.kt"), "utf8");
  for (const token of ["ComponentCallbacks2", "TRIM_MEMORY_RUNNING_LOW", "getAvailableMemoryBytes", "getDevicePowerState", "EXTRA_LEVEL", "EXTRA_PLUGGED", "isPowerSaveMode", "AibMemoryPressure", "unregisterComponentCallbacks"]) {
    assert.ok(memoryModuleSource.includes(token), `native memory-pressure module missing ${token}`);
  }

  const preflightPath = path.join(projectRoot, "scripts", "aib-native-source-preflight.mjs");
  const preflight = spawnSync(process.execPath, [preflightPath], {
    cwd: projectRoot,
    env: { ...process.env, EAS_BUILD_PLATFORM: "android" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const preflightOutput = `${preflight.stdout || ""}${preflight.stderr || ""}`;
  if (preflight.status !== 0 && preflightOutput.includes("AIB_NATIVE_SOURCE_MISSING:")) {
    throw new Error(`SOURCE_ARCHIVE_BLOCKED_NO_PLUGIN_ENOENT: ${preflightOutput.trim()}`);
  }
  assert.equal(preflight.status, 0,
    `archive native-source preflight failed unexpectedly before prebuild: ${preflightOutput}`);

  const pluginPath = path.join(projectRoot, "plugins", "withAibAccessibility.js");
  assert.ok(fs.existsSync(pluginPath), "Accessibility config plugin must be packaged");
const configPluginStub = {
    withDangerousMod(config, [platform, action]) { (config.__mods ??= {})[platform] = action; return config; },
    withAndroidManifest(config, action) { (config.__mods ??= {}).manifest = action; return config; },
    withMainApplication(config, action) { (config.__mods ??= {}).mainApplication = action; return config; },
  };
  const baseRequire = createRequire(pluginPath);
  const pluginModule = new (await import("node:module")).default(pluginPath);
  pluginModule.filename = pluginPath;
  pluginModule.paths = (await import("node:module")).default._nodeModulePaths(path.dirname(pluginPath));
  pluginModule.require = (name) => name === "@expo/config-plugins" ? configPluginStub : baseRequire(name);
  pluginModule._compile(fs.readFileSync(pluginPath, "utf8"), pluginPath);
  const withAibAccessibility = pluginModule.exports;

  const generatedAndroid = path.join(tempRoot, "generated-android");
  const config = withAibAccessibility({
    android: { package: "com.karat.aibuilder" },
    modRequest: { projectRoot, platformProjectRoot: generatedAndroid },
  });
  assert.equal(typeof config.__mods?.android, "function", "Android dangerous mod must be registered");
  await config.__mods.android(config);
  const javaRoot = path.join(generatedAndroid, "app", "src", "main", "java", "com", "karat", "aibuilder");
  for (const file of ["AibAccessibilityService.kt", "AibAccessibilityModule.kt", "AibAccessibilityPackage.kt", "AibLoopbackServer.kt", "AibMemoryPressureModule.kt", "AibMemoryPressurePackage.kt"]) {
    const generated = path.join(javaRoot, file);
    assert.ok(fs.existsSync(generated) && fs.statSync(generated).isFile(), `prebuild must copy ${file}`);
    let canonical = fs.readFileSync(path.join(projectRoot, "plugins", "android", file), "utf8").replaceAll("__PACKAGE__", "com.karat.aibuilder");
    if (file === "AibLoopbackServer.kt") {
      canonical = canonical
        .replace('"GET /v1/status", "GET /v1/screen/tree", "GET /v1/adb/list", "GET /v1/virtualdisplay/capture",', '"GET /v1/status", "GET /v1/screen/tree", "GET /v1/adb/list", "GET /v1/adb/reconnect", "GET /v1/virtualdisplay/status", "GET /v1/virtualdisplay/displays", "GET /v1/virtualdisplay/capture",')
        .replace('"POST /v1/adb/pair", "POST /v1/adb/connect", "POST /v1/files/read", "POST /v1/sensors/read"', '"POST /v1/adb/pair", "POST /v1/adb/connect", "POST /v1/files/read", "POST /v1/sensors/read", "POST /v1/virtualdisplay/tree", "POST /v1/virtualdisplay/capture", "POST /v1/virtualdisplay/input"');
    }
    assert.equal(fs.readFileSync(generated, "utf8"), canonical, `${file} must be deterministically generated from its canonical source`);
    if (file === "AibLoopbackServer.kt") {
      for (const route of ["GET /v1/adb/reconnect", "GET /v1/virtualdisplay/status", "GET /v1/virtualdisplay/displays", "POST /v1/virtualdisplay/tree", "POST /v1/virtualdisplay/capture", "POST /v1/virtualdisplay/input"]) assert.ok(canonical.includes(route), `generated native allowlist must contain ${route}`);
    }
  }
  const generatedXml = path.join(generatedAndroid, "app", "src", "main", "res", "xml", "aib_accessibility_service.xml");
  assert.ok(fs.existsSync(generatedXml) && fs.statSync(generatedXml).isFile(), "prebuild must copy aib_accessibility_service.xml");
  assert.equal(fs.readFileSync(generatedXml, "utf8"), fs.readFileSync(path.join(projectRoot, "plugins", "android", "aib_accessibility_service.xml"), "utf8"));
  const ktApplication = config.__mods.mainApplication({ modResults: { language: "kt", contents: "class MainApplication {\n val packages = PackageList(this).packages.apply {\n }\n}" } });
  for (const packageName of ["AibAccessibilityPackage", "AibMemoryPressurePackage"]) assert.ok(ktApplication.modResults.contents.includes(`add(${packageName}())`), `Kotlin MainApplication must register ${packageName}`);
  const javaApplication = config.__mods.mainApplication({ modResults: { language: "java", contents: "List<ReactPackage> packages = new PackageList(this).getPackages();" } });
  for (const packageName of ["AibAccessibilityPackage", "AibMemoryPressurePackage"]) assert.ok(javaApplication.modResults.contents.includes(`new ${packageName}()`), `Java MainApplication must register ${packageName}`);
  console.log("AIB_ACCESSIBILITY_SOURCE_ARCHIVE_SELFTEST_OK cleanZip=1 preinstall=pass canonicalAssetCopy=5 additiveMemoryAssets=2 checksumGuard=pass tamperDetected=pass noEnoent=1 packageRegistration=kt+java");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
