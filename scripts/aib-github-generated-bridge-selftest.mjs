#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const callbacks = {};
const pluginMocks = {
  withDangerousMod(config, [_platform, action]) { callbacks.dangerous = action; return config; },
  withMainApplication(config, action) { callbacks.mainApplication = action; return config; },
  withAndroidManifest(config, action) { callbacks.manifest = action; return config; },
};

let plugin;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "@expo/config-plugins") return pluginMocks;
    return originalLoad.call(this, request, parent, isMain);
  };
  plugin = require(path.join(root, "plugins/withGithubTool.js"));
} finally {
  Module._load = originalLoad;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-github-plugin-generation-"));
try {
  const projectRoot = path.join(temp, "project");
  const androidRoot = path.join(temp, "generated-android");
  fs.mkdirSync(path.join(projectRoot, "assets"), { recursive: true });
  fs.cpSync(path.join(root, "assets/github-tool"), path.join(projectRoot, "assets/github-tool"), { recursive: true });

  const config = {
    android: { package: "com.karat.aibuilder" },
    modRequest: { projectRoot, platformProjectRoot: androidRoot },
  };
  plugin(config);
  assert.equal(typeof callbacks.dangerous, "function", "withGithubTool must register its native source generator");
  await callbacks.dangerous(config);

  const generatedPath = path.join(androidRoot, "app/src/main/java/com/karat/aibuilder/GithubToolNative.kt");
  assert.ok(fs.existsSync(generatedPath), "plugin must emit the Kotlin source at the package-derived Android path");
  const generated = fs.readFileSync(generatedPath, "utf8");
  assert.match(generated, /override fun getName\(\)\s*=\s*"AibGithubTool"/, "generated Kotlin module name must match NativeModules.AibGithubTool in the production screen");
  assert.match(generated, /ReactMethod fun httpRequest\(payload: String, promise:/, "generated Kotlin module must expose the actual production HTTP bridge method");
  assert.match(generated, /s != "file" \|\| !u\.authority\.isNullOrEmpty\(\) \|\| !u\.query\.isNullOrEmpty\(\) \|\| !u\.fragment\.isNullOrEmpty\(\)/, "legacy activity accepts only local file URIs without authority, query or fragment");
  assert.ok(generated.includes(String.raw`Regex("^/android_asset/github-tool/[A-Za-z0-9_.-]+\\.html$").matches(p)`), "legacy activity limits file access to the packaged GitHub asset subtree with a valid Kotlin string escape");
  assert.doesNotMatch(generated, /p\.contains\("github-tool"\)|s\.isEmpty\(\) && p\.endsWith\("\.html"\)/, "arbitrary local file and scheme-less HTML paths are not trusted");
  assert.match(generated, /val committed = prefs\.edit\(\)\.putString\(name, Base64\.encodeToString\(packed, Base64\.NO_WRAP\)\)\.commit\(\)/, "generated native vault must commit the encrypted credential before acknowledging it");
  assert.match(generated, /previous = prefs\.getString\(name, null\)/, "generated native vault snapshots the prior encrypted value before replacement");
  assert.match(generated, /if \(!committed\)[\s\S]*?lastSecretSetStage = "commit_failed"[\s\S]*?phase = "readback"[\s\S]*?readSecret\(name\)[\s\S]*?if \(readBack\.stage == "ok" && readBack\.value == value\)[\s\S]*?lastSecretSetStage = "verified"/, "generated native vault distinguishes commit failure from exact decrypt read-back before success");
  assert.match(generated, /ReactMethod fun secretSetLastStage\(promise: .*Promise\)/, "the generated module exposes only the fixed last secret stage for diagnostics");
  assert.match(generated, /ReactMethod fun secretSetResult\(name: String, value: String, promise:[\s\S]*?putBoolean\("saved", saved\)[\s\S]*?putString\("stage", stage\)/, "the new host contract returns success and its exact fixed stage atomically");
  assert.match(generated, /val secretVaultLock = Any\(\)[\s\S]*?synchronized\(GithubToolHost\.secretVaultLock\)/, "all vault mutations and readback are serialized across bridge instances");
  assert.match(generated, /data class SecretReadResult\(val value: String\?, val stage: String, val permanentlyUnreadable: Boolean = false\)/, "native reads distinguish proven-unreadable ciphertext from transient/provider errors");
  assert.match(generated, /result\.value == null && result\.permanentlyUnreadable[\s\S]*?prefs\.edit\(\)\.remove\(name\)\.commit\(\)/, "only a proven-unreadable individual secret is removed on read");
  assert.ok(generated.includes("if (reads.any { (_, result) -> result.value != null || !result.permanentlyUnreadable }) return false"), "a readable or transiently failing entry prevents vault reset");
  assert.ok(generated.includes("existing.forEach { clear.remove(it) }"), "only existing entries in an entirely unreadable vault are cleared");
  assert.ok(generated.includes("if (!clear.commit() || existing.any { prefs.contains(it) }) return false"), "clearing unreadable ciphertext is committed and verified before key reset");
  assert.ok(generated.includes("!ks.containsAlias(alias) && names.none { prefs.contains(it) }"), "vault reset verifies that both the alias and stale encrypted preferences are gone");
  assert.match(generated, /exceptionType == "ProviderException" -> "provider_error"[\s\S]*?permanentlyUnreadable/, "provider failures receive bounded retry but are not themselves treated as proof that stored secrets are unreadable");
  assert.match(generated, /secretSetWithStage\(name: String, value: String\): Pair<Boolean, String>/, "secure write status is captured while holding the vault lock");
  assert.match(generated, /"readback_decrypt_error"[\s\S]*?"readback_mismatch"/, "read-back failures are categorized without exception strings or secret data");
  assert.match(generated, /private fun restoreSecret\(name: String, previous: String\?\): Boolean[\s\S]*?val committed = rollback\.commit\(\)[\s\S]*?committed && prefs\.getString\(name, null\) == previous/, "rollback commits and verifies the exact prior encrypted preference value");
  assert.match(generated, /if \(!restoreSecret\(name, previous\)\) lastSecretSetStage = "rollback_failed"/, "an unverified rollback is surfaced as a fixed failure stage");
  assert.match(generated, /fun httpRequest\(payload: String, promise: .*Promise\)/);
  assert.match(generated, /optInt\("timeoutMs", 15000\)\.coerceIn\(1000,/);
  assert.match(generated, /c\.connectTimeout = minOf\(remainingMs, 10000\)/);
  assert.match(generated, /c\.readTimeout = remainingMs/);
  assert.match(generated, /val sameOrigin = currentUrl\.protocol\.equals\(url\.protocol, ignoreCase = true\)[\s\S]*?if \(h != null && sameOrigin\)/, "caller-supplied credentials/headers must never be replayed cross-origin");
  assert.match(generated, /val initialUrl = URL\(apiUrl\)[\s\S]*?initialUrl\.host\.equals\("api\.github\.com"/);
  assert.match(generated, /val redirectHosts = setOf\([\s\S]*?"release-assets\.githubusercontent\.com"[\s\S]*?val redirectAllowed = nextHost in redirectHosts \|\| nextHost\.endsWith\("\.githubusercontent\.com"\)/, "release downloads must not follow arbitrary HTTPS redirects");
  assert.match(generated, /withAuth = withAuth && nextHost == "api\.github\.com"[\s\S]*?nextUrl\.defaultPort\) == 443/, "auth cannot be re-enabled after leaving the initial API origin");
  assert.match(generated, /ambientCredential = lower == "proxy-authorization" \|\| lower == "cookie"[\s\S]*?if \(ambientCredential \|\| \(lower == "authorization" && \(!initialApiOrigin \|\| !apiOrigin\)\)\) continue/, "caller-supplied cookies/proxy auth are always stripped and Authorization is API-origin-only");
  assert.match(generated, /nextUrl\.userInfo != null \|\| \(nextUrl\.port >= 0 && nextUrl\.port != 443\)/, "redirects reject userinfo and nonstandard HTTPS ports");
  assert.match(generated, /control\.connection = c/);
  assert.match(generated, /control\.phase = phase/);
  assert.match(generated, /githubHttpTimeouts\.schedule\(/);
  assert.match(generated, /control\.cancel\(\)/);
  assert.match(generated, /UnknownHostException/);
  assert.match(generated, /put\("phase", control\.phase\)/);
  assert.match(generated, /SocketTimeoutException/);
  assert.match(generated, /java\.io\.InterruptedIOException/, "generated Kotlin must reference InterruptedIOException from java.io");
  assert.doesNotMatch(generated, /java\.net\.InterruptedIOException/, "generated Kotlin must not reference the nonexistent java.net type");
  assert.match(generated, /put\("status", status\)/);
  assert.match(generated, /put\("statusText", if \(timedOut\) "timeout:\$failurePhase"/);
  assert.match(generated, /put\("error", if \(timedOut\) "timeout:\$failurePhase"/);
  assert.ok(generated.includes('put("phase", control.phase); put("error", "timeout:${control.phase}")'), "outer deadline retains the native phase in its timeout result");
  assert.match(generated, /if \(settled\.compareAndSet\(false, true\)\) promise\.resolve\(result\)/);
  assert.match(generated, /httpRequest\(payload, control\)/);

  const runtimeBridge = fs.readFileSync(path.join(root, "app/github.tsx"), "utf8");
  const hostRouter = fs.readFileSync(path.join(root, "lib/github-tool-bridge-host.ts"), "utf8");
  const sharedClient = fs.readFileSync(path.join(root, "assets/github-tool/js/common.js"), "utf8");
  assert.match(runtimeBridge, /routeGithubToolMessage\(event,\s*\{/s, "WebView onMessage must delegate to the production native bridge router");
  assert.match(hostRouter, /if \(mod\?\.httpRequest\)[\s\S]*?await mod\.httpRequest\(JSON\.stringify\(p\)\)/);
  assert.match(hostRouter, /timeoutMs\?: number/);
  assert.match(sharedClient, /timeoutMs:\s*timeoutMs\s*\|\|\s*15000/);
  assert.match(sharedClient, /phaseLabels/);

  const appFixtures = [
    { name: "kt-apply-whitespace", language: "kt", contents: "class MainApplication {\n  override fun getPackages(): List<ReactPackage> =\n    PackageList(this)\n      .packages\n      .apply {\n        add(CustomPackage())\n      }\n}" },
    { name: "kt-mutable-list", language: "kt", contents: "override fun getPackages(): List<ReactPackage> {\n  val packages = PackageList(this).packages.toMutableList()\n  return packages\n}" },
    { name: "kt-immutable-list", language: "kt", contents: "override fun getPackages(): List<ReactPackage> {\n  val packages = PackageList(this).packages\n  return packages\n}" },
    { name: "kt-direct-return", language: "kt", contents: "override fun getPackages(): List<ReactPackage> {\n  return PackageList(this).packages\n}" },
    { name: "kt-comment-is-not-registration", language: "kt", contents: "// add(GithubToolPackage())\noverride fun getPackages(): List<ReactPackage> = PackageList(this).packages.apply { }" },
    { name: "java-assignment-whitespace", language: "java", contents: "List< ReactPackage > packages = new PackageList ( this ).getPackages ( );\nreturn packages;" },
    { name: "java-direct-return", language: "java", contents: "return new PackageList(this).getPackages();" },
  ];
  for (const fixture of appFixtures) {
    const modConfig = { modResults: { language: fixture.language, contents: fixture.contents } };
    callbacks.mainApplication(modConfig);
    const output = modConfig.modResults.contents;
    const uncommented = output.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/(\s)\/\/.*$/gm, "$1");
    assert.equal((uncommented.match(/\badd\s*\(\s*(?:new\s+)?GithubToolPackage\s*\(\s*\)\s*\)/g) || []).length, 1, `${fixture.name} registers the native package exactly once`);
    if (fixture.name === "kt-mutable-list" || fixture.name === "kt-immutable-list" || fixture.name === "kt-direct-return") {
      assert.ok(output.includes("PackageList(this).packages.toMutableList()"), `${fixture.name} uses a mutable package collection before adding`);
    }
    const repeated = { modResults: { language: fixture.language, contents: output } };
    callbacks.mainApplication(repeated);
    assert.equal(repeated.modResults.contents, output, `${fixture.name} registration is idempotent`);
  }
  const unsupported = { modResults: { language: "kt", contents: "class MainApplication {}" } };
  assert.throws(() => callbacks.mainApplication(unsupported), /Не удалось зарегистрировать GithubToolPackage/, "unknown template fails closed instead of silently omitting the native module");

  console.log(`PASS: Expo GitHub plugin generated bounded Kotlin bridge and registered GithubToolPackage in ${appFixtures.length} Kotlin/Java MainApplication fixtures with idempotent/fail-closed behavior`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
